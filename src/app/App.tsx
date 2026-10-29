import { useEffect, useState } from "react";
import { type IpcError, invokeCommand } from "../lib/ipc";

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
    <main>
      <h1>Grimoire.md</h1>
      {versionState.status === "ready" && <p>Version {versionState.version}</p>}
      {versionState.status === "failed" && (
        <p role="alert">The version could not be read: {versionState.message}</p>
      )}
    </main>
  );
}
