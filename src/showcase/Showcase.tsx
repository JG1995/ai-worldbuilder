import { useState } from "react";
import { ControlsSections } from "./ControlsSections";
import { FoundationSections } from "./FoundationSections";

type Mode = "os" | "dark" | "light";

const modes: { value: Mode; label: string }[] = [
  { value: "os", label: "OS" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** The development-only showcase of the design foundation. It stores nothing. */
export function Showcase() {
  const [mode, setMode] = useState<Mode>("os");

  function chooseMode(next: Mode) {
    // Set before rendering, so the sections read the new mode's token values.
    if (next === "os") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    setMode(next);
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-6 border-divider border-b bg-window px-6 py-3">
        <h1 className="ui-strong">Grimoire.md showcase</h1>
        <span className="label-caps text-text-muted">Sample data</span>
        <fieldset className="ui flex items-center gap-4">
          <legend className="sr-only">Colour mode</legend>
          {modes.map((option) => (
            <label key={option.value} className="flex items-center gap-1">
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => chooseMode(option.value)}
                className="accent-accent"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <a href="/" className="ui ml-auto text-accent underline">
          Back to the app
        </a>
      </header>
      <main className="px-6">
        <FoundationSections />
        <ControlsSections />
      </main>
    </div>
  );
}
