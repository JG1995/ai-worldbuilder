import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { applySavedTheme } from "@/features/settings/logic/saved-theme";
import "@/ui/theme.css";

// Nothing renders before the saved theme applies, so no text, logo or control shows in another.
await applySavedTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
