import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice, type NoticeStatus } from "./Notice";

describe("Notice", () => {
  it.each([
    ["error", "alert"],
    ["warning", "alert"],
    ["info", "status"],
    ["success", "status"],
  ] satisfies [NoticeStatus, string][])("a %s notice has role %s", (status, role) => {
    render(<Notice status={status}>Saltmere.md changed on disk.</Notice>);
    expect(screen.getByRole(role)).toHaveTextContent("Saltmere.md changed on disk.");
  });
});
