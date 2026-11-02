import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Toggle } from "./Toggle";

function AiSwitch() {
  const [on, setOn] = useState(true);
  return (
    <Toggle
      label="AI features"
      checked={on}
      onChange={setOn}
      description="Off hides the assistant."
    />
  );
}

describe("Toggle", () => {
  it("is a switch named by its label and described, showing its state as text", () => {
    render(<AiSwitch />);
    const toggle = screen.getByRole("switch", { name: "AI features" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription("Off hides the assistant.");
    expect(screen.getByText("On")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Off")).toBeInTheDocument();
  });
});
