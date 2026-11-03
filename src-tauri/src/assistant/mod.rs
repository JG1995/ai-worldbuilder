//! The `assistant` area: answers a message about the open world with a reply streamed from the
//! saved text provider, with the pages of the world that matter to it as context, and keeps each
//! world's conversations in its store, which each world session opens anew.
//!
//! One answer runs at a time. Its entry in `AssistantState` holds its stop mark, the abort of its
//! request and the text received so far, so stopping it never loses that text. It goes through
//! five steps: (1) the entry, the checks and the user message; (2) the context and the request;
//! (3) the key; (4) the start, inside `SettingsState::start_request`, which only spawns the request
//! while the provider generation is unchanged, AI is on, the world session is still open and no
//! stop was asked for; (5) the end, saved in the store of the session the message was sent in.
//!
//! An answer streams only its prose; the proposals it holds are read from its whole text when it
//! ends and saved with it. Nothing is written to the world until `assistant_accept`, which writes
//! the proposals through the world's write path as one change, and `assistant_undo`, which undoes
//! that change. Each marks its set of proposals in the store before the first file is written, and
//! a set left unfinished, by this command or by an earlier opening, is resolved from what its pages
//! hold.
//!
//! Lock order: settings, then world, then the assistant lock, then a store's lock. The assistant
//! lock is held only briefly and never while calling into settings or reading a page; calls into
//! settings, key reads and page reads run on the blocking pool, and so does the store's own file,
//! which is opened, read and written under the assistant lock, or under the store's own lock alone
//! when an accept or undo marks its set inside the world lock. No lock is held across an `.await`.

mod context;
mod proposals;
mod request;
mod store;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorKind, guard};
use crate::index::EditorLinks;
use crate::providers::{self, ChatMessage, ProviderFailure, StreamEnd};
use crate::settings::{self, Abort, PreparedRequest, RequestGuard, SettingsState};
use crate::world::{self, BatchWrite, ChangeId, CurrentWorld, DiffLine, WorldState};
use proposals::{Parsed, Piece, ProposalKind, Splitter};
use request::Request;
use store::{
    Answer, AnswerProposals, AnswerState, Conversation, Conversations, HistoryChange,
    ProposalContent, ProposalState, SavedProposal, SetPage, SetState, Store, UnfinishedSet,
};

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
    /// messages of the conversation; `indexing` when the index was still being built as the pages
    /// were chosen. Sent once, only when the request starts.
    Context {
        conversation: i64,
        pages: Vec<ContextPage>,
        left_out: u32,
        indexing: bool,
    },
    /// The next piece of the answer's prose.
    Text { delta: String },
    /// The answer began a proposal of the kind `change` for the page at `path`, as the model gave
    /// it.
    Proposal { change: ProposalKind, path: String },
}

/// How an answer ended. Each carries the conversation, which is new when the message started one,
/// the answer's final prose, and the saved answer's id, or none when no answer was saved.
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
        answer: Option<i64>,
    },
    /// Stop, AI switched off, the provider saved again or its key removed, before the request left
    /// (with no text) or while it ran.
    Stopped {
        conversation: i64,
        text: String,
        answer: Option<i64>,
    },
    /// The answer's text reached the core's bound.
    CutOff {
        conversation: i64,
        text: String,
        answer: Option<i64>,
    },
    /// The request failed for `reason`; text that arrived before is saved as stopped.
    Failed {
        conversation: i64,
        text: String,
        answer: Option<i64>,
        reason: ProviderFailure,
        detail: Option<String>,
        provider_message: Option<String>,
    },
}

/// Whether a pending proposal applies to its page as the page is now.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProposalCheck {
    /// It applies: the lines from the page's text to the result, the version of the page they were
    /// computed from (none for a new page), and whether the page changed since the proposal was
    /// made.
    Applies {
        lines: Vec<DiffLine>,
        version: Option<String>,
        changed: bool,
    },
    NoLongerApplies {
        reason: String,
    },
}

/// A proposal as review shows it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ProposalReview {
    id: i64,
    kind: ProposalKind,
    /// As the model gave it, or as the accept wrote it once a set began.
    path: String,
    /// The page's path as it is on disk, when there is a page to open: the path written for a
    /// proposal that is or was accepted, otherwise the existing page the path names.
    page: Option<String>,
    state: ProposalState,
    /// It was accepted, and that accept was undone.
    undone: bool,
    /// The set it belongs to.
    accept: Option<i64>,
    /// Only for a pending proposal.
    check: Option<ProposalCheck>,
}

/// A set of an answer's accepted proposals.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AcceptedSet {
    id: i64,
    /// How many of its proposals stay accepted.
    count: u32,
    /// Its change can be undone: history holds it and AI is on.
    undo: bool,
}

/// An answer's proposals, its notes, and its accepted sets.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AnswerReview {
    answer: i64,
    /// How many proposed changes could not be read.
    unreadable: u32,
    /// The answer ended before a proposed change was complete.
    unfinished: bool,
    proposals: Vec<ProposalReview>,
    accepted: Vec<AcceptedSet>,
}

/// A page an accept or undo wrote: its path as it is on disk, its text as the editor reads it, and
/// its version.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct WrittenPage {
    path: String,
    text: String,
    version: String,
}

/// The proposal whose write stopped an accept partway, and why.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AcceptFailure {
    proposal: i64,
    message: String,
}

/// What an accept wrote.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Accepted {
    /// The accepted set, or none when nothing was written.
    set: Option<i64>,
    /// How many of the `of` proposals were accepted.
    accepted: u32,
    of: u32,
    written: Vec<WrittenPage>,
    failure: Option<AcceptFailure>,
    /// History recorded the accept, so it can be undone.
    undo: bool,
}

/// What an undo wrote back: the pages it restored, and the paths of those it deleted.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Undone {
    restored: Vec<WrittenPage>,
    deleted: Vec<String>,
}

/// A proposal to accept, with the version of the page its diff was computed from (none for a new
/// page).
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ProposalVersion {
    id: i64,
    version: Option<String>,
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
    /// The conversations of the latest world session that used them, by session.
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
    /// The text received so far, markup included, outside the request's task, so that aborting it
    /// keeps the text.
    raw: String,
    /// Splits the text received into the prose and proposal events the channel carries.
    splitter: Splitter,
    /// The conversation it answers in, once its message is recorded.
    conversation: Option<i64>,
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
    carried: Carried,
}

/// What a request carried, which its answer is saved with.
struct Carried {
    pages: Vec<ContextPage>,
    left_out: u32,
    /// The index was still being built as the pages were chosen.
    indexing: bool,
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
                raw: String::new(),
                splitter: Splitter::default(),
                conversation: None,
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

    /// Takes the store of `world`'s session into the running entry and records the message to
    /// answer, before any request leaves. Returns the conversation, the message's text and the
    /// conversation's earlier messages.
    fn record(
        &self,
        run: u64,
        world: &CurrentWorld,
        outgoing: Outgoing,
    ) -> Result<(i64, String, Vec<store::Message>), AppError> {
        let mut inner = self.lock();
        let shared = store_of(&mut inner, world)?;
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
                let conversation =
                    store.add_user_message(conversation, &outgoing.text, None, now())?;
                (conversation, outgoing.text)
            }
        };
        if let Some(running) = running(&mut inner, run) {
            running.conversation = Some(conversation);
        }
        let mut earlier = store.messages(conversation)?;
        // The last one is the message being answered.
        earlier.pop();
        Ok((conversation, text, earlier))
    }

    /// Adds `delta` to the running answer's text, and returns the events it gives: its prose, and
    /// the proposals whose opening lines it completes.
    fn received(&self, run: u64, delta: &str) -> Vec<AnswerEvent> {
        let mut inner = self.lock();
        let Some(running) = running(&mut inner, run) else {
            return Vec::new();
        };
        running.raw.push_str(delta);
        running
            .splitter
            .feed(delta)
            .into_iter()
            .map(|piece| match piece {
                Piece::Prose(delta) => AnswerEvent::Text { delta },
                Piece::Begun { kind, path } => AnswerEvent::Proposal { change: kind, path },
            })
            .collect()
    }

    /// Takes the text the running answer `run` received, markup included.
    fn take_raw(&self, run: u64) -> Result<String, AppError> {
        let mut inner = self.lock();
        let running = running(&mut inner, run).ok_or_else(internal)?;
        Ok(std::mem::take(&mut running.raw))
    }

    /// Saves how the request of the running answer `run` ended, with `parsed`, read from its text
    /// `raw`, in its session's store, and returns its end.
    fn finish(
        &self,
        run: u64,
        conversation: i64,
        outcome: tauri::Result<StreamEnd>,
        carried: &Carried,
        raw: &str,
        parsed: Parsed,
    ) -> Result<AnswerEnd, AppError> {
        let mut inner = self.lock();
        let running = running(&mut inner, run).ok_or_else(internal)?;
        let state = match &outcome {
            Ok(StreamEnd::Complete) => Some(AnswerState::Complete),
            Ok(StreamEnd::CutOff) => Some(AnswerState::CutOff),
            // Saved as stopped when any of it arrived, proposals included.
            Ok(StreamEnd::Failed { .. }) => (!raw.is_empty()).then_some(AnswerState::Stopped),
            // The request was aborted: by Stop, AI switched off, or the provider saved again or
            // its key removed.
            Err(_) => Some(AnswerState::Stopped),
        };
        let mut answer = None;
        if let (Some(state), Some(store)) = (state, &running.store) {
            let pages: Vec<(String, bool)> = carried
                .pages
                .iter()
                .map(|page| (page.path.clone(), page.partial))
                .collect();
            let saved = Answer {
                state,
                text: &parsed.prose,
                pages: &pages,
                left_out: carried.left_out,
                indexing: carried.indexing,
                proposals: &parsed.proposals,
                unreadable: parsed.unreadable,
                unfinished: parsed.unfinished,
                images: &[],
                image_unreadable: 0,
                image_unfinished: false,
            };
            // A write the file refuses is made in memory, and the store's notice says that the
            // conversations are not being saved; the answer ends either way.
            answer = lock_store(store)
                .add_answer(conversation, &saved, now())
                .ok()
                .map(|(answer, _)| answer);
        }
        let text = parsed.prose;
        Ok(match outcome {
            Ok(StreamEnd::Complete) => AnswerEnd::Complete {
                conversation,
                text,
                answer,
            },
            Ok(StreamEnd::CutOff) => AnswerEnd::CutOff {
                conversation,
                text,
                answer,
            },
            Ok(StreamEnd::Failed {
                reason,
                detail,
                provider_message,
            }) => AnswerEnd::Failed {
                conversation,
                text,
                answer,
                reason,
                detail,
                provider_message,
            },
            Err(_) => AnswerEnd::Stopped {
                conversation,
                text,
                answer,
            },
        })
    }

    /// Asks the running answer, if any and if `which` it is, to stop, aborts its request, waits
    /// until it has ended and been saved, and returns the lock taken again.
    fn stop_running<'a>(
        &'a self,
        mut inner: MutexGuard<'a, Inner>,
        which: impl Fn(&Running) -> bool,
    ) -> MutexGuard<'a, Inner> {
        let Some(running) = inner.running.as_mut().filter(|running| which(running)) else {
            return inner;
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
        inner
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

fn running(inner: &mut Inner, run: u64) -> Option<&mut Running> {
    inner.running.as_mut().filter(|running| running.id == run)
}

/// The store of `world`'s session, opened from the world's file when the session changed, so a
/// reopened world reads its file again.
fn store_of(inner: &mut Inner, world: &CurrentWorld) -> Result<SharedStore, AppError> {
    if let Some((session, store)) = &inner.store
        && *session == world.session
    {
        return Ok(Arc::clone(store));
    }
    let now = u64::try_from(now()).unwrap_or_default();
    let store = Store::open(world.app_data.as_deref(), &world.root, now)?;
    let store = Arc::new(Mutex::new(store));
    inner.store = Some((world.session, Arc::clone(&store)));
    Ok(store)
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
    /// An accept checked its proposals and has written nothing.
    AcceptChecked,
    /// An accept's batch was written, and its set is not finished yet.
    AcceptWritten,
    /// An undo's change was written back, and its set is not finished yet.
    UndoWritten,
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
        let context = context::choose(services.world(), session, active.as_deref(), &text);
        Ok(request::build(&world_name, &context, &earlier, &text))
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
                answer: None,
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
        carried,
    }) = started
    else {
        return Ok(AnswerEnd::Stopped {
            conversation,
            text: String::new(),
            answer: None,
        });
    };
    let outcome = task.await;
    let end = blocking(&services, move |services| {
        drop(guard);
        let assistant = services.assistant();
        let raw = assistant.take_raw(run_id)?;
        let complete = matches!(outcome, Ok(StreamEnd::Complete));
        let parsed = read_answer(services.world(), session, &raw, complete);
        assistant.finish(run_id, conversation, outcome, &carried, &raw, parsed)
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
    // A retry removes a stopped answer, which must not be one whose set an earlier opening left
    // unfinished.
    if outgoing.retry {
        resolve_unfinished(services, &world)?;
    }
    let request = services.settings().prepare_request()?;
    let active = outgoing.active.clone();
    let (conversation, text, earlier) = services.assistant().record(run.id, &world, outgoing)?;
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
            indexing,
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
                        indexing,
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
                carried: Carried {
                    pages,
                    left_out,
                    indexing,
                },
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
            for event in services.assistant().received(run, delta) {
                // A webview that cannot take the event changes nothing in the core.
                let _ = on_event.send(event);
            }
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
        let assistant = services.assistant();
        drop(assistant.stop_running(assistant.lock(), |_| true));
        Ok(())
    })
    .await
}

