import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextInput } from "./TextInput";

describe("TextInput", () => {
  it("is invalid and described by its error message", () => {
    render(<TextInput label="Name" error='A page named "Saltmere" already exists.' />);

    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription('A page named "Saltmere" already exists.');
  });

  it("names itself from a hidden label and is valid without an error", () => {
    render(<TextInput label="Rename page" hideLabel size="compact" />);

    const input = screen.getByRole("textbox", { name: "Rename page" });
    expect(input).toBeValid();
    expect(input).not.toHaveAccessibleDescription();
  });
});
