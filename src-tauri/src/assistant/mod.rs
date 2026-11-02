//! The `assistant` area: answers a message about the open world with a reply streamed from the
//! saved text provider, with the active page as context, and keeps each world session's
//! conversations.
//!
//! One answer runs at a time. Its entry in `AssistantState` holds its stop mark, the abort of its
//! request and the text received so far, so stopping it never loses that text. It goes through
//! five steps: (1) the entry, the checks and the user message; (2) the context and the request;
//! (3) the key; (4) the start, inside `SettingsState::start_request`, which only spawns the request
//! while the provider generation is unchanged, AI is on, the world session is still open and no
//! stop was asked for; (5) the end, saved in the store of the session the message was sent in.
//!
//! Lock order: settings, then world, then the assistant lock, then a store's lock. The assistant
//! lock is held only briefly and never while calling into settings or reading a file; calls into
//! settings, key reads and page reads run on the blocking pool. No lock is held across an `.await`.

mod context;
mod request;
mod store;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorKind, guard};
use crate::providers::{self, ChatMessage, ProviderFailure, StreamEnd};
use crate::settings::{self, Abort, PreparedRequest, RequestGuard, SettingsState};
use crate::world::{self, WorldState};
use request::Request;
use store::{Answer, AnswerState, Store};

/// A page that an answer's request carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ContextPage {
    path: String,
    /// Only the beginning of the page was sent.
    partial: bool,
}

/// What `assistant_send` sends on its channel while an answer runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AnswerEvent {
    /// The request is leaving with these pages, in the order chosen, and without `leftOut` earlier
    /// messages of the conversation. Sent once, only when the request starts.
    Context {
        conversation: i64,
        pages: Vec<ContextPage>,
        left_out: u32,
    },
    /// The next piece of the answer's text.
    Text { delta: String },
}

/// How an answer ended. Each carries the conversation, which is new when the message started one,
/// and the answer's final text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AnswerEnd {
    Complete {
        conversation: i64,
        text: String,
    },
    /// Stop, AI switched off, the provider saved again or its key removed, before the request left
    /// (with no text) or while it ran.
    Stopped {
        conversation: i64,
        text: String,
    },
    /// The answer's text reached the core's bound.
    CutOff {
        conversation: i64,
        text: String,
    },
    /// The request failed for `reason`; text that arrived before is saved as stopped.
    Failed {
        conversation: i64,
        text: String,
        reason: ProviderFailure,
        detail: Option<String>,
        provider_message: Option<String>,
    },
}

/// The running answer and the current session's conversations, managed by Tauri.
#[derive(Default)]
pub struct AssistantState {
    inner: Mutex<Inner>,
    /// Notified when a running answer has ended and been saved.
    ended: Condvar,
    /// Called at a step of `send`, so the tests can act between two steps.
    #[cfg(test)]
    hook: Mutex<Option<(Step, Hook)>>,
}

#[cfg(test)]
type Hook = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Inner {
    /// The conversations of the latest world session that sent a message, by session.
    store: Option<(u64, SharedStore)>,
    running: Option<Running>,
    next_run: u64,
}

type SharedStore = Arc<Mutex<Store>>;

struct Running {
    id: u64,
    /// Asked to stop: a request not started yet never starts.
    stop: bool,
    /// Aborts the request once it has started. It takes no lock.
    abort: Option<Abort>,
    /// The text received so far, outside the request's task, so that aborting it keeps the text.
    text: String,
    /// The store of the session the message was sent in, where the answer is saved even when a
    /// later session's store has replaced it in `Inner::store`.
    store: Option<SharedStore>,
}

/// The managed states an answer needs: the application's in the commands, the tests' own.
pub(crate) trait Services: Clone + Send + Sync + 'static {
    fn settings(&self) -> &SettingsState;
    fn world(&self) -> &WorldState;
    fn assistant(&self) -> &AssistantState;
}

impl Services for AppHandle {
    fn settings(&self) -> &SettingsState {
        self.state::<SettingsState>().inner()
    }

    fn world(&self) -> &WorldState {
        self.state::<WorldState>().inner()
    }

    fn assistant(&self) -> &AssistantState {
        self.state::<AssistantState>().inner()
    }
}

/// A message to answer, as the interface sends it.
pub(crate) struct Outgoing {
    /// `None` starts a new conversation.
    conversation: Option<i64>,
    text: String,
    /// The active page's path, if a page tab is active.
    active: Option<String>,
    /// Answer the conversation's last message again, instead of adding `text`.
    retry: bool,
}

