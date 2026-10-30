import React from "react";
import ReactDOM from "react-dom/client";
import "../ui/theme.css";
import { Showcase } from "./Showcase";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Showcase />
  </React.StrictMode>,
);
