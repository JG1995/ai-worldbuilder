import { useState } from "react";
import { ControlsSections } from "./ControlsSections";
import { FoundationSections } from "./FoundationSections";
import { ShellSections } from "./ShellSections";
import { SurfaceSections } from "./SurfaceSections";

type Mode = "os" | "dark" | "light";

const modes: { value: Mode; label: string }[] = [
  { value: "os", label: "OS" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** The OS, dark and light switch. It starts from the mode the other showcase view set. */
export function ModeSwitch() {
  const [mode, setMode] = useState<Mode>(
    () => (document.documentElement.dataset.theme as Mode | undefined) ?? "os",
  );

  function chooseMode(next: Mode) {
    // Set before rendering, so the sections read the new mode's token values.
    if (next === "os") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    setMode(next);
  }

  return (
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
  );
}

/** The development-only showcase of the design foundation. It stores nothing. */
export function Showcase() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-6 border-divider border-b bg-window px-6 py-3">
        <h1 className="ui-strong">Grimoire.md showcase</h1>
        <span className="label-caps text-text-muted">Sample data</span>
        <ModeSwitch />
        <a href="#sample-world" className="ui ml-auto text-accent underline">
          Sample world screen
        </a>
        <a href="/" className="ui text-accent underline">
          Back to the app
        </a>
      </header>
      <main className="px-6">
        <FoundationSections />
        <ControlsSections />
        <SurfaceSections />
        <ShellSections />
      </main>
    </div>
  );
}