/// Refuses while AI is off; otherwise runs `work` on the open world's store, under the assistant
/// lock, after stopping the running answer when `stopping` it is.
async fn with_store<S: Services, T: Send + 'static>(
    services: &S,
    stopping: impl Fn(&Running) -> bool + Send + 'static,
    work: impl FnOnce(&mut Store) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    blocking(services, move |services| {
        if !services.settings().ai_on() {
            return Err(settings::ai_off());
        }
        let world = services.world().current()?;
        let assistant = services.assistant();
        let mut inner = assistant.stop_running(assistant.lock(), stopping);
        let store = store_of(&mut inner, &world)?;
        work(&mut lock_store(&store))
    })
    .await
}

/// The open world's conversations, newest first, and how they are kept.
pub(crate) async fn conversations<S: Services>(services: S) -> Result<Conversations, AppError> {
    with_store(&services, |_| false, |store| store.conversations()).await
}

/// One of the open world's conversations with its messages.
pub(crate) async fn conversation<S: Services>(
    services: S,
    id: i64,
) -> Result<Conversation, AppError> {
    with_store(&services, |_| false, move |store| store.conversation(id)).await
}

/// Deletes one of the open world's conversations for good, once an answer running in it has
/// stopped and been saved.
pub(crate) async fn delete<S: Services>(services: S, id: i64) -> Result<(), AppError> {
    let answering = move |running: &Running| running.conversation == Some(id);
    with_store(&services, answering, move |store| store.delete(id)).await
}

/// Refuses while AI is off; otherwise the links of `text`, an answer's text, each with the page it
/// resolves to as on a page at the world's top level, once the index is built.
pub(crate) async fn links<S: Services>(services: S, text: String) -> Result<EditorLinks, AppError> {
    blocking(&services, move |services| {
        if !services.settings().ai_on() {
            return Err(settings::ai_off());
        }
        services.world().links_in("", &text)
    })
    .await
}

/// Reads `raw`, a whole answer, and gives each edit the hash of its page's text as the page is now
/// in the opening `session`, read with no lock of the assistant's held; an edit whose page cannot
/// be read gets none.
fn read_answer(world: &WorldState, session: u64, raw: &str, complete: bool) -> Parsed {
    let mut parsed = proposals::parse(raw, complete);
    for proposal in &mut parsed.proposals {
        if let ProposalContent::Edit { base, .. } = &mut proposal.content {
            *base = proposals::page_path(&proposal.path)
                .ok()
                .and_then(|path| world.page_in(session, &path).ok())
                .map(|(_, page)| proposals::text_hash(&page.text));
        }
    }
    parsed
}

/// Refuses while AI is off; otherwise the open world's session and its store, once the sets the
/// store left unfinished when it opened are resolved.
fn resolved_store<S: Services>(services: &S) -> Result<(u64, SharedStore), AppError> {
    if !services.settings().ai_on() {
        return Err(settings::ai_off());
    }
    let world = services.world().current()?;
    let store = resolve_unfinished(services, &world)?;
    Ok((world.session, store))
}

/// Resolves the sets that the store of `world`'s session left unfinished when it opened, which are
/// handed over once, and returns the store. Their pages are read with no assistant or store lock
/// held.
fn resolve_unfinished<S: Services>(
    services: &S,
    world: &CurrentWorld,
) -> Result<SharedStore, AppError> {
    let (store, unfinished) = {
        let mut inner = services.assistant().lock();
        let store = store_of(&mut inner, world)?;
        let unfinished = lock_store(&store).take_unfinished();
        (store, unfinished)
    };
    for set in &unfinished {
        resolve(services.world(), world.session, &store, set);
    }
    Ok(store)
}

/// Settles the unfinished set `set` from what its pages hold in the opening `session`: a proposal
/// whose page holds the text its accept writes stays accepted, and the rest become pending. A page
/// that does not exist or is not UTF-8 does not hold it; when a page cannot be read for another
/// reason, such as the world having closed, the set stays unfinished for the next opening to
/// resolve. The pages are read before the store's lock is taken, and the store changes the set only
/// while it is still unfinished.
fn resolve(world: &WorldState, session: u64, store: &Mutex<Store>, set: &UnfinishedSet) {
    let mut holding = Vec::new();
    for page in &set.pages {
        match world.page_in(session, &page.path) {
            Ok((_, read)) if proposals::text_hash(&read.text) == page.result => {
                holding.push(page.proposal);
            }
            Ok(_) => {}
            Err(error) if matches!(error.kind, ErrorKind::NotFound | ErrorKind::NotUtf8) => {}
            Err(_) => return,
        }
    }
    // A write the file refuses is made in memory; one that fails there too leaves the set
    // unfinished, which changes nothing in the world.
    let _ = lock_store(store).settle(set.id, &holding);
}

/// The set an accept or undo began, which it resolves from what its pages hold when it is dropped
/// before the command finished the set: on an error, a rolled-back undo or a panic.
struct Unsettled<'a> {
    world: &'a WorldState,
    session: u64,
    store: &'a Mutex<Store>,
    set: Option<UnfinishedSet>,
}

impl Drop for Unsettled<'_> {
    fn drop(&mut self) {
        if let Some(set) = self.set.take() {
            resolve(self.world, self.session, self.store, &set);
        }
    }
}

/// Why a proposal cannot be written now.
enum Refusal {
    /// It no longer applies, for this reason.
    NoLongerApplies(String),
    /// The world could not be read.
    Failed(AppError),
}

impl From<String> for Refusal {
    fn from(reason: String) -> Self {
        Self::NoLongerApplies(reason)
    }
}

impl From<AppError> for Refusal {
    /// The world's refusal of a proposal's page, in the words of a proposal.
    fn from(error: AppError) -> Self {
        match error.kind {
            ErrorKind::NoWorld | ErrorKind::WorldMissing => Self::Failed(error),
            ErrorKind::NotFound => Self::NoLongerApplies("The page does not exist.".to_owned()),
            // The confinement rules' refusal, which speaks of a link.
            ErrorKind::InvalidPath if error.message.contains("link") => Self::NoLongerApplies(
                "The path leads outside the world, or through a hidden or linked folder."
                    .to_owned(),
            ),
            _ => Self::NoLongerApplies(error.message),
        }
    }
}

/// What a pending proposal writes now: its write, the page's text it applies to (empty for a new
/// page), the text it leaves there, and the page's version (none for a new page).
struct Planned {
    write: BatchWrite,
    current: String,
    result: String,
    version: Option<String>,
}

/// Applies `proposal` to its page as the page is now in the opening `session`, after the proposal
/// path rules and then the world's rules for its path.
fn plan(world: &WorldState, session: u64, proposal: &SavedProposal) -> Result<Planned, Refusal> {
    let path = proposals::page_path(&proposal.path)?;
    match &proposal.content {
        ProposalContent::NewPage { text } => Ok(Planned {
            write: BatchWrite::NewPage {
                path: world.new_page_free(session, &path)?,
                text: text.clone(),
            },
            current: String::new(),
            result: text.clone(),
            version: None,
        }),
        ProposalContent::Edit { passages, .. } => {
            let (path, page) = world.page_in(session, &path)?;
            let result = proposals::apply(&page.text, passages)?;
            if result == page.text {
                return Err(Refusal::NoLongerApplies(
                    "The edit makes no change to the page.".to_owned(),
                ));
            }
            Ok(Planned {
                write: BatchWrite::Edit {
                    path,
                    text: result.clone(),
                    version: page.version.clone(),
                },
                current: page.text,
                result,
                version: Some(page.version),
            })
        }
    }
}

/// The open world's answers in `conversation` that have proposals or notes, in order, each
/// proposal checked against its page as it is now.
fn review_answers<S: Services>(
    services: &S,
    conversation: i64,
) -> Result<Vec<AnswerReview>, AppError> {
    let (session, store) = resolved_store(services)?;
    let answers = lock_store(&store).proposals(conversation)?;
    answers
        .into_iter()
        .map(|answer| review_answer(services.world(), session, answer))
        .collect()
}

