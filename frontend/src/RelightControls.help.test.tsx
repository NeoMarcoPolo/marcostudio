import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RelightControls } from "./RelightControls";

describe("Relight control help", () => {
  it("shows a description on mouse hover and supports click and Escape", async () => {
    const user = userEvent.setup();
    render(<RelightControls settings={{direction: "front", softness: "soft", brightness: 50, color: "#ffffff", mode: "flash", seed: 0}} setSettings={vi.fn()} validSeed/>);
    const help = screen.getByRole("button", {name: "About brightness"});
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Higher values make it brighter");
    await user.unhover(help);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(help);
    await user.unhover(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("intensity");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