/// Ends the running answer when dropped, however `send` ends: it clears the entry and wakes
/// `assistant_stop`. It takes the assistant lock, so it is never dropped while that is held.
struct RunGuard<S: Services> {
    services: S,
    id: u64,
}

impl<S: Services> Drop for RunGuard<S> {
    fn drop(&mut self) {
        self.services.assistant().end_run(self.id);
    }
}

/// What the first step settled.
struct Begun<S: Services> {
    run: RunGuard<S>,
    session: u64,
    world_name: String,
    conversation: i64,
    request: PreparedRequest,
    active: Option<String>,
    /// The message to answer: the new one, or the one retried.
    text: String,
    earlier: Vec<store::Message>,
}

/// A request that started.
struct Started {
    task: JoinHandle<StreamEnd>,
    /// Keeps the request's abort in settings; dropped on the blocking pool once it has ended.
    guard: RequestGuard,
    pages: Vec<ContextPage>,
    left_out: u32,
}

impl AssistantState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every change to the state is a whole value, so it stays consistent after a panic.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Creates the running answer's entry, unless one runs.
    fn enter<S: Services>(&self, services: &S) -> Result<RunGuard<S>, AppError> {
        let id = {
            let mut inner = self.lock();
            if inner.running.is_some() {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "An answer is already running.",
                ));
            }
            let id = inner.next_run;
            inner.next_run += 1;
            inner.running = Some(Running {
                id,
                stop: false,
                abort: None,
                text: String::new(),
                store: None,
            });
            id
        };
        Ok(RunGuard {
            services: services.clone(),
            id,
        })
    }

    fn end_run(&self, run: u64) {
        let mut inner = self.lock();
        if inner
            .running
            .as_ref()
            .is_some_and(|running| running.id == run)
        {
            inner.running = None;
        }
        self.ended.notify_all();
    }

    /// Takes the store of `session`, a new one when the session changed, into the running entry,
    /// and records the message to answer. Returns the conversation, the message's text and the
    /// conversation's earlier messages.
    fn record(
        &self,
        run: u64,
        session: u64,
        outgoing: Outgoing,
    ) -> Result<(i64, String, Vec<store::Message>), AppError> {
        let mut inner = self.lock();
        let shared = match &inner.store {
            Some((current, store)) if *current == session => Arc::clone(store),
            _ => {
                let store = Arc::new(Mutex::new(Store::in_memory()?));
                inner.store = Some((session, Arc::clone(&store)));
                store
            }
        };
        if let Some(running) = running(&mut inner, run) {
            running.store = Some(Arc::clone(&shared));
        }
        let mut store = lock_store(&shared);
        let (conversation, text) = match (outgoing.retry, outgoing.conversation) {
            (true, Some(conversation)) => (conversation, store.prepare_retry(conversation)?),
            (true, None) => {
                return Err(AppError::new(
                    ErrorKind::NotFound,
                    "There is no message to answer again.",
                ));
            }
            (false, _) if outgoing.text.trim().is_empty() => {
                return Err(AppError::new(
                    ErrorKind::InvalidName,
                    "The message is empty.",
                ));
            }
            (false, conversation) => {
                let conversation = store.add_user_message(conversation, &outgoing.text, now())?;
                (conversation, outgoing.text)
            }
        };
        let mut earlier = store.messages(conversation)?;
        // The last one is the message being answered.
        earlier.pop();
        Ok((conversation, text, earlier))
    }

    /// Adds `delta` to the running answer's text.
    fn received(&self, run: u64, delta: &str) {
        if let Some(running) = running(&mut self.lock(), run) {
            running.text.push_str(delta);
        }
    }

    /// Saves how the request of the running answer `run` ended, in its session's store, and
    /// returns its end.
    fn finish(
        &self,
        run: u64,
        conversation: i64,
        outcome: tauri::Result<StreamEnd>,
        pages: &[ContextPage],
        left_out: u32,
    ) -> Result<AnswerEnd, AppError> {
        let mut inner = self.lock();
        let running = running(&mut inner, run).ok_or_else(internal)?;
        let text = std::mem::take(&mut running.text);
        let (state, end) = match outcome {
            Ok(StreamEnd::Complete) => (
                Some(AnswerState::Complete),
                AnswerEnd::Complete { conversation, text },
            ),
            Ok(StreamEnd::CutOff) => (
                Some(AnswerState::CutOff),
                AnswerEnd::CutOff { conversation, text },
            ),
            Ok(StreamEnd::Failed {
                reason,
                detail,
                provider_message,
            }) => (
                (!text.is_empty()).then_some(AnswerState::Stopped),
                AnswerEnd::Failed {
                    conversation,
                    text,
                    reason,
                    detail,
                    provider_message,
                },
            ),
            // The request was aborted: by Stop, AI switched off, or the provider saved again or
            // its key removed.
            Err(_) => (
                Some(AnswerState::Stopped),
                AnswerEnd::Stopped { conversation, text },
            ),
        };
        if let (Some(state), Some(store)) = (state, &running.store) {
            let pages: Vec<(String, bool)> = pages
                .iter()
                .map(|page| (page.path.clone(), page.partial))
                .collect();
            let answer = Answer {
                state,
                text: end.text(),
                pages: &pages,
                left_out,
            };
            lock_store(store).add_answer(conversation, &answer, now())?;
        }
        Ok(end)
    }

    /// Asks the running answer, if any, to stop, aborts its request, and waits until it has ended
    /// and been saved.
    fn stop_and_wait(&self) {
        let mut inner = self.lock();
        let Some(running) = inner.running.as_mut() else {
            return;
        };
        let run = running.id;
        running.stop = true;
        if let Some(abort) = &running.abort {
            abort();
        }
        while inner
            .running
            .as_ref()
            .is_some_and(|running| running.id == run)
        {
            inner = self
                .ended
                .wait(inner)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    #[cfg(test)]
    fn pause(&self, step: Step) {
        let hook = self.hook.lock().unwrap().clone();
        if let Some((at, hook)) = hook
            && at == step
        {
            hook();
        }
    }
}

impl AnswerEnd {
    fn text(&self) -> &str {
        match self {
            Self::Complete { text, .. }
            | Self::Stopped { text, .. }
            | Self::CutOff { text, .. }
            | Self::Failed { text, .. } => text,
        }
    }
}

fn running(inner: &mut Inner, run: u64) -> Option<&mut Running> {
    inner.running.as_mut().filter(|running| running.id == run)
}

/// A store's own state is kept consistent by its transactions.
fn lock_store(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The steps of `send` at which the tests can act.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// The running entry exists; AI, the world and the provider are not checked yet.
    Entered,
    /// The key was read; the request has not started.
    KeyRead,
}

/// Answers `outgoing`, streaming its text to `on_event`. Every way the answer ends after the user
/// message is saved returns an `AnswerEnd`.
pub(crate) async fn send<S: Services>(
    services: S,
    outgoing: Outgoing,
    on_event: Channel<AnswerEvent>,
    read_timeout: Duration,
) -> Result<AnswerEnd, AppError> {
    let Begun {
        run,
        session,
        world_name,
        conversation,
        request: prepared,
        active,
        text,
        earlier,
    } = blocking(&services, move |services| begin(services, outgoing)).await?;
    let request = blocking(&services, move |services| {
        let pages = context::choose(services.world(), session, active.as_deref());
        Ok(request::build(&world_name, &pages, &earlier, &text))
    })
    .await?;
    let read = prepared.clone();
    let key = match blocking(&services, move |services| {
        Ok(services.settings().read_key(&read))
    })
    .await?
    {
        Ok(key) => key,
        Err(error) => {
            return Ok(AnswerEnd::Failed {
                conversation,
                text: String::new(),
                reason: ProviderFailure::KeyUnreadable,
                detail: Some(error.message),
                provider_message: None,
            });
        }
    };
    #[cfg(test)]
    blocking(&services, |services| {
        services.assistant().pause(Step::KeyRead);
        Ok(())
    })
    .await?;
    let run_id = run.id;
    let started = blocking(&services, move |services| {
        let start = Start {
            run: run_id,
            session,
            conversation,
            read_timeout,
            on_event,
        };
        Ok(start.request(services, &prepared, request, key))
    })
    .await?;
    let Some(Started {
        task,
        guard,
        pages,
        left_out,
    }) = started
    else {
        return Ok(AnswerEnd::Stopped {
            conversation,
            text: String::new(),
        });
    };
    let outcome = task.await;
    let end = blocking(&services, move |services| {
        drop(guard);
        services
            .assistant()
            .finish(run_id, conversation, outcome, &pages, left_out)
    })
    .await;
    drop(run);
    end
}

/// The first step: the running entry, the checks, and the user message.
fn begin<S: Services>(services: &S, outgoing: Outgoing) -> Result<Begun<S>, AppError> {
    let run = services.assistant().enter(services)?;
    #[cfg(test)]
    services.assistant().pause(Step::Entered);
    if !services.settings().ai_on() {
        return Err(settings::ai_off());
    }
    let world = services.world().current()?;
    if let Some(active) = &outgoing.active {
        world::check_page_path(&world.root, active)?;
    }
    let request = services.settings().prepare_request()?;
    let active = outgoing.active.clone();
    let (conversation, text, earlier) =
        services
            .assistant()
            .record(run.id, world.session, outgoing)?;
    Ok(Begun {
        run,
        session: world.session,
        world_name: world.name(),
        conversation,
        request,
        active,
        text,
        earlier,
    })
}

/// The fourth step's inputs.
struct Start {
    run: u64,
    session: u64,
    conversation: i64,
    read_timeout: Duration,
    on_event: Channel<AnswerEvent>,
}

impl Start {
    /// Spawns the request inside `start_request`: under the settings lock, while the provider
    /// generation is unchanged and AI is on; then under the world lock, while the session is still
    /// open; then under the assistant lock, unless a stop was asked for. The context event goes out
    /// and the abort is stored before any of these locks is released. `None` when nothing started.
    fn request<S: Services>(
        self,
        services: &S,
        prepared: &PreparedRequest,
        request: Request,
        key: Option<String>,
    ) -> Option<Started> {
        let Request {
            messages,
            pages,
            left_out,
        } = request;
        let mut task = None;
        let started = services.settings().start_request(prepared, || {
            services
                .world()
                .while_open(self.session, |_| {
                    let mut inner = services.assistant().lock();
                    let running = running(&mut inner, self.run).filter(|running| !running.stop)?;
                    let _ = self.on_event.send(AnswerEvent::Context {
                        conversation: self.conversation,
                        pages: pages.clone(),
                        left_out,
                    });
                    let spawned = tauri::async_runtime::spawn(stream(
                        services.clone(),
                        self.run,
                        prepared.clone(),
                        key,
                        messages,
                        self.read_timeout,
                        self.on_event.clone(),
                    ));
                    let abort = spawned.inner().abort_handle();
                    let own = abort.clone();
                    running.abort = Some(Box::new(move || own.abort()));
                    task = Some(spawned);
                    Some(Box::new(move || abort.abort()) as Abort)
                })
                .flatten()
        });
        match (started, task) {
            (Ok(Some(guard)), Some(task)) => Some(Started {
                task,
                guard,
                pages,
                left_out,
            }),
            _ => None,
        }
    }
}

/// The request's task: streams the answer, keeping its text in the running entry.
async fn stream<S: Services>(
    services: S,
    run: u64,
    prepared: PreparedRequest,
    key: Option<String>,
    messages: Vec<ChatMessage>,
    read_timeout: Duration,
    on_event: Channel<AnswerEvent>,
) -> StreamEnd {
    providers::chat_stream(
        prepared.base_url(),
        prepared.model(),
        key.as_deref(),
        &messages,
        read_timeout,
        |delta| {
            services.assistant().received(run, delta);
            // A webview that cannot take the event changes nothing in the core.
            let _ = on_event.send(AnswerEvent::Text {
                delta: delta.to_owned(),
            });
        },
    )
    .await
}

/// Refuses while AI is off; otherwise stops the running answer, if any, and returns once it has
/// been saved.
pub(crate) async fn stop<S: Services>(services: S) -> Result<(), AppError> {
    blocking(&services, |services| {
        if !services.settings().ai_on() {
            return Err(settings::ai_off());
        }
        services.assistant().stop_and_wait();
        Ok(())
    })
    .await
}

/// Runs `work` on Tauri's blocking pool, inside `guard`.
async fn blocking<S: Services, T: Send + 'static>(
    services: &S,
    work: impl FnOnce(&S) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let services = services.clone();
    tauri::async_runtime::spawn_blocking(move || guard(|| work(&services)))
        .await
        .unwrap_or_else(|_| Err(internal()))
}