fn review_answer(
    world: &WorldState,
    session: u64,
    answer: AnswerProposals,
) -> Result<AnswerReview, AppError> {
    let proposals = answer
        .proposals
        .iter()
        .map(|proposal| review_proposal(world, session, proposal))
        .collect::<Result<_, _>>()?;
    let accepted = answer
        .sets
        .iter()
        .filter(|set| set.state == SetState::Accepted)
        .map(|set| {
            let count = answer
                .proposals
                .iter()
                .filter(|proposal| {
                    proposal.accept == Some(set.id) && proposal.state == ProposalState::Accepted
                })
                .count();
            let undo = match set.change {
                Some(change) => world.holds_change(
                    session,
                    change_id(change),
                    crate::history::Kind::Accepted,
                )?,
                None => false,
            };
            Ok(AcceptedSet {
                id: set.id,
                count: count as u32,
                undo,
            })
        })
        .collect::<Result<_, AppError>>()?;
    Ok(AnswerReview {
        answer: answer.answer,
        unreadable: answer.unreadable,
        unfinished: answer.unfinished,
        proposals,
        accepted,
    })
}

fn review_proposal(
    world: &WorldState,
    session: u64,
    proposal: &SavedProposal,
) -> Result<ProposalReview, AppError> {
    // Once a set began, the stored path is the one the accept writes.
    let in_a_set =
        proposal.accept.is_some() || proposal.state == ProposalState::Accepted || proposal.undone;
    let page = if in_a_set {
        Some(proposal.path.clone())
    } else {
        proposals::page_path(&proposal.path)
            .ok()
            .and_then(|path| world.page_in(session, &path).ok())
            .map(|(path, _)| path)
    };
    let check = match proposal.state {
        ProposalState::Pending => Some(match plan(world, session, proposal) {
            Ok(planned) => ProposalCheck::Applies {
                lines: world::compare(&planned.current, &planned.result),
                changed: match &proposal.content {
                    ProposalContent::Edit { base, .. } => {
                        *base != Some(proposals::text_hash(&planned.current))
                    }
                    ProposalContent::NewPage { .. } => false,
                },
                version: planned.version,
            },
            Err(Refusal::NoLongerApplies(reason)) => ProposalCheck::NoLongerApplies { reason },
            Err(Refusal::Failed(error)) => return Err(error),
        }),
        ProposalState::Accepted | ProposalState::Rejected => None,
    };
    Ok(ProposalReview {
        id: proposal.id,
        kind: match proposal.content {
            ProposalContent::NewPage { .. } => ProposalKind::NewPage,
            ProposalContent::Edit { .. } => ProposalKind::Edit,
        },
        path: proposal.path.clone(),
        page,
        state: proposal.state,
        undone: proposal.undone,
        accept: proposal.accept,
        check,
    })
}

fn change_id(change: HistoryChange) -> ChangeId {
    ChangeId {
        id: change.id,
        started: change.started,
    }
}

fn conflict(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Conflict, message)
}

/// Writes `chosen`, pending proposals of `answer`, as one change, when each still applies to its
/// page at the version the interface showed; otherwise refuses with `conflict` and writes nothing.
fn accept_proposals<S: Services>(
    services: &S,
    answer: i64,
    chosen: &[ProposalVersion],
) -> Result<Accepted, AppError> {
    let (session, store) = resolved_store(services)?;
    let world = services.world();
    if chosen.is_empty() {
        return Err(conflict("No proposal was chosen."));
    }
    let saved = lock_store(&store).answer_proposals(answer)?;
    let mut writes = Vec::with_capacity(chosen.len());
    // Each proposal with the hash of the text its write leaves.
    let mut results = Vec::with_capacity(chosen.len());
    for wanted in chosen {
        let proposal = saved
            .proposals
            .iter()
            .find(|proposal| proposal.id == wanted.id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "The proposal does not exist."))?;
        if proposal.state != ProposalState::Pending || proposal.accept.is_some() {
            return Err(conflict("The proposal is no longer pending."));
        }
        let planned = match plan(world, session, proposal) {
            Ok(planned) => planned,
            Err(Refusal::NoLongerApplies(reason)) => return Err(conflict(reason)),
            Err(Refusal::Failed(error)) => return Err(error),
        };
        if planned.version != wanted.version {
            return Err(conflict(
                "The page changed since the proposal was shown, so nothing was written.",
            ));
        }
        results.push((proposal.id, proposals::text_hash(&planned.result)));
        writes.push(planned.write);
    }
    #[cfg(test)]
    services.assistant().pause(Step::AcceptChecked);

    let mut unsettled = Unsettled {
        world,
        session,
        store: &store,
        set: None,
    };
    let batch = world.accept_batch(session, &writes, |change, paths| {
        let pages: Vec<SetPage> = results
            .iter()
            .zip(paths)
            .map(|((proposal, result), path)| SetPage {
                proposal: *proposal,
                path: path.clone(),
                result: *result,
            })
            .collect();
        let change = change.map(|change| HistoryChange {
            id: change.id,
            started: change.started,
        });
        // A proposal rejected or a conversation deleted since the check stops the batch.
        match lock_store(&store).begin_accept(answer, &pages, change, now()) {
            Ok(id) => {
                unsettled.set = Some(UnfinishedSet { id, pages });
                true
            }
            Err(_) => false,
        }
    })?;
    #[cfg(test)]
    services.assistant().pause(Step::AcceptWritten);

    let set = unsettled
        .set
        .as_ref()
        .map(|set| set.id)
        .ok_or_else(internal)?;
    let written: Vec<i64> = results[..batch.written.len()]
        .iter()
        .map(|(proposal, _)| *proposal)
        .collect();
    lock_store(&store).settle(set, &written)?;
    unsettled.set = None;
    Ok(Accepted {
        set: (!written.is_empty()).then_some(set),
        accepted: written.len() as u32,
        of: writes.len() as u32,
        failure: batch.failure.map(|failure| AcceptFailure {
            proposal: results[failure.index].0,
            message: failure.error.message,
        }),
        written: batch
            .written
            .into_iter()
            .map(|page| WrittenPage {
                path: page.path,
                text: page.text,
                version: page.version,
            })
            .collect(),
        undo: batch.change.is_some(),
    })
}

/// Rejects a pending proposal that belongs to no set.
fn reject_proposal<S: Services>(services: &S, proposal: i64) -> Result<(), AppError> {
    let (_, store) = resolved_store(services)?;
    lock_store(&store).reject(proposal)
}

/// Undoes the change of the accepted set `set` as a whole, and returns its proposals to pending,
/// marked undone.
fn undo_set<S: Services>(services: &S, set: i64) -> Result<Undone, AppError> {
    let (session, store) = resolved_store(services)?;
    let world = services.world();
    let accepted = lock_store(&store).accept_set(set)?;
    if accepted.state != SetState::Accepted {
        return Err(conflict("The proposals are no longer accepted."));
    }
    let change = accepted
        .change
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "This change cannot be undone."))?;
    let mut unsettled = Unsettled {
        world,
        session,
        store: &store,
        set: None,
    };
    let undone = world.undo_batch(session, change_id(change), |_, _| {
        match lock_store(&store).begin_undo(set) {
            Ok(pages) => {
                unsettled.set = Some(pages);
                true
            }
            Err(_) => false,
        }
    })?;
    // The undo stayed partly done; the set is resolved from what its pages hold.
    if let Some(failure) = undone.failure {
        return Err(failure);
    }
    #[cfg(test)]
    services.assistant().pause(Step::UndoWritten);

    lock_store(&store).settle(set, &[])?;
    unsettled.set = None;
    Ok(Undone {
        restored: undone
            .restored
            .into_iter()
            .map(|page| WrittenPage {
                path: page.path,
                text: page.text,
                version: page.version,
            })
            .collect(),
        deleted: undone.deleted,
    })
}

/// The open world's answers in `conversation` that have proposals or notes, each proposal checked
/// against its page as it is now.
pub(crate) async fn review<S: Services>(
    services: S,
    conversation: i64,
) -> Result<Vec<AnswerReview>, AppError> {
    blocking(&services, move |services| {
        review_answers(services, conversation)
    })
    .await
}

/// Writes the chosen proposals of `answer` as one change.
pub(crate) async fn accept<S: Services>(
    services: S,
    answer: i64,
    chosen: Vec<ProposalVersion>,
) -> Result<Accepted, AppError> {
    blocking(&services, move |services| {
        accept_proposals(services, answer, &chosen)
    })
    .await
}

/// Rejects a pending proposal for good.
pub(crate) async fn reject<S: Services>(services: S, proposal: i64) -> Result<(), AppError> {
    blocking(&services, move |services| {
        reject_proposal(services, proposal)
    })
    .await
}

