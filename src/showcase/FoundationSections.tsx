import type { ReactNode } from "react";
import { Icon, type IconName } from "@/ui/Icon";
import { glyphs } from "@/ui/icon-glyphs";
import { StackedLockup } from "@/ui/StackedLockup";
import {
  sampleBody,
  sampleCode,
  sampleHeading,
  sampleLabel,
  samplePageTitle,
  sampleWorldName,
} from "./sample-data";

// Class names are written out in full so that Tailwind generates them.
const colourRoles = [
  { name: "window", use: "App frame: sidebars, tab strip", swatch: "bg-window" },
  { name: "page", use: "Reading and editing canvas", swatch: "bg-page" },
  { name: "raised", use: "Menus, dialogs, popovers, input fills", swatch: "bg-raised" },
  { name: "hover", use: "Hovered rows and ghost buttons", swatch: "bg-hover" },
  { name: "selected", use: "Selected row, active tab, welcome ground", swatch: "bg-selected" },
  { name: "divider", use: "Decorative separators only", swatch: "bg-divider" },
  { name: "outline", use: "Control boundaries", swatch: "bg-outline" },
  { name: "text", use: "Body text", swatch: "bg-text" },
  { name: "text-muted", use: "Chrome text, secondary text", swatch: "bg-text-muted" },
  { name: "text-disabled", use: "Disabled controls", swatch: "bg-text-disabled" },
  { name: "accent", use: "Links, active-location line, focus", swatch: "bg-accent" },
  { name: "accent-hover", use: "Primary button hover", swatch: "bg-accent-hover" },
  { name: "on-accent", use: "Text on accent fills", swatch: "bg-on-accent" },
  { name: "selection", use: "Text selection", swatch: "bg-selection" },
  { name: "success", use: "Saved, accepted, added", swatch: "bg-success" },
  { name: "warning", use: "Changed on disk, conflicts", swatch: "bg-warning" },
  { name: "error", use: "Failures, destructive actions", swatch: "bg-error" },
  { name: "info", use: "Neutral notices", swatch: "bg-info" },
  { name: "on-status", use: "Text on status fills", swatch: "bg-on-status" },
  { name: "diff-added", use: "Added diff lines", swatch: "bg-diff-added" },
  { name: "diff-removed", use: "Removed diff lines", swatch: "bg-diff-removed" },
];

const typeRoles = [
  { name: "page-title", use: "Page titles", className: "page-title", sample: samplePageTitle },
  {
    name: "world-name",
    use: "World name in the tree",
    className: "world-name",
    sample: sampleWorldName,
  },
  {
    name: "label-caps",
    use: "Short pane and section labels",
    className: "label-caps",
    sample: sampleLabel,
  },
  { name: "heading-4", use: "Dialog titles", className: "heading-4", sample: sampleHeading },
  { name: "body", use: "Page body", className: "body", sample: sampleBody },
  { name: "ui", use: "Interface text", className: "ui", sample: sampleBody },
  {
    name: "ui-strong",
    use: "Button labels, list titles",
    className: "ui-strong",
    sample: sampleBody,
  },
  { name: "ui-small", use: "Paths, shortcuts, notes", className: "ui-small", sample: sampleBody },
  { name: "mono", use: "Code and raw frontmatter", className: "mono", sample: sampleCode },
];

const spacingSteps = [
  { name: "xs", value: "4px", bar: "w-1" },
  { name: "sm", value: "8px", bar: "w-2" },
  { name: "md", value: "12px", bar: "w-3" },
  { name: "lg", value: "16px", bar: "w-4" },
  { name: "xl", value: "24px", bar: "w-6" },
  { name: "2xl", value: "32px", bar: "w-8" },
  { name: "3xl", value: "48px", bar: "w-12" },
];

const radii = [
  { name: "none", use: "Panes, tabs, tree rows", className: "rounded-none" },
  { name: "sm", use: "Buttons, inputs, checkboxes", className: "rounded-sm" },
  { name: "md", use: "Menus, dialogs, toasts", className: "rounded-md" },
];

const iconNames = Object.keys(glyphs) as IconName[];

function Section({ title, use, children }: { title: string; use: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-divider border-t py-8">
      <div>
        <h2 className="label-caps text-text">{title}</h2>
        <p className="ui text-text-muted">{use}</p>
      </div>
      {children}
    </section>
  );
}

/** The token value as the browser resolves it in the current mode. */
function tokenValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

/** The token, type, spacing, shape, icon and logo sections. Token values are read on each render. */
export function FoundationSections() {
  return (
    <>
      <Section title="Colours" use="Every colour role, with the value the current mode resolves.">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {colourRoles.map((role) => (
            <li key={role.name} className="flex items-center gap-3">
              <span className={`h-12 w-12 shrink-0 border border-divider ${role.swatch}`} />
              <span className="flex flex-col">
                <span className="ui-strong">{role.name}</span>
                <span className="ui-small text-text-muted">{role.use}</span>
                <span className="mono text-text-muted">{tokenValue(role.name)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Type" use="Type roles. Darker Grotesque only in the first three.">
        <ul className="flex flex-col gap-6">
          {typeRoles.map((role) => (
            <li key={role.name} className="flex flex-col gap-1">
              <span className="ui-small text-text-muted">
                {role.name}: {role.use}
              </span>
              <span className={role.className}>{role.sample}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Spacing and shape" use="The 4px spacing steps, radii and the focus ring.">
        <ul className="flex flex-col gap-2">
          {spacingSteps.map((step) => (
            <li key={step.name} className="ui flex items-center gap-3">
              <span className={`h-4 bg-text-muted ${step.bar}`} />
              {step.name} ({step.value})
            </li>
          ))}
        </ul>
        <ul className="flex flex-wrap gap-6">
          {radii.map((radius) => (
            <li key={radius.name} className="flex flex-col gap-2">
              <span className={`h-12 w-24 border border-outline bg-raised ${radius.className}`} />
              <span className="ui-small text-text-muted">
                {radius.name}: {radius.use}
              </span>
            </li>
          ))}
        </ul>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a focus target for the ring sample. */}
        <div tabIndex={0} className="ui w-fit rounded-sm border border-outline px-3 py-2">
          Press Tab to focus this sample; clicking it shows no ring.
        </div>
      </Section>

      <Section title="Icons" use="Material Symbols Sharp, in text-muted and in text.">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {iconNames.map((name) => (
            <li key={name} className="ui flex items-center gap-2">
              <span className="text-text-muted">
                <Icon name={name} />
              </span>
              <span className="text-text">
                <Icon name={name} />
              </span>
              {name}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Logo" use="The stacked lockup on the welcome ground.">
        <div className="flex justify-center bg-selected py-6 light:bg-page">
          <StackedLockup height={160} />
        </div>
      </Section>
    </>
  );
}
