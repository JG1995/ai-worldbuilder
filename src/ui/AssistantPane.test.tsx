import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantPane } from "./AssistantPane";

describe("AssistantPane", () => {
  it("names the model in its header and explains what the assistant sends to the host", () => {
    render(
      <AssistantPane model="mistral-small" host="api.example.com" onOpenSettings={() => {}} />,
    );

    expect(screen.getByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByText("mistral-small")).toBeInTheDocument();
    expect(screen.getByText(/sends them, with your message, to api\.example\.com\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("asks for a provider without one, and its Settings button opens Settings", () => {
    const onOpenSettings = vi.fn();
    render(<AssistantPane onOpenSettings={onOpenSettings} />);

    expect(screen.getByRole("heading", { name: "Assistant" }).parentElement).toHaveTextContent(
      /^Assistant$/,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add a provider in Settings to use the assistant.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