/// Undoes an accepted set's change.
pub(crate) async fn undo<S: Services>(services: S, set: i64) -> Result<Undone, AppError> {
    blocking(&services, move |services| undo_set(services, set)).await
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

/// Answers a message about the open world with the pages of the world that matter to it as
/// context, streaming the answer's events to `on_event`.
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

/// The links of an answer's text, resolved as on a page at the world's top level.
#[tauri::command]
pub async fn assistant_links(app: AppHandle, text: String) -> Result<EditorLinks, AppError> {
    links(app, text).await
}

/// The open world's conversations, the latest message's newest first, and how they are kept.
#[tauri::command]
pub async fn assistant_conversations(app: AppHandle) -> Result<Conversations, AppError> {
    conversations(app).await
}

/// One of the open world's conversations with its messages.
#[tauri::command]
pub async fn assistant_conversation(app: AppHandle, id: i64) -> Result<Conversation, AppError> {
    conversation(app, id).await
}

/// Deletes one of the open world's conversations for good, stopping an answer running in it first.
#[tauri::command]
pub async fn assistant_delete(app: AppHandle, id: i64) -> Result<(), AppError> {
    delete(app, id).await
}

/// The proposals of a conversation's answers, each pending one checked against its page as it is
/// now, and their accepted sets.
#[tauri::command]
pub async fn assistant_review(
    app: AppHandle,
    conversation: i64,
) -> Result<Vec<AnswerReview>, AppError> {
    review(app, conversation).await
}

/// Writes the chosen pending proposals of an answer as one change, each against the page version
/// its diff was computed from.
#[tauri::command]
pub async fn assistant_accept(
    app: AppHandle,
    answer: i64,
    proposals: Vec<ProposalVersion>,
) -> Result<Accepted, AppError> {
    accept(app, answer, proposals).await
}

/// Rejects a pending proposal for good.
#[tauri::command]
pub async fn assistant_reject(app: AppHandle, proposal: i64) -> Result<(), AppError> {
    reject(app, proposal).await
}

/// Undoes the change of an accepted set as a whole.
#[tauri::command]
pub async fn assistant_undo(app: AppHandle, set: i64) -> Result<Undone, AppError> {
    undo(app, set).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::testing as history_testing;
    use crate::history::{Entry, History, Kind, State};
    use crate::index::{BuildState, EditorLink, LinkState};
    use crate::providers::test_support::{Server, answer, stream_head};
    use crate::secrets::test_support::{KEY, MockKeychain};
    use serde_json::{Value, json};
    use std::fs;
    use std::path::Path;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;
    use store::{ConversationSummary, Passage, SavedMessage};
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

    /// A temporary world with one page, open, and settings whose provider is `server`, all keeping
    /// their data in a temporary app data folder.
    struct Fixture {
        services: TestServices,
        keychain: MockKeychain,
        server: Server,
        world: TempDir,
        app_data: TempDir,
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
            states.world.load_recent(data.path());
            states.world.open(world.path().to_path_buf()).unwrap();
            let fixture = Self {
                services: TestServices(Arc::new(states)),
                keychain,
                server,
                world,
                app_data: data,
            };
            fixture.indexed();
            fixture
        }

        /// Waits until the open world's index is built, so the pages it chooses do not depend on
        /// how far the build is.
        fn indexed(&self) {
            let world = self.services.world();
            let session = world.current().unwrap().session;
            wait_until("the index", || {
                world
                    .query_index_in(session, |index| Ok(index.state() == &BuildState::Ready))
                    .unwrap()
            });
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

        fn conversation(&self, id: i64) -> Result<Conversation, AppError> {
            block_on(conversation(self.services.clone(), id))
        }

        fn conversations(&self) -> Result<Conversations, AppError> {
            block_on(conversations(self.services.clone()))
        }

        fn delete(&self, id: i64) -> Result<(), AppError> {
            block_on(delete(self.services.clone(), id))
        }

        /// The world's conversation file and its journal, if any, as bytes.
        fn store_bytes(&self) -> Vec<u8> {
            let folder = self.app_data.path().join("grimoire-data/conversations");
            let mut bytes = Vec::new();
            for entry in fs::read_dir(folder).unwrap() {
                bytes.extend(fs::read(entry.unwrap().path()).unwrap());
            }
            bytes
        }

        /// The current session's conversation.
        fn stored(&self, conversation: i64) -> Vec<store::Message> {
            let store = self.assistant().lock().store.clone().unwrap().1;
            lock_store(&store).messages(conversation).unwrap()
        }

        /// The id of the last answer saved in the current session's `conversation`.
        fn last_answer(&self, conversation: i64) -> Option<i64> {
            let store = self.assistant().lock().store.clone().unwrap().1;
            let messages = lock_store(&store)
                .conversation(conversation)
                .unwrap()
                .messages;
            messages.iter().rev().find_map(|message| match message {
                SavedMessage::Answer { id, .. } => Some(*id),
                SavedMessage::User { .. } => None,
            })
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
            proposals: Vec::new(),
            images: Vec::new(),
        }
    }

    fn answered(state: AnswerState, text: &str) -> store::Message {
        store::Message {
            text: text.to_owned(),
            answer: Some(state),
            proposals: Vec::new(),
            images: Vec::new(),
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
        assert_eq!(fixture.conversations().unwrap_err().kind, ErrorKind::AiOff);
        assert_eq!(fixture.conversation(1).unwrap_err().kind, ErrorKind::AiOff);
        assert_eq!(fixture.delete(1).unwrap_err().kind, ErrorKind::AiOff);
        assert_eq!(fixture.review(1).unwrap_err().kind, ErrorKind::AiOff);
        assert_eq!(
            fixture.accept(1, Vec::new()).unwrap_err().kind,
            ErrorKind::AiOff
        );
        assert_eq!(fixture.reject(1).unwrap_err().kind, ErrorKind::AiOff);
        assert_eq!(fixture.undo(1).unwrap_err().kind, ErrorKind::AiOff);
        fixture.settings().set_ai(true).unwrap();
        assert_eq!(fixture.conversations().unwrap().items, []);
        fixture.services.world().close();
        assert_eq!(kind(send("Hi", None)), ErrorKind::NoWorld);
        assert_eq!(
            fixture.conversations().unwrap_err().kind,
            ErrorKind::NoWorld
        );

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
                text: "A port.".to_owned(),
                answer: fixture.last_answer(conversation),
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
                    "indexing": false,
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
        let saved = fixture.conversation(conversation).unwrap().messages;
        let Some(SavedMessage::Answer { pages, .. }) = saved.last() else {
            panic!("expected the answer, got {saved:?}");
        };
        assert_eq!(
            pages,
            &[ContextPage {
                path: PAGE.to_owned(),
                partial: true
            }]
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
                text: "Half an ".to_owned(),
                answer: fixture.last_answer(conversation),
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
                text: "Some".to_owned(),
                answer: fixture.last_answer(conversation),
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
                    text: String::new(),
                    answer: None,
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
            answer: None,
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
                text: "Hi".to_owned(),
                answer: fixture.last_answer(conversation),
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
        // The new session opened the world's file again, which holds the answer.
        assert_eq!(
            fixture.stored(conversation),
            [user("Hello"), answered(AnswerState::Stopped, "Before")]
        );
        assert_eq!(fixture.server.requests().len(), 1);
    }

    #[test]
    fn the_user_message_is_in_the_world_s_file_before_the_request_leaves() {
        let fixture = Arc::new(Fixture::new(answering("Hi")));
        let saved_before = Arc::new(Mutex::new(None));
        let (hooked, slot) = (Arc::clone(&fixture), Arc::clone(&saved_before));
        fixture.at(Step::KeyRead, move || {
            let requests = hooked.server.requests().len();
            // Read through a connection of its own, so only what the file holds counts.
            let file = hooked.app_data.path().join("grimoire-data/conversations");
            let file = fs::read_dir(file).unwrap().next().unwrap().unwrap().path();
            let connection = rusqlite::Connection::open(file).unwrap();
            let texts: Vec<String> = connection
                .prepare("SELECT text FROM messages")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            *slot.lock().unwrap() = Some((requests, texts));
        });

        let (end, _) = fixture.send(None, "Who keeps the tor?", Some(PAGE));

        assert!(matches!(end, Ok(AnswerEnd::Complete { .. })), "{end:?}");
        assert_eq!(
            saved_before.lock().unwrap().take(),
            Some((0, vec!["Who keeps the tor?".to_owned()]))
        );
        assert_eq!(fixture.server.requests().len(), 1);
    }

    #[test]
    fn conversations_are_listed_newest_first_and_hold_no_page_text_and_no_key() {
        let fixture = Fixture::new(answering("A port town."));
        let page = "# Saltmere\nOnly the page knows: the harbour bell is cracked.\n";
        fs::write(fixture.world.path().join(PAGE), page).unwrap();
        let (first, _) = fixture.send(None, "Where is Saltmere?", Some(PAGE));
        let first = conversation_of(&first.unwrap());
        let (second, _) = fixture.send(None, "Second", None);
        let second = conversation_of(&second.unwrap());

        let listed = fixture.conversations().unwrap();

        let titles: Vec<(i64, String)> = listed
            .items
            .iter()
            .map(|ConversationSummary { id, title, .. }| (*id, title.clone()))
            .collect();
        // Both were answered within the same second; the later conversation still comes first.
        assert_eq!(
            titles,
            [
                (second, "Second".to_owned()),
                (first, "Where is Saltmere?".to_owned())
            ]
        );
        assert_eq!(listed.notice, None);
        let bytes = String::from_utf8_lossy(&fixture.store_bytes()).into_owned();
        assert!(bytes.contains("Where is Saltmere?") && bytes.contains(PAGE));
        assert!(!bytes.contains("harbour bell"));
        assert!(!bytes.contains(KEY));
        // The world folder holds only its own folder of pages.
        assert_eq!(fs::read_dir(fixture.world.path()).unwrap().count(), 1);
    }

    #[test]
    fn an_answer_the_file_refuses_ends_all_the_same_and_the_chat_goes_on_unsaved() {
        let fixture = Fixture::new(answering("Hi"));
        assert_eq!(fixture.conversations().unwrap().notice, None);
        // Fails every later write of an answer to the file.
        let folder = fixture.app_data.path().join("grimoire-data/conversations");
        let file = fs::read_dir(folder)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        rusqlite::Connection::open(file)
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail BEFORE INSERT ON messages WHEN NEW.role = 'assistant'
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();

        let (end, _) = fixture.send(None, "Hello", None);

        let end = end.unwrap();
        let conversation = conversation_of(&end);
        assert_eq!(
            end,
            AnswerEnd::Complete {
                conversation,
                text: "Hi".to_owned(),
                answer: fixture.last_answer(conversation),
            }
        );
        assert_eq!(
            fixture.conversations().unwrap().notice,
            Some(store::StoreNotice::NotSaved {
                reason: "The conversation store reported an error: refused.".to_owned()
            })
        );
        assert_eq!(
            fixture.stored(conversation),
            [user("Hello"), answered(AnswerState::Complete, "Hi")]
        );
    }

    #[test]
    fn after_a_crash_the_message_without_an_answer_shows_and_can_be_retried() {
        let fixture = Fixture::new(answering("Hi"));
        // A user message saved by an opening that ended before its answer did.
        let mut store =
            Store::open(Some(fixture.app_data.path()), fixture.world.path(), 1).unwrap();
        let conversation = store.add_user_message(None, "Hello", None, 1).unwrap();
        drop(store);
        fixture.reopen_world();

        assert_eq!(
            fixture.conversation(conversation).unwrap().messages,
            [SavedMessage::User {
                text: "Hello".to_owned(),
                time: 1
            }]
        );
        let retried = fixture.retry(conversation).unwrap();

        assert_eq!(
            retried,
            AnswerEnd::Complete {
                conversation,
                text: "Hi".to_owned(),
                answer: fixture.last_answer(conversation),
            }
        );
        assert_eq!(fixture.server.requests().len(), 1);
        fixture.reopen_world();
        assert_eq!(
            fixture.stored(conversation),
            [user("Hello"), answered(AnswerState::Complete, "Hi")]
        );
    }

    #[test]
    fn deleting_a_conversation_stops_its_answer_first_and_removes_it_for_good() {
        let fixture = Fixture::new(stalling("Half"));
        let mut store =
            Store::open(Some(fixture.app_data.path()), fixture.world.path(), 1).unwrap();
        let kept = store.add_user_message(None, "Kept", None, 1).unwrap();
        drop(store);
        let (handle, events) = fixture.start(None, "Gone soon", None, false);
        wait_until("the text", || events.lock().unwrap().len() == 2);
        let gone = events.lock().unwrap()[0]["conversation"].as_i64().unwrap();

        fixture.delete(gone).unwrap();

        let end = handle.join().unwrap().unwrap();
        assert!(
            matches!(
                &end,
                AnswerEnd::Stopped { conversation, text, answer: Some(_) }
                    if *conversation == gone && text == "Half"
            ),
            "{end:?}"
        );
        assert!(!fixture.running());
        assert_eq!(
            fixture.conversation(gone).unwrap_err().kind,
            ErrorKind::NotFound
        );
        fixture.reopen_world();
        let listed = fixture.conversations().unwrap().items;
        assert_eq!(
            listed.iter().map(|item| item.id).collect::<Vec<_>>(),
            [kept]
        );
        assert_eq!(fixture.delete(gone).unwrap_err().kind, ErrorKind::NotFound);
    }

    impl Fixture {
        /// Adds `pages`, as (path, text), to the world, and opens it again once they are indexed.
        fn add_pages(&self, pages: &[(&str, &str)]) {
            for (path, text) in pages {
                let file = self.world.path().join(path);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, text).unwrap();
            }
            self.reopen_world();
            self.indexed();
        }
    }

    #[test]
    fn the_request_carries_exactly_the_pages_its_event_lists_and_no_other_page() {
        let fixture = Fixture::new(answering("A port."));
        fixture.add_pages(&[
            ("Kesh Tor.md", "Brother Ketil keeps the tor."),
            ("People/Mirela.md", "Mirela sails to [[Saltmere]]."),
            ("Secret.md", "Hidden lore: the moon is glass."),
        ]);

        let (end, events) = fixture.send(None, "What about [[Kesh Tor]]?", Some(PAGE));

        assert!(matches!(end, Ok(AnswerEnd::Complete { .. })), "{end:?}");
        // The active page, the page the message links, then the page that links to the active one.
        let listed = [PAGE, "Kesh Tor.md", "People/Mirela.md"];
        let pages: Vec<Value> = listed
            .iter()
            .map(|path| json!({ "path": path, "partial": false }))
            .collect();
        assert_eq!(events[0]["pages"], json!(pages));
        assert_eq!(events[0]["indexing"], json!(false));
        let body = fixture.bodies().pop().unwrap();
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert_eq!(system.matches("\n--- Page ").count(), listed.len());
        for path in listed {
            let text = fs::read_to_string(fixture.world.path().join(path)).unwrap();
            assert!(
                system.contains(&format!("--- Page {path} ---\n{text}")),
                "{path}"
            );
        }
        assert!(!system.contains("Secret"));
        assert!(!system.contains("Hidden lore"));
    }

    #[test]
    fn an_answer_s_links_resolve_from_the_world_s_top_level_only_while_ai_is_on() {
        let fixture = Fixture::new(answering("Hi"));
        fixture.add_pages(&[("Saltmere.md", "The top-level Saltmere.")]);
        let links_of = |text: &str| block_on(links(fixture.services.clone(), text.to_owned()));

        let EditorLinks::Ready { links } =
            links_of("See [[Saltmere#Docks]], not [[Nowhere]].").unwrap()
        else {
            panic!("the index is built");
        };

        // A page in `Places/` would prefer `Places/Saltmere.md`.
        assert_eq!(
            links,
            [
                EditorLink {
                    from: 4,
                    to: 22,
                    state: LinkState::Resolved,
                    target: "Saltmere".to_owned(),
                    path: Some("Saltmere.md".to_owned()),
                    heading: Some("Docks".to_owned()),
                    block: None,
                },
                EditorLink {
                    from: 28,
                    to: 39,
                    state: LinkState::Unresolved,
                    target: "Nowhere".to_owned(),
                    path: None,
                    heading: None,
                    block: None,
                },
            ]
        );
        fixture.settings().set_ai(false).unwrap();
        assert_eq!(links_of("[[Saltmere]]").unwrap_err().kind, ErrorKind::AiOff);
    }

    const SALTMERE: &str = "# Saltmere\nA port town.\n";
    const FISHING: &str = "# Saltmere\nA fishing town.\n";
    const TO_FISHING: &str = "<edit path=\"Places/Saltmere.md\">\n<find>A port town.</find>\n\
                              <replace>A fishing town.</replace>\n</edit>\n";
    const KESH_TOR: &str = "<new_page path=\"Places/Kesh Tor\">\n# Kesh Tor\nA hill fort.\n\
                            </new_page>\n";

    /// An answer with prose around a new page and an edit of `PAGE`.
    fn proposing() -> String {
        format!("Here you go.\n{KESH_TOR}{TO_FISHING}Done.\n")
    }

    /// A provider that answers the requests in turn with `texts`, and with the last one after them.
    fn answering_in_turn(texts: &[&str]) -> Server {
        let bodies: Vec<Vec<u8>> = texts
            .iter()
            .map(|text| {
                let body = format!("{}data: [DONE]\n\n", delta(text));
                answer(
                    "200 OK",
                    &[("Content-Type", "text/event-stream")],
                    body.as_bytes(),
                )
            })
            .collect();
        let turn = std::sync::atomic::AtomicUsize::new(0);
        Server::start(move |_| {
            let next = turn.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(bodies[next.min(bodies.len() - 1)].clone())
        })
    }

    fn answer_of(end: &AnswerEnd) -> Option<i64> {
        match end {
            AnswerEnd::Complete { answer, .. }
            | AnswerEnd::Stopped { answer, .. }
            | AnswerEnd::CutOff { answer, .. }
            | AnswerEnd::Failed { answer, .. } => *answer,
        }
    }

    /// The proposal to accept at the version its check showed.
    fn chosen(proposal: &ProposalReview) -> ProposalVersion {
        let version = match &proposal.check {
            Some(ProposalCheck::Applies { version, .. }) => version.clone(),
            check => panic!("expected a proposal that applies, got {check:?}"),
        };
        ProposalVersion {
            id: proposal.id,
            version,
        }
    }

    fn states(review: &AnswerReview) -> Vec<(ProposalState, bool)> {
        let proposals = review.proposals.iter();
        proposals
            .map(|proposal| (proposal.state, proposal.undone))
            .collect()
    }

    fn accepted_sets(review: &AnswerReview) -> Vec<(u32, bool)> {
        let sets = review.accepted.iter();
        sets.map(|set| (set.count, set.undo)).collect()
    }

    impl Fixture {
        /// Sends a message in `conversation`, or a new one, and returns the conversation and the
        /// saved answer.
        fn ask(&self, conversation: Option<i64>) -> (i64, i64) {
            let end = self.send(conversation, "Write it", None).0.unwrap();
            (
                conversation_of(&end),
                answer_of(&end).expect("a saved answer"),
            )
        }

        fn review(&self, conversation: i64) -> Result<Vec<AnswerReview>, AppError> {
            block_on(review(self.services.clone(), conversation))
        }

        /// The review of the answer `answer` in `conversation`.
        fn reviewed(&self, conversation: i64, answer: i64) -> AnswerReview {
            let answers = self.review(conversation).unwrap();
            let found = answers.into_iter().find(|review| review.answer == answer);
            found.expect("the answer has proposals or notes")
        }

        fn accept(&self, answer: i64, chosen: Vec<ProposalVersion>) -> Result<Accepted, AppError> {
            block_on(accept(self.services.clone(), answer, chosen))
        }

        /// Accepts every proposal of `answer` at the version its check shows.
        fn accept_all(&self, conversation: i64, answer: i64) -> Accepted {
            let review = self.reviewed(conversation, answer);
            let chosen = review.proposals.iter().map(chosen).collect();
            self.accept(answer, chosen).unwrap()
        }

        fn reject(&self, proposal: i64) -> Result<(), AppError> {
            block_on(reject(self.services.clone(), proposal))
        }

        fn undo(&self, set: i64) -> Result<Undone, AppError> {
            block_on(undo(self.services.clone(), set))
        }

        /// Runs `work` with the services on another thread.
        fn in_thread<T: Send + 'static, F: std::future::Future<Output = T>>(
            &self,
            work: impl FnOnce(TestServices) -> F + Send + 'static,
        ) -> thread::JoinHandle<T> {
            let services = self.services.clone();
            thread::spawn(move || block_on(work(services)))
        }

        /// Holds the next command that reaches `step` there until the returned sender sends; the
        /// receiver hears when it got there.
        fn pause_at(&self, step: Step) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (reached, reached_here) = mpsc::channel();
            let (release, released) = mpsc::channel();
            let (reached, released) = (Mutex::new(reached), Mutex::new(released));
            self.at(step, move || {
                reached.lock().unwrap().send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
            });
            (reached_here, release)
        }

        /// Every file in the world, by path, with its bytes.
        fn files(&self) -> Vec<(String, Vec<u8>)> {
            fn walk(folder: &Path, prefix: &str, files: &mut Vec<(String, Vec<u8>)>) {
                let mut entries: Vec<_> = fs::read_dir(folder).unwrap().flatten().collect();
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries {
                    let path = format!("{prefix}{}", entry.file_name().to_string_lossy());
                    let kind = entry.file_type().unwrap();
                    if kind.is_symlink() {
                        files.push((path, Vec::new()));
                    } else if kind.is_dir() {
                        walk(&entry.path(), &format!("{path}/"), files);
                    } else {
                        files.push((path, fs::read(entry.path()).unwrap()));
                    }
                }
            }
            let mut files = Vec::new();
            walk(self.world.path(), "", &mut files);
            files
        }

        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.world.path().join(path)).unwrap()
        }

        /// The changes in the world's history: each one's kind, whether it is pending, and the
        /// paths of its entries.
        fn changes(&self) -> Vec<(String, bool, Vec<String>)> {
            let stored = history_testing::stored(self.app_data.path(), self.world.path());
            stored
                .into_iter()
                .map(|change| {
                    let entries = change.entries.into_iter();
                    let paths = entries.map(|entry| entry.entry.path).collect();
                    (change.kind, change.pending, paths)
                })
                .collect()
        }

        /// The world's conversation file, read through a connection of its own.
        fn store_file(&self) -> rusqlite::Connection {
            let folder = self.app_data.path().join("grimoire-data/conversations");
            let file = fs::read_dir(folder)
                .unwrap()
                .flatten()
                .map(|entry| entry.path())
                .find(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "sqlite")
                })
                .unwrap();
            rusqlite::Connection::open(file).unwrap()
        }

        /// The current session's store's view of `conversation`'s proposals.
        fn saved_proposals(&self, conversation: i64) -> Vec<AnswerProposals> {
            let store = self.assistant().lock().store.clone().unwrap().1;
            lock_store(&store).proposals(conversation).unwrap()
        }
    }

    #[test]
    fn an_answer_streams_its_prose_and_proposal_events_and_saving_or_rejecting_writes_nothing() {
        let fixture = Fixture::new(answering(&proposing()));
        let files = fixture.files();

        let (end, events) = fixture.send(None, "Write it", None);

        let end = end.unwrap();
        let conversation = conversation_of(&end);
        assert_eq!(
            end,
            AnswerEnd::Complete {
                conversation,
                text: "Here you go.\nDone.\n".to_owned(),
                answer: fixture.last_answer(conversation),
            }
        );
        assert_eq!(
            events[1..],
            [
                json!({ "kind": "text", "delta": "Here you go.\n" }),
                json!({ "kind": "proposal", "change": "new_page", "path": "Places/Kesh Tor" }),
                json!({ "kind": "proposal", "change": "edit", "path": PAGE }),
                json!({ "kind": "text", "delta": "Done.\n" }),
            ]
        );
        let saved = fixture.saved_proposals(conversation);
        let contents: Vec<&ProposalContent> = saved[0]
            .proposals
            .iter()
            .map(|proposal| &proposal.content)
            .collect();
        assert_eq!(
            contents,
            [
                &ProposalContent::NewPage {
                    text: "# Kesh Tor\nA hill fort.".to_owned()
                },
                &ProposalContent::Edit {
                    passages: vec![Passage {
                        find: "A port town.".to_owned(),
                        replace: "A fishing town.".to_owned()
                    }],
                    base: Some(proposals::text_hash(SALTMERE)),
                },
            ]
        );
        let answer = saved[0].answer;
        assert_eq!(fixture.reviewed(conversation, answer).proposals.len(), 2);

        fixture.reopen_world();
        let rejected = fixture.reviewed(conversation, answer).proposals[1].id;
        fixture.reject(rejected).unwrap();

        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Pending, false),
                (ProposalState::Rejected, false)
            ]
        );
        assert_eq!(review.proposals[1].check, None);
        assert_eq!(
            fixture.reject(rejected).unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert_eq!(fixture.files(), files);
        assert_eq!(fixture.changes(), []);
    }

    #[test]
    fn review_diffs_each_pending_proposal_against_its_page_as_it_is_now() {
        let text = format!(
            "{}{TO_FISHING}<edit path=\"Places/Later.md\">\n<find>Soon.</find>\n\
             <replace>Now.</replace>\n</edit>\n<edit path=\"Places/Same.md\">\n\
             <find>Same.</find>\n<replace>Same.</replace>\n</edit>\n",
            KESH_TOR.replace("Places/Kesh Tor", "Places/Kesh Tor.md")
        );
        let fixture = Fixture::new(answering(&text));
        fixture.add_pages(&[("Places/Same.md", "Same.\n")]);
        let (conversation, answer) = fixture.ask(None);
        let check = |index: usize| {
            let review = fixture.reviewed(conversation, answer);
            serde_json::to_value(&review.proposals[index].check).unwrap()
        };
        let version = |path: &str| {
            let session = fixture.services.world().current().unwrap().session;
            let page = fixture.services.world().page_in(session, path).unwrap();
            page.1.version
        };

        assert_eq!(
            check(0),
            json!({ "state": "applies", "version": null, "changed": false, "lines": [
                { "kind": "added", "text": "# Kesh Tor" },
                { "kind": "added", "text": "A hill fort." },
            ] })
        );
        assert_eq!(
            check(1),
            json!({ "state": "applies", "version": version(PAGE), "changed": false, "lines": [
                { "kind": "same", "text": "# Saltmere" },
                { "kind": "removed", "text": "A port town." },
                { "kind": "added", "text": "A fishing town." },
            ] })
        );
        let no_longer = |reason: &str| json!({ "state": "no_longer_applies", "reason": reason });
        assert_eq!(check(2), no_longer("The page does not exist."));
        assert_eq!(check(3), no_longer("The edit makes no change to the page."));

        fs::write(fixture.world.path().join("Places/kesh tor.md"), "").unwrap();
        fs::write(
            fixture.world.path().join(PAGE),
            "# Saltmere\nA port town.\nOld.\n",
        )
        .unwrap();
        fs::write(fixture.world.path().join("Places/Later.md"), "Soon.\n").unwrap();

        assert_eq!(
            check(0),
            no_longer("Something with this name already exists here. Letter case does not count.")
        );
        assert_eq!(check(1)["changed"], json!(true));
        assert_eq!(check(1)["version"], json!(version(PAGE)));
        // A page that did not exist when the answer ended has no hash to compare with.
        assert_eq!(check(2)["state"], json!("applies"));
        assert_eq!(check(2)["changed"], json!(true));
        let pages: Vec<Option<String>> = fixture
            .reviewed(conversation, answer)
            .proposals
            .into_iter()
            .map(|proposal| proposal.page)
            .collect();
        assert_eq!(
            pages,
            [
                Some("Places/kesh tor.md".to_owned()),
                Some(PAGE.to_owned()),
                Some("Places/Later.md".to_owned()),
                Some("Places/Same.md".to_owned()),
            ]
        );
    }

    #[test]
    fn a_path_in_another_letter_case_or_without_md_names_the_page_on_disk_and_is_written_there() {
        let first = "<edit path=\"places/saltmere\">\n<find>A port town.</find>\n\
                     <replace>A fishing town.</replace>\n</edit>\n\
                     <new_page path=\"Places/Bell\">\nThe bell.\n</new_page>\n\
                     <new_page path=\"../Bell\">\nOut.\n</new_page>\n";
        let second = "<edit path=\"PLACES/saltmere.md\">\n<find>A fishing town.</find>\n\
                      <replace>A port.</replace>\n</edit>\n";
        let third = "<edit path=\"places/Saltmere\">\n<find>A harbour.</find>\n\
                     <replace>A port.</replace>\n</edit>\n";
        let fixture = Fixture::new(answering_in_turn(&[first, second, third]));
        let (conversation, answer) = fixture.ask(None);
        let pages = |answer: i64| -> Vec<(String, Option<String>)> {
            let review = fixture.reviewed(conversation, answer);
            let proposals = review.proposals.into_iter();
            proposals
                .map(|proposal| (proposal.path, proposal.page))
                .collect()
        };
        let page = |path: &str| Some(path.to_owned());
        assert_eq!(
            pages(answer),
            [
                ("places/saltmere".to_owned(), page(PAGE)),
                ("Places/Bell".to_owned(), None),
                ("../Bell".to_owned(), None),
            ]
        );
        let review = fixture.reviewed(conversation, answer);

        let accepted = fixture
            .accept(answer, review.proposals[..2].iter().map(chosen).collect())
            .unwrap();

        let written: Vec<&str> = accepted
            .written
            .iter()
            .map(|page| page.path.as_str())
            .collect();
        assert_eq!(written, [PAGE, "Places/Bell.md"]);
        assert_eq!(fixture.read(PAGE), FISHING);
        assert_eq!(fixture.read("Places/Bell.md"), "The bell.");
        assert_eq!(
            pages(answer),
            [
                (PAGE.to_owned(), page(PAGE)),
                ("Places/Bell.md".to_owned(), page("Places/Bell.md")),
                ("../Bell".to_owned(), None),
            ]
        );

        let (_, rejected) = fixture.ask(Some(conversation));
        let proposal = fixture.reviewed(conversation, rejected).proposals[0].id;
        fixture.reject(proposal).unwrap();
        let (_, missing) = fixture.ask(Some(conversation));

        assert_eq!(pages(rejected)[0].1, page(PAGE));
        assert_eq!(pages(missing)[0].1, page(PAGE));
        assert_eq!(
            fixture.reviewed(conversation, missing).proposals[0].check,
            Some(ProposalCheck::NoLongerApplies {
                reason: "A passage of the edit is not in the page.".to_owned()
            })
        );
    }

    #[test]
    fn a_new_page_whose_path_is_taken_in_another_letter_case_names_that_page_and_no_longer_applies()
    {
        let fixture = Fixture::new(answering(
            "<new_page path=\"places/saltmere\">\n# Saltmere\n</new_page>\n",
        ));
        let (conversation, answer) = fixture.ask(None);

        let review = fixture.reviewed(conversation, answer);

        assert_eq!(review.proposals[0].page.as_deref(), Some(PAGE));
        assert_eq!(
            review.proposals[0].check,
            Some(ProposalCheck::NoLongerApplies {
                reason: "Something with this name already exists here. Letter case does not count."
                    .to_owned()
            })
        );
    }

    #[test]
    fn an_accept_writes_its_proposals_as_one_change_that_survives_reopening_and_undoes_whole() {
        let fixture = Fixture::new(answering(&proposing()));
        let (conversation, answer) = fixture.ask(None);
        let files = fixture.files();
        let review = fixture.reviewed(conversation, answer);
        let mut stale: Vec<ProposalVersion> = review.proposals.iter().map(chosen).collect();
        stale[1].version = Some("0-0".to_owned());

        let refused = fixture.accept(answer, stale).unwrap_err();

        assert_eq!(refused.kind, ErrorKind::Conflict);
        assert_eq!(fixture.files(), files);
        assert_eq!(fixture.changes(), []);
        assert_eq!(
            fixture.accept(answer, Vec::new()).unwrap_err().kind,
            ErrorKind::Conflict
        );

        let accepted = fixture.accept_all(conversation, answer);

        let set = accepted.set.unwrap();
        assert_eq!((accepted.accepted, accepted.of), (2, 2));
        assert_eq!((accepted.failure, accepted.undo), (None, true));
        let written: Vec<(&str, &str)> = accepted
            .written
            .iter()
            .map(|page| (page.path.as_str(), page.text.as_str()))
            .collect();
        assert_eq!(
            written,
            [
                ("Places/Kesh Tor.md", "# Kesh Tor\nA hill fort."),
                (PAGE, FISHING)
            ]
        );
        assert_eq!(fixture.read(PAGE), FISHING);
        let change = vec!["Places/Kesh Tor.md".to_owned(), PAGE.to_owned()];
        assert_eq!(
            fixture.changes(),
            [("accepted".to_owned(), false, change.clone())]
        );

        fixture.reopen_world();
        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Accepted, false)
            ]
        );
        assert_eq!(review.accepted[0].id, set);
        assert_eq!(accepted_sets(&review), [(2, true)]);

        let undone = fixture.undo(set).unwrap();

        assert_eq!(undone.deleted, ["Places/Kesh Tor.md"]);
        let restored: Vec<(&str, &str)> = undone
            .restored
            .iter()
            .map(|page| (page.path.as_str(), page.text.as_str()))
            .collect();
        assert_eq!(restored, [(PAGE, SALTMERE)]);
        assert_eq!(fixture.files(), files);
        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Pending, true),
                (ProposalState::Pending, true)
            ]
        );
        assert_eq!(accepted_sets(&review), []);
        assert_eq!(fixture.undo(set).unwrap_err().kind, ErrorKind::NotFound);

        // Undone proposals can be accepted again; an undo after the page changed writes nothing.
        let again = fixture.accept_all(conversation, answer).set.unwrap();
        fs::write(fixture.world.path().join(PAGE), "# Saltmere\nMine.\n").unwrap();
        let files = fixture.files();

        let refused = fixture.undo(again).unwrap_err();

        assert_eq!(refused.kind, ErrorKind::Conflict);
        assert!(
            refused.message.starts_with("“Saltmere” changed"),
            "{refused:?}"
        );
        assert_eq!(fixture.files(), files);
        assert_eq!(
            accepted_sets(&fixture.reviewed(conversation, answer)),
            [(2, true)]
        );
    }

    /// A fixture whose answer edits `PAGE` and then `Places/Tor.md`.
    fn two_edits() -> Fixture {
        let text = format!(
            "{TO_FISHING}<edit path=\"Places/Tor.md\">\n<find>A hill.</find>\n\
             <replace>A fort.</replace>\n</edit>\n"
        );
        let fixture = Fixture::new(answering(&text));
        fixture.add_pages(&[("Places/Tor.md", "A hill.\n")]);
        fixture
    }

    fn set_read_only(path: &Path, read_only: bool) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(read_only);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn a_write_that_fails_partway_keeps_the_proposals_written_before_it() {
        let fixture = two_edits();
        let (conversation, answer) = fixture.ask(None);
        let review = fixture.reviewed(conversation, answer);
        let tor = fixture.world.path().join("Places/Tor.md");
        set_read_only(&tor, true);

        let accepted = fixture.accept(answer, review.proposals.iter().map(chosen).collect());

        set_read_only(&tor, false);
        let accepted = accepted.unwrap();
        assert_eq!((accepted.accepted, accepted.of), (1, 2));
        assert_eq!(
            accepted.failure,
            Some(AcceptFailure {
                proposal: review.proposals[1].id,
                message: "The page is read-only.".to_owned()
            })
        );
        assert_eq!(fixture.read(PAGE), FISHING);
        assert_eq!(fixture.read("Places/Tor.md"), "A hill.\n");
        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Pending, false)
            ]
        );
        assert_eq!(review.proposals[1].accept, None);
        assert_eq!(accepted_sets(&review), [(1, true)]);
        assert_eq!(
            fixture.changes(),
            [("accepted".to_owned(), false, vec![PAGE.to_owned()])]
        );
    }

    #[test]
    fn an_undo_that_fails_partway_is_rolled_back_and_leaves_its_proposals_accepted() {
        let fixture = two_edits();
        let (conversation, answer) = fixture.ask(None);
        let set = fixture.accept_all(conversation, answer).set.unwrap();
        let files = fixture.files();
        let tor = fixture.world.path().join("Places/Tor.md");
        set_read_only(&tor, true);

        let refused = fixture.undo(set);

        set_read_only(&tor, false);
        assert_eq!(refused.unwrap_err().message, "The page is read-only.");
        assert_eq!(fixture.files(), files);
        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Accepted, false)
            ]
        );
        assert_eq!(accepted_sets(&review), [(2, true)]);
        let kinds: Vec<String> = fixture
            .changes()
            .into_iter()
            .map(|change| change.0)
            .collect();
        assert_eq!(kinds, ["accepted"]);
    }

    #[test]
    fn proposals_whose_paths_break_the_rules_are_kept_with_their_reason_and_never_written() {
        #[cfg_attr(not(unix), allow(unused_mut, clippy::useless_vec))]
        let mut paths = vec!["../x", "/abs", "Map.png", ".hidden/x"];
        #[cfg(unix)]
        paths.push("Elsewhere/x");
        let text: String = paths
            .iter()
            .map(|path| format!("<new_page path=\"{path}\">\nLore.\n</new_page>\n"))
            .collect();
        let fixture = Fixture::new(answering(&text));
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), fixture.world.path().join("Elsewhere")).unwrap();
        let (conversation, answer) = fixture.ask(None);
        let files = fixture.files();

        let review = fixture.reviewed(conversation, answer);

        let leads_out = "The path leads outside the world, or through a hidden or linked folder.";
        let expected = [
            "The path leads out of its folder with . or ..",
            "The path starts at the top of the disk, not of the world.",
            "The path names a file that is not a Markdown page.",
            leads_out,
            leads_out,
        ];
        for (proposal, reason) in review.proposals.iter().zip(expected) {
            assert_eq!(
                (&proposal.page, &proposal.check),
                (
                    &None,
                    &Some(ProposalCheck::NoLongerApplies {
                        reason: reason.to_owned()
                    })
                ),
                "{}",
                proposal.path
            );
            let chosen = vec![ProposalVersion {
                id: proposal.id,
                version: None,
            }];
            let refused = fixture.accept(answer, chosen).unwrap_err();
            assert_eq!(
                (refused.kind, refused.message.as_str()),
                (ErrorKind::Conflict, reason)
            );
        }
        assert_eq!(review.proposals.len(), paths.len());
        assert_eq!(fixture.files(), files);
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(fixture.changes(), []);
    }

    #[test]
    fn without_history_an_accept_still_writes_offers_no_undo_and_a_stop_resolves_from_the_files() {
        let fixture = Fixture::new(answering(&proposing()));
        let history = history_testing::file(fixture.app_data.path(), fixture.world.path());
        let connection = rusqlite::Connection::open(history).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        fixture.reopen_world();
        let (conversation, answer) = fixture.ask(None);

        let accepted = fixture.accept_all(conversation, answer);

        assert_eq!((accepted.accepted, accepted.undo), (2, false));
        assert_eq!(fixture.read(PAGE), FISHING);
        let review = fixture.reviewed(conversation, answer);
        assert_eq!(accepted_sets(&review), [(2, false)]);

        // What a stop between the writes and the accept's finish leaves in the store.
        fixture
            .store_file()
            .execute_batch(
                "UPDATE proposals SET state = 'pending' WHERE accept IS NOT NULL;
                 UPDATE accepts SET state = 'writing';",
            )
            .unwrap();
        fixture.reopen_world();

        let review = fixture.reviewed(conversation, answer);
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Accepted, false)
            ]
        );
        assert_eq!(accepted_sets(&review), [(2, false)]);
    }

    #[test]
    fn the_next_request_carries_each_earlier_proposal_as_a_line_with_its_outcome() {
        // An answer made only of proposals still goes back to the model.
        let fixture = Fixture::new(answering(&format!("{KESH_TOR}{TO_FISHING}")));
        let (conversation, answer) = fixture.ask(None);
        let review = fixture.reviewed(conversation, answer);
        fixture
            .accept(answer, vec![chosen(&review.proposals[0])])
            .unwrap();

        fixture
            .send(Some(conversation), "And now?", None)
            .0
            .unwrap();

        let body = fixture.bodies().pop().unwrap();
        assert_eq!(
            body["messages"][2],
            json!({
                "role": "assistant",
                "content": "[Proposed new page \"Places/Kesh Tor.md\": accepted]\n\
                            [Proposed edit of \"Places/Saltmere.md\": pending]",
            })
        );
    }

    #[test]
    fn retry_is_refused_while_an_accept_of_the_answer_runs_and_once_it_accepted() {
        let fixture = Fixture::new(stalling(&proposing()));
        let (handle, events) = fixture.start(None, "Write it", None, false);
        wait_until("the answer", || events.lock().unwrap().len() == 5);
        fixture.stop().unwrap();
        let end = handle.join().unwrap().unwrap();
        let (conversation, answer) = (conversation_of(&end), answer_of(&end).unwrap());
        let review = fixture.reviewed(conversation, answer);
        let first = vec![chosen(&review.proposals[0])];
        let (reached, release) = fixture.pause_at(Step::AcceptWritten);
        let accepting = fixture.in_thread(move |services| accept(services, answer, first));
        reached.recv_timeout(WAIT).unwrap();

        assert_eq!(kind(fixture.retry(conversation)), ErrorKind::Conflict);

        release.send(()).unwrap();
        assert_eq!(accepting.join().unwrap().unwrap().accepted, 1);
        *fixture.assistant().hook.lock().unwrap() = None;
        assert_eq!(kind(fixture.retry(conversation)), ErrorKind::Conflict);
        assert_eq!(fixture.server.requests().len(), 1);
    }

    #[test]
    fn a_review_while_an_accept_or_undo_finishes_neither_fails_nor_settles_its_set() {
        let fixture = Fixture::new(answering(&proposing()));
        let (conversation, answer) = fixture.ask(None);
        let review = fixture.reviewed(conversation, answer);
        let all: Vec<ProposalVersion> = review.proposals.iter().map(chosen).collect();
        let (reached, release) = fixture.pause_at(Step::AcceptWritten);
        let accepting = fixture.in_thread(move |services| accept(services, answer, all));
        reached.recv_timeout(WAIT).unwrap();

        let during = fixture.reviewed(conversation, answer);

        assert!(
            during.proposals.iter().all(|proposal| {
                proposal.state == ProposalState::Pending && proposal.accept.is_some()
            }),
            "{during:?}"
        );
        assert_eq!(accepted_sets(&during), []);
        release.send(()).unwrap();
        let accepted = accepting.join().unwrap().unwrap();
        assert_eq!(accepted.written.len(), 2);
        let after = fixture.reviewed(conversation, answer);
        assert_eq!(accepted_sets(&after), [(2, true)]);

        let set = accepted.set.unwrap();
        let (reached, release) = fixture.pause_at(Step::UndoWritten);
        let undoing = fixture.in_thread(move |services| undo(services, set));
        reached.recv_timeout(WAIT).unwrap();

        let during = fixture.reviewed(conversation, answer);

        assert_eq!(
            states(&during),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Accepted, false)
            ]
        );
        assert_eq!(accepted_sets(&during), []);
        release.send(()).unwrap();
        assert_eq!(undoing.join().unwrap().unwrap().deleted.len(), 1);
        assert_eq!(
            states(&fixture.reviewed(conversation, answer)),
            [
                (ProposalState::Pending, true),
                (ProposalState::Pending, true)
            ]
        );
    }

    #[test]
    fn a_proposal_rejected_after_an_accept_checked_it_stops_the_accept_before_anything_is_written()
    {
        let fixture = Fixture::new(answering(&proposing()));
        let (conversation, answer) = fixture.ask(None);
        let review = fixture.reviewed(conversation, answer);
        let all: Vec<ProposalVersion> = review.proposals.iter().map(chosen).collect();
        let files = fixture.files();
        let (reached, release) = fixture.pause_at(Step::AcceptChecked);
        let accepting = fixture.in_thread(move |services| accept(services, answer, all));
        reached.recv_timeout(WAIT).unwrap();

        fixture.reject(review.proposals[1].id).unwrap();

        release.send(()).unwrap();
        let refused = accepting.join().unwrap().unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Conflict);
        assert_eq!(fixture.files(), files);
        assert_eq!(fixture.changes(), []);
        assert_eq!(
            states(&fixture.reviewed(conversation, answer)),
            [
                (ProposalState::Pending, false),
                (ProposalState::Rejected, false)
            ]
        );
    }

    /// The new page and the edit an answer of `bell_and_edit` proposes, and what an accept of them
    /// writes: the new page's proposal names its folder in another letter case than the folder on
    /// disk.
    const BELL: &str = "<new_page path=\"places/Bell\">\nThe bell.\n</new_page>\n";
    const BELL_PATH: &str = "Places/Bell.md";

    /// Begins a change of `kind` with `entries` in the world's history, through a connection of
    /// its own, and leaves it pending, as a stop after its first write does.
    fn begin_change(fixture: &Fixture, kind: Kind, entries: &[Entry]) -> HistoryChange {
        let started = now() as u64;
        let opened = History::open(
            fixture.app_data.path(),
            fixture.world.path(),
            started,
            |_| State::Absent,
        );
        let mut history = opened.history.unwrap();
        let record = history.begin(kind, entries, started).unwrap();
        HistoryChange {
            id: record.change(),
            started,
        }
    }

    fn entry(path: &str, before: State, after: State) -> Entry {
        Entry {
            path: path.to_owned(),
            before,
            after,
        }
    }

    fn page(text: &str) -> State {
        State::Page(text.as_bytes().to_vec())
    }

    #[test]
    fn after_a_stop_mid_accept_reopening_resolves_its_proposals_from_the_pages_written() {
        let fixture = Fixture::new(answering(&format!("{BELL}{TO_FISHING}")));
        let (conversation, answer) = fixture.ask(None);
        let ids: Vec<i64> = fixture
            .reviewed(conversation, answer)
            .proposals
            .iter()
            .map(|p| p.id)
            .collect();
        let change = begin_change(
            &fixture,
            Kind::Accepted,
            &[
                entry(BELL_PATH, State::Absent, page("The bell.")),
                entry(PAGE, page(SALTMERE), page(FISHING)),
            ],
        );
        fs::write(fixture.world.path().join(BELL_PATH), "The bell.").unwrap();
        let mut store =
            Store::open(Some(fixture.app_data.path()), fixture.world.path(), 1).unwrap();
        let pages = [
            SetPage {
                proposal: ids[0],
                path: BELL_PATH.to_owned(),
                result: proposals::text_hash("The bell."),
            },
            SetPage {
                proposal: ids[1],
                path: PAGE.to_owned(),
                result: proposals::text_hash(FISHING),
            },
        ];
        store.begin_accept(answer, &pages, Some(change), 1).unwrap();
        drop(store);
        let files = fixture.files();

        fixture.reopen_world();
        let review = fixture.reviewed(conversation, answer);

        assert_eq!(
            fixture.changes(),
            [("accepted".to_owned(), false, vec![BELL_PATH.to_owned()])]
        );
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Pending, false)
            ]
        );
        assert_eq!(review.proposals[0].page.as_deref(), Some(BELL_PATH));
        assert_eq!(review.proposals[1].accept, None);
        assert_eq!(accepted_sets(&review), [(1, true)]);
        assert_eq!(fixture.files(), files);
    }

    #[test]
    fn after_a_stop_mid_undo_reopening_resolves_each_proposal_from_its_page() {
        let fixture = Fixture::new(answering(&format!("{BELL}{TO_FISHING}")));
        let (conversation, answer) = fixture.ask(None);
        let set = fixture.accept_all(conversation, answer).set.unwrap();
        let undo = begin_change(
            &fixture,
            Kind::Undo,
            &[
                entry(BELL_PATH, page("The bell."), State::Absent),
                entry(PAGE, page(FISHING), page(SALTMERE)),
            ],
        );
        fs::write(fixture.world.path().join(PAGE), SALTMERE).unwrap();
        let mut store =
            Store::open(Some(fixture.app_data.path()), fixture.world.path(), 1).unwrap();
        store.begin_undo(set).unwrap();
        drop(store);
        let files = fixture.files();

        fixture.reopen_world();
        let review = fixture.reviewed(conversation, answer);

        let changes = fixture.changes();
        assert_eq!(
            changes[1],
            ("undo".to_owned(), false, vec![PAGE.to_owned()])
        );
        assert_eq!(changes.len(), 2, "{changes:?} after the undo {undo:?}");
        assert_eq!(
            states(&review),
            [
                (ProposalState::Accepted, false),
                (ProposalState::Pending, true)
            ]
        );
        assert_eq!(accepted_sets(&review), [(1, true)]);
        assert_eq!(fixture.files(), files);
    }

    /// Begins an accept of `answer`'s only proposal, `BELL`, through a store of its own, and leaves
    /// it unfinished, as a stop before the accept wrote anything does.
    fn leave_bell_accept_unfinished(fixture: &Fixture, conversation: i64, answer: i64) {
        let proposal = fixture.reviewed(conversation, answer).proposals[0].id;
        let mut store =
            Store::open(Some(fixture.app_data.path()), fixture.world.path(), 1).unwrap();
        let pages = [SetPage {
            proposal,
            path: BELL_PATH.to_owned(),
            result: proposals::text_hash("The bell."),
        }];
        store.begin_accept(answer, &pages, None, 1).unwrap();
    }

    #[test]
    fn reopening_settles_an_unfinished_accept_whose_page_is_not_utf8_as_not_holding_its_result() {
        let fixture = Fixture::new(answering(BELL));
        let (conversation, answer) = fixture.ask(None);
        leave_bell_accept_unfinished(&fixture, conversation, answer);
        fs::write(fixture.world.path().join(BELL_PATH), [0xff, 0xfe, 0x00]).unwrap();

        fixture.reopen_world();
        let review = fixture.reviewed(conversation, answer);

        assert_eq!(states(&review), [(ProposalState::Pending, false)]);
        assert_eq!(review.proposals[0].accept, None);
    }

    #[test]
    fn a_retry_settles_an_accept_an_earlier_opening_left_unfinished_instead_of_refusing() {
        let fixture = Fixture::new(answering(BELL));
        let (conversation, answer) = fixture.ask(None);
        fixture
            .store_file()
            .execute(
                "UPDATE messages SET state = 'stopped' WHERE id = ?1",
                [answer],
            )
            .unwrap();
        leave_bell_accept_unfinished(&fixture, conversation, answer);
        fixture.reopen_world();

        let retried = fixture.retry(conversation).unwrap();

        assert!(matches!(retried, AnswerEnd::Complete { .. }), "{retried:?}");
        assert_eq!(fixture.server.requests().len(), 2);
    }

    const OPEN_AT_END: &str = "Start.\n<new_page path=\"A.md\">\nWhole.\n</new_page>\n\
                               <edit path=\"Places/Saltmere.md\">\n<find>A port";

    #[test]
    fn a_stopped_cut_off_or_failed_answer_keeps_its_complete_proposals_and_drops_the_open_one() {
        // Past the core's bound of 1 MiB, in events that each stay within the bound on a line.
        let filler = delta(&"x".repeat(100_000)).repeat(11);
        let cut_off = format!("{}{filler}data: [DONE]\n\n", delta(OPEN_AT_END));
        let cases = [
            ("stopped", stalling(OPEN_AT_END)),
            (
                "cut off",
                Server::answering(answer(
                    "200 OK",
                    &[("Content-Type", "text/event-stream")],
                    cut_off.as_bytes(),
                )),
            ),
            (
                "failed",
                Server::streaming(vec![stream_head(), delta(OPEN_AT_END).into_bytes()], false),
            ),
        ];
        for (case, server) in cases {
            let fixture = Fixture::new(server);
            let end = if case == "stopped" {
                let (handle, events) = fixture.start(None, "Write it", None, false);
                wait_until("the proposals", || events.lock().unwrap().len() == 4);
                fixture.stop().unwrap();
                handle.join().unwrap()
            } else {
                fixture.send(None, "Write it", None).0
            };

            let end = end.unwrap();
            let conversation = conversation_of(&end);
            let saved = fixture.saved_proposals(conversation);
            assert_eq!(saved.len(), 1, "{case}");
            assert_eq!(Some(saved[0].answer), answer_of(&end), "{case}");
            assert_eq!(
                (saved[0].unfinished, saved[0].unreadable),
                (true, 0),
                "{case}"
            );
            let paths: Vec<&str> = saved[0].proposals.iter().map(|p| p.path.as_str()).collect();
            assert_eq!(paths, ["A.md"], "{case}");
            assert_eq!(fixture.stored(conversation)[1].text, "Start.\n", "{case}");
        }
    }

    #[test]
    fn a_failed_answer_of_only_a_proposal_keeps_it_and_a_malformed_one_is_noted() {
        let only = "<new_page path=\"A.md\">\nWhole.\n</new_page>\n";
        let fixture = Fixture::new(Server::streaming(
            vec![stream_head(), delta(only).into_bytes()],
            false,
        ));

        let end = fixture.send(None, "Write it", None).0.unwrap();

        let conversation = conversation_of(&end);
        assert!(
            matches!(&end, AnswerEnd::Failed { text, answer: Some(_), .. } if text.is_empty()),
            "{end:?}"
        );
        let saved = fixture.saved_proposals(conversation);
        assert_eq!(saved[0].proposals.len(), 1);
        assert_eq!(
            fixture.stored(conversation)[1].answer,
            Some(AnswerState::Stopped)
        );

        let fixture = Fixture::new(answering("Hi.\n<edit path=\"A.md\">\nNo pair.\n</edit>\n"));
        let (conversation, answer) = fixture.ask(None);

        assert_eq!(
            fixture.review(conversation).unwrap(),
            [AnswerReview {
                answer,
                unreadable: 1,
                unfinished: false,
                proposals: Vec::new(),
                accepted: Vec::new(),
            }]
        );
    }

    /// Asks the provider in `GRIMOIRE_TEST_BASE_URL`, `GRIMOIRE_TEST_MODEL` and
    /// `GRIMOIRE_TEST_API_KEY`, with the real instructions, to create a page and change a sentence
    /// of another, and checks that the answer holds a proposal that can be read. Nothing it prints
    /// holds the key. Run by name only.
    #[test]
    #[ignore = "sends a request to a real provider"]
    fn real_provider_proposes() {
        // A variable's error can show its value, so it is never printed.
        let variable =
            |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let base_url = providers::BaseUrl::parse(&variable("GRIMOIRE_TEST_BASE_URL")).unwrap();
        let model = variable("GRIMOIRE_TEST_MODEL");
        let key = variable("GRIMOIRE_TEST_API_KEY");
        let context = context::Context {
            pages: vec![context::ChosenPage {
                path: PAGE.to_owned(),
                text: "# Saltmere\nSaltmere is a port town on the marsh.\n".to_owned(),
                partial: false,
            }],
            indexing: false,
        };
        let request = request::build(
            "Kesh",
            &context,
            &[],
            "Write a new page for Kesh Tor, a hill fort near Saltmere, and change the sentence on \
             the Saltmere page to say that it is a fishing town.",
        );
        let mut text = String::new();

        let end = block_on(providers::chat_stream(
            &base_url,
            &model,
            Some(&key),
            &request.messages,
            providers::READ_TIMEOUT,
            |piece| text.push_str(piece),
        ));

        // The end is compared, not printed, because a failure's message could hold the key.
        assert!(end == StreamEnd::Complete, "the answer did not complete");
        assert!(!text.contains(&key), "the answer holds the key");
        let parsed = proposals::parse(&text, true);
        assert!(
            !parsed.proposals.is_empty(),
            "no proposal could be read; {} blocks could not",
            parsed.unreadable
        );
    }
}
