import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type NoticeStatus = "warning" | "error" | "info" | "success";

// Errors and warnings are announced when they appear; info and success wait their turn.
const statuses: Record<
  NoticeStatus,
  { icon: IconName; line: string; colour: string; role: "alert" | "status" }
> = {
  warning: { icon: "warning", line: "border-warning", colour: "text-warning", role: "alert" },
  error: { icon: "error", line: "border-error", colour: "text-error", role: "alert" },
  info: { icon: "info", line: "border-info", colour: "text-info", role: "status" },
  success: { icon: "check_circle", line: "border-success", colour: "text-success", role: "status" },
};

type NoticeProps = {
  status: NoticeStatus;
  children: ReactNode;
  actions?: ReactNode;
};

/** A full-width inline notice that stays until its caller removes it. */
export function Notice({ status, children, actions }: NoticeProps) {
  const { icon, line, colour, role } = statuses[status];

  return (
    <div
      role={role}
      className={`ui flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-l-2 bg-page py-1 pl-3 text-text ${line} ${actions ? "pr-1" : "pr-3"}`}
    >
      <span className={`flex ${colour}`}>
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1 py-1">{children}</span>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
