import { Fragment, type KeyboardEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import type { IconName } from "./Icon";
import { type Point, usePopoverPosition } from "./Tooltip";

export type MenuItem = {
  id: string;
  label: string;
  shortcut?: string;
  /** Shown in `error` text below a divider. */
  destructive?: boolean;
  disabled?: boolean;
};

type MenuProps = {
  label: string;
  items: MenuItem[];
  /** A pointer position, or the element to open below. */
  at: Point | Element;
  onSelect: (id: string) => void;
  onClose: () => void;
};

function enabledItems(menu: HTMLElement | null) {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
}

/**
 * A menu in a portal on the menu layer. It focuses its first enabled item, and closing it by
 * Escape, Tab, a click outside or an activated item returns focus to where it was when it opened.
 */
export function Menu({ label, items, at, onSelect, onClose }: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const position = usePopoverPosition(menu, at, "start");
  const closeOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target as Node;
    const onAnchor = at instanceof Element && at.contains(target);
    if (!menu.current?.contains(target) && !onAnchor) onClose();
  });

  useEffect(() => {
    const opener = document.activeElement;
    enabledItems(menu.current)[0]?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, []);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = enabledItems(menu.current);
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: enabled.length - 1,
    };
    if (event.key in targets) {
      event.preventDefault();
      enabled[(targets[event.key] + enabled.length) % enabled.length]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      enabled[index]?.click();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      style={position}
      onKeyDown={moveFocus}
      className="z-(--z-menu) flex min-w-[200px] flex-col rounded-md border border-divider bg-raised py-1 shadow-(--level-2-shadow) transition-opacity duration-(--duration-fade) starting:opacity-0"
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.destructive && index > 0 && !items[index - 1].destructive && (
            <hr className="my-1 border-divider" />
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
            onPointerMove={(event) => event.currentTarget.focus()}
            className={`ui flex h-control-compact items-center gap-6 px-3 focus:bg-selected focus-visible:-outline-offset-2 disabled:text-text-disabled ${item.destructive ? "text-error" : "text-text"}`}
          >
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            {item.shortcut && <span className="ui-small text-text-muted">{item.shortcut}</span>}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

type MenuButtonProps = {
  icon: IconName;
  /** The button's name and tooltip, and the menu's name. */
  label: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
};

/** An icon button that opens a menu below itself. */
export function MenuButton({ icon, label, items, onSelect }: MenuButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <IconButton
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      />
      {anchor && (
        <Menu
          label={label}
          items={items}
          at={anchor}
          onSelect={onSelect}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