fn internal() -> AppError {
    AppError::new(
        ErrorKind::Internal,
        "An unexpected internal error occurred.",
    )
}

/// The time in seconds since the Unix epoch.
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// Answers a message about the open world with the active page as context, streaming the answer's
/// events to `on_event`.
#[tauri::command]
pub async fn assistant_send(
    app: AppHandle,
    conversation: Option<i64>,
    text: String,
    active: Option<String>,
    retry: bool,
    on_event: Channel<AnswerEvent>,
) -> Result<AnswerEnd, AppError> {
    let outgoing = Outgoing {
        conversation,
        text,
        active,
        retry,
    };
    send(app, outgoing, on_event, providers::READ_TIMEOUT).await
}

/// Stops the running answer, if any, and returns once its text has been saved.
#[tauri::command]
pub async fn assistant_stop(app: AppHandle) -> Result<(), AppError> {
    stop(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::{Server, answer, stream_head};
    use crate::secrets::test_support::{KEY, MockKeychain};
    use serde_json::{Value, json};
    use std::fs;
    use std::thread;
    use std::time::Instant;
    use tauri::async_runtime::block_on;
    use tauri::ipc::InvokeResponseBody;
    use tempfile::TempDir;

    const MODEL: &str = "test/model";
    const WAIT: Duration = Duration::from_secs(10);
    const PAGE: &str = "Places/Saltmere.md";

    struct States {
        settings: SettingsState,
        world: WorldState,
        assistant: AssistantState,
    }

    #[derive(Clone)]
    struct TestServices(Arc<States>);

    impl Services for TestServices {
        fn settings(&self) -> &SettingsState {
            &self.0.settings
        }

        fn world(&self) -> &WorldState {
            &self.0.world
        }

        fn assistant(&self) -> &AssistantState {
            &self.0.assistant
        }
    }

    type Events = Arc<Mutex<Vec<Value>>>;

    /// A temporary world with one page, open, and settings whose provider is `server`.
    struct Fixture {
        services: TestServices,
        keychain: MockKeychain,
        server: Server,
        world: TempDir,
        _data: TempDir,
    }

    impl Fixture {
        fn new(server: Server) -> Self {
            let fixture = Self::without_provider(server);
            fixture.save_provider();
            fixture
        }

        fn without_provider(server: Server) -> Self {
            let data = tempfile::tempdir().unwrap();
            let keychain = MockKeychain::new();
            let settings =
                SettingsState::with_secrets(Some(data.path()), keychain.secrets(Some(data.path())));
            let world = tempfile::tempdir().unwrap();
            fs::create_dir(world.path().join("Places")).unwrap();
            fs::write(world.path().join(PAGE), "# Saltmere\nA port town.\n").unwrap();
            let states = States {
                settings,
                world: WorldState::default(),
                assistant: AssistantState::default(),
            };
            states.world.open(world.path().to_path_buf()).unwrap();
            Self {
                services: TestServices(Arc::new(states)),
                keychain,
                server,
                world,
                _data: data,
            }
        }

        fn save_provider(&self) {
            let base_url = self.server.base_url("/v1");
            self.settings()
                .save_provider(base_url.as_str(), MODEL, Some(KEY), false)
                .unwrap();
        }

        fn settings(&self) -> &SettingsState {
            self.services.settings()
        }

        fn assistant(&self) -> &AssistantState {
            self.services.assistant()
        }

        fn reopen_world(&self) {
            self.services
                .world()
                .open(self.world.path().to_path_buf())
                .unwrap();
        }

        /// Sends on this thread and returns the end and the channel's events.
        fn send(
            &self,
            conversation: Option<i64>,
            text: &str,
            active: Option<&str>,
        ) -> (Result<AnswerEnd, AppError>, Vec<Value>) {
            let (handle, events) = self.start(conversation, text, active, false);
            let end = handle.join().unwrap();
            let events = events.lock().unwrap().clone();
            (end, events)
        }

        fn retry(&self, conversation: i64) -> Result<AnswerEnd, AppError> {
            self.start(Some(conversation), "", None, true)
                .0
                .join()
                .unwrap()
        }

        /// Sends on another thread.
        fn start(
            &self,
            conversation: Option<i64>,
            text: &str,
            active: Option<&str>,
            retry: bool,
        ) -> (thread::JoinHandle<Result<AnswerEnd, AppError>>, Events) {
            let events = Events::default();
            let sink = Arc::clone(&events);
            let channel = Channel::new(move |body| {
                let InvokeResponseBody::Json(json) = body else {
                    panic!("expected JSON");
                };
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
                Ok(())
            });
            let outgoing = Outgoing {
                conversation,
                text: text.to_owned(),
                active: active.map(str::to_owned),
                retry,
            };
            let services = self.services.clone();
            let handle = thread::spawn(move || block_on(send(services, outgoing, channel, WAIT)));
            (handle, events)
        }

        fn stop(&self) -> Result<(), AppError> {
            block_on(stop(self.services.clone()))
        }

        /// Calls `hook` when `send` reaches `step`.
        fn at(&self, step: Step, hook: impl Fn() + Send + Sync + 'static) {
            *self.assistant().hook.lock().unwrap() = Some((step, Arc::new(hook)));
        }

        /// The current session's conversation.
        fn stored(&self, conversation: i64) -> Vec<store::Message> {
            let store = self.assistant().lock().store.clone().unwrap().1;
            lock_store(&store).messages(conversation).unwrap()
        }

        fn running(&self) -> bool {
            self.assistant().lock().running.is_some()
        }

        /// The JSON body of each request the server received.
        fn bodies(&self) -> Vec<Value> {
            self.server
                .requests()
                .iter()
                .map(|request| serde_json::from_slice(&request.body).unwrap())
                .collect()
        }
    }

    fn delta(text: &str) -> String {
        let event = json!({ "choices": [{ "delta": { "content": text } }] });
        format!("data: {event}\n\n")
    }

    /// A provider that streams `text` and finishes.
    fn answering(text: &str) -> Server {
        let body = format!("{}data: [DONE]\n\n", delta(text));
        Server::answering(answer(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            body.as_bytes(),
        ))
    }

    /// A provider that streams `text` and then holds the connection open.
    fn stalling(text: &str) -> Server {
        Server::streaming(vec![stream_head(), delta(text).into_bytes()], true)
    }

    fn wait_until(what: &str, condition: impl Fn() -> bool) {
        let start = Instant::now();
        while !condition() {
            assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn user(text: &str) -> store::Message {
        store::Message {
            text: text.to_owned(),
            answer: None,
        }
    }

    fn answered(state: AnswerState, text: &str) -> store::Message {
        store::Message {
            text: text.to_owned(),
            answer: Some(state),
        }
    }

    fn conversation_of(end: &AnswerEnd) -> i64 {
        match end {
            AnswerEnd::Complete { conversation, .. }
            | AnswerEnd::Stopped { conversation, .. }
            | AnswerEnd::CutOff { conversation, .. }
            | AnswerEnd::Failed { conversation, .. } => *conversation,
        }
    }

    fn kind(result: Result<AnswerEnd, AppError>) -> ErrorKind {
        result.unwrap_err().kind
    }

    #[test]
    fn a_send_is_refused_before_anything_is_saved_or_sent() {
        let fixture = Fixture::new(answering("Hi"));
        let send = |text: &str, active: Option<&str>| fixture.send(None, text, active).0;

        assert_eq!(kind(send(" \n ", None)), ErrorKind::InvalidName);
        assert_eq!(
            kind(send("Hi", Some("../outside.md"))),
            ErrorKind::InvalidPath
        );
        assert_eq!(
            kind(send("Hi", Some(".hidden/a.md"))),
            ErrorKind::InvalidPath
        );
        // No conversation was started.
        assert_eq!(kind(fixture.retry(1)), ErrorKind::NotFound);
        fixture.settings().set_ai(false).unwrap();
        assert_eq!(kind(send("Hi", None)), ErrorKind::AiOff);
        assert_eq!(fixture.stop().unwrap_err().kind, ErrorKind::AiOff);
        fixture.settings().set_ai(true).unwrap();
        fixture.services.world().close();
        assert_eq!(kind(send("Hi", None)), ErrorKind::NoWorld);

        assert!(fixture.server.requests().is_empty());
        assert!(!fixture.running());
    }

    #[test]
    fn a_refusal_after_the_entry_exists_leaves_no_answer_running() {
        let fixture = Fixture::without_provider(answering("Hi"));

        let (refused, _) = fixture.send(None, "Hello", None);
        assert_eq!(kind(refused), ErrorKind::NotFound);
        assert!(!fixture.running());

        fixture.save_provider();
        let (end, _) = fixture.send(None, "Hello", None);
        assert!(matches!(end, Ok(AnswerEnd::Complete { .. })), "{end:?}");
    }

    #[test]
    fn the_request_carries_the_active_page_cut_and_the_event_lists_exactly_it() {
        let fixture = Fixture::new(answering("A port."));
        let page = format!("# Saltmere\n{}", "ä".repeat(12_100));
        fs::write(fixture.world.path().join(PAGE), &page).unwrap();

        let (end, events) = fixture.send(None, "Where is Saltmere?", Some(PAGE));

        let end = end.unwrap();
        let conversation = conversation_of(&end);
        assert_eq!(
            end,
            AnswerEnd::Complete {
                conversation,
                text: "A port.".to_owned()
            }
        );
        assert_eq!(
            events,
            [
                json!({
                    "kind": "context",
                    "conversation": conversation,
                    "pages": [{ "path": PAGE, "partial": true }],
                    "leftOut": 0,
                }),
                json!({ "kind": "text", "delta": "A port." }),
            ]
        );
        let bodies = fixture.bodies();
        assert_eq!(bodies.len(), 1);
        let messages = bodies[0]["messages"].as_array().unwrap();
        let system = messages[0]["content"].as_str().unwrap();
        let sent: String = page.chars().take(12_000).collect();
        assert!(system.contains(&sent), "the page's first 12,000 characters");
        assert!(!system.contains(&page.chars().take(12_001).collect::<String>()));
        assert!(system.contains(PAGE));
        assert_eq!(
            messages[1],
            json!({ "role": "user", "content": "Where is Saltmere?" })
        );
        assert_eq!(messages.len(), 2);
        assert_eq!(
            fixture.stored(conversation),
            [
                user("Where is Saltmere?"),
                answered(AnswerState::Complete, "A port.")
            ]
        );
        let store = fixture.assistant().lock().store.clone().unwrap().1;
        assert_eq!(
            lock_store(&store).last_answer_pages(conversation),
            [(PAGE.to_owned(), true)]
        );
    }

    #[test]
    fn earlier_messages_go_along_newest_first_within_their_budget_and_the_event_counts_the_rest() {
        let fixture = Fixture::new(answering("OK"));
        let long = |letter: &str| letter.repeat(12_000);
        let (first, _) = fixture.send(None, &long("a"), None);
        let conversation = conversation_of(&first.unwrap());
        for letter in ["b", "c"] {
            fixture
                .send(Some(conversation), &long(letter), None)
                .0
                .unwrap();
        }

        let (_, events) = fixture.send(Some(conversation), "And now?", None);

        // Newest first: OK, c, OK, b, OK fit in 32,000 characters; a does not.
        assert_eq!(events[0]["leftOut"], 1);
        assert_eq!(events[0]["pages"], json!([]));
        let body = fixture.bodies().pop().unwrap();
        let sent: Vec<(String, String)> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .skip(1)
            .map(|message| {
                let content = message["content"].as_str().unwrap();
                let start: String = content.chars().take(2).collect();
                (message["role"].as_str().unwrap().to_owned(), start)
            })
            .collect();
        let expected = [
            ("assistant", "OK"),
            ("user", "bb"),
            ("assistant", "OK"),
            ("user", "cc"),
            ("assistant", "OK"),
            ("user", "An"),
        ];
        assert_eq!(
            sent,
            expected.map(|(role, start)| (role.to_owned(), start.to_owned()))
        );
    }

    #[test]
    fn a_stop_during_the_stream_keeps_the_text_and_returns_once_it_is_saved() {
        let fixture = Fixture::new(stalling("Half an "));
        let (handle, events) = fixture.start(None, "Tell me", Some(PAGE), false);
        wait_until("the text", || events.lock().unwrap().len() == 2);
        let conversation = events.lock().unwrap()[0]["conversation"].as_i64().unwrap();
        assert_eq!(
            kind(fixture.send(None, "Again", None).0),
            ErrorKind::Conflict
        );

        fixture.stop().unwrap();

        // Saved before `stop` returned, while the send may still be returning.
        assert_eq!(
            fixture.stored(conversation),
            [user("Tell me"), answered(AnswerState::Stopped, "Half an ")]
        );
        assert_eq!(
            handle.join().unwrap().unwrap(),
            AnswerEnd::Stopped {
                conversation,
                text: "Half an ".to_owned()
            }
        );
        assert!(!fixture.running());
        assert_eq!(fixture.server.requests().len(), 1);
    }

    #[test]
    fn switching_ai_off_during_the_stream_stops_it() {
        let fixture = Fixture::new(stalling("Some"));
        let (handle, events) = fixture.start(None, "Tell me", None, false);
        wait_until("the text", || events.lock().unwrap().len() == 2);

        fixture.settings().set_ai(false).unwrap();

        let end = handle.join().unwrap().unwrap();
        let conversation = conversation_of(&end);
        assert_eq!(
            end,
            AnswerEnd::Stopped {
                conversation,
                text: "Some".to_owned()
            }
        );
        assert_eq!(
            fixture.stored(conversation),
            [user("Tell me"), answered(AnswerState::Stopped, "Some")]
        );
    }

    /// Stops the answer from another thread, as `assistant_stop` does, and returns once the stop
    /// mark is set; the thread's stop returns once the answer has ended.
    fn stop_from_another_thread(services: &TestServices) -> thread::JoinHandle<()> {
        let stopper = services.clone();
        let handle = thread::spawn(move || block_on(stop(stopper)).unwrap());
        wait_until("the stop mark", || {
            services
                .assistant()
                .lock()
                .running
                .as_ref()
                .is_some_and(|running| running.stop)
        });
        handle
    }

    #[test]
    fn a_stop_ai_off_or_world_change_before_the_request_starts_sends_nothing() {
        let cases = [
            (
                Step::Entered,
                "stop while the send checks AI and the provider",
            ),
            (Step::KeyRead, "stop while the key is read"),
            (Step::KeyRead, "AI off while the key is read"),
            (Step::KeyRead, "world change while the key is read"),
        ];
        for (step, name) in cases {
            let fixture = Arc::new(Fixture::new(answering("Never")));
            let stopper = Arc::new(Mutex::new(None));
            let (hooked, slot) = (Arc::clone(&fixture), Arc::clone(&stopper));
            fixture.at(step, move || match name {
                "AI off while the key is read" => drop(hooked.settings().set_ai(false).unwrap()),
                "world change while the key is read" => hooked.reopen_world(),
                _ => *slot.lock().unwrap() = Some(stop_from_another_thread(&hooked.services)),
            });

            let (end, events) = fixture.send(None, "Hello", Some(PAGE));

            let end = end.unwrap();
            assert_eq!(
                end,
                AnswerEnd::Stopped {
                    conversation: conversation_of(&end),
                    text: String::new()
                },
                "{name}"
            );
            assert!(events.is_empty(), "{name}: {events:?}");
            assert!(fixture.server.requests().is_empty(), "{name}");
            if let Some(stopper) = stopper.lock().unwrap().take() {
                stopper.join().unwrap();
            }
            assert!(!fixture.running(), "{name}");
            *fixture.assistant().hook.lock().unwrap() = None;
        }
    }

    #[test]
    fn a_key_that_cannot_be_read_sends_nothing_and_its_message_can_be_retried() {
        let fixture = Fixture::new(answering("Hi"));
        fixture.keychain.fail_next_call();

        let (end, events) = fixture.send(None, "Hello", Some(PAGE));

        let end = end.unwrap();
        let conversation = conversation_of(&end);
        let AnswerEnd::Failed {
            reason: ProviderFailure::KeyUnreadable,
            detail: Some(detail),
            text,
            ..
        } = &end
        else {
            panic!("expected key_unreadable, got {end:?}");
        };
        assert!(detail.contains("locked or refused"), "{detail}");
        assert!(text.is_empty());
        assert!(events.is_empty());
        assert!(fixture.server.requests().is_empty());
        assert_eq!(fixture.stored(conversation), [user("Hello")]);

        let retried = fixture.retry(conversation).unwrap();

        assert_eq!(
            retried,
            AnswerEnd::Complete {
                conversation,
                text: "Hi".to_owned()
            }
        );
        assert_eq!(fixture.server.requests().len(), 1);
        assert_eq!(
            fixture.stored(conversation),
            [user("Hello"), answered(AnswerState::Complete, "Hi")]
        );
    }

    #[test]
    fn stop_with_nothing_running_returns_at_once() {
        let fixture = Fixture::new(answering("Hi"));

        fixture.stop().unwrap();
    }

    #[test]
    fn an_answer_that_ends_after_a_world_change_is_saved_in_its_own_session_s_store() {
        let fixture = Fixture::new(stalling("Before"));
        let (handle, events) = fixture.start(None, "Hello", None, false);
        wait_until("the text", || events.lock().unwrap().len() == 2);
        let conversation = events.lock().unwrap()[0]["conversation"].as_i64().unwrap();
        let first_store = fixture.assistant().lock().store.clone().unwrap().1;

        fixture.reopen_world();
        fixture.stop().unwrap();

        assert!(matches!(
            handle.join().unwrap(),
            Ok(AnswerEnd::Stopped { .. })
        ));
        assert_eq!(
            lock_store(&first_store).messages(conversation).unwrap(),
            [user("Hello"), answered(AnswerState::Stopped, "Before")]
        );
        // The new session starts with an empty store, which does not know the conversation.
        let (refused, _) = fixture.send(Some(conversation), "Still there?", None);
        assert_eq!(kind(refused), ErrorKind::NotFound);
        assert_eq!(fixture.server.requests().len(), 1);
    }
}
