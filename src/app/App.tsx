import { useEffect, useState } from "react";
import { type IpcError, invokeCommand } from "../lib/ipc";
import { Icon } from "../ui/Icon";

type AppInfo = { name: string; version: string };

type VersionState =
  | { status: "loading" }
  | { status: "ready"; version: string }
  | { status: "failed"; message: string };

export function App() {
  const [versionState, setVersionState] = useState<VersionState>({ status: "loading" });

  useEffect(() => {
    let current = true;
    invokeCommand<AppInfo>("app_info").then(
      (info) => current && setVersionState({ status: "ready", version: info.version }),
      (error: IpcError) => current && setVersionState({ status: "failed", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <main className="flex flex-col items-start gap-4 p-12">
      <h1 className="page-title">Grimoire.md</h1>
      {versionState.status === "ready" && (
        <p className="ui text-text-muted">Version {versionState.version}</p>
      )}
      {versionState.status === "failed" && (
        <p role="alert" className="ui flex items-center gap-2 text-error">
          <Icon name="error" />
          The version could not be read: {versionState.message}
        </p>
      )}
      {import.meta.env.DEV && (
        <a href="/showcase.html" className="ui text-accent underline">
          Showcase
        </a>
      )}
    </main>
  );
}
