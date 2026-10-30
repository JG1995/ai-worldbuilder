import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "../ui/theme.css";
import { SampleWorldScreen } from "./SampleWorldScreen";
import { Showcase } from "./Showcase";

/** Shows the composed sample screen while the location hash is #sample-world. */
function ShowcaseRoot() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return hash === "#sample-world" ? <SampleWorldScreen /> : <Showcase />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ShowcaseRoot />
  </React.StrictMode>,
);
