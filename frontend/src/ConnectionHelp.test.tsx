import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionHelp, type FailureDetail } from "./ConnectionHelp";

// mp-marcostudio-qa#4: each cause gets its own first screen.
const show = (failure: FailureDetail | null, error = "Couldn't connect to ComfyUI.") =>
  render(<ConnectionHelp address="http://127.0.0.1:8188" error={error} failure={failure} busy={false} retry={() => {}}/>);
const tried = ["http://127.0.0.1:8188"];

it("shows the browser permission fix when access is denied", () => {
  show({reason: "permission", tried, answered: []});
  expect(screen.getByRole("alert")).toHaveTextContent("Your browser blocked this page from reaching ComfyUI.");
  expect(screen.queryByText("Start ComfyUI, then try again.")).toBeNull();
});
it("opens the startup option and names the address when something answers", () => {
  show({reason: "cors", tried, answered: tried});
  expect(screen.getByRole("alert")).toHaveTextContent("Something is running at http://127.0.0.1:8188");
  expect(screen.getByRole("group", {name: "How do you start ComfyUI?"})).toBeInTheDocument();
  expect(screen.queryByText("Start ComfyUI, then try again.")).toBeNull();
});
it("asks the user to start ComfyUI when nothing answers", () => {
  show({reason: "unreachable", tried, answered: []});
  expect(screen.getByRole("alert")).toHaveTextContent("Can’t reach ComfyUI.");
  expect(screen.getByText("Start ComfyUI, then try again.")).toBeInTheDocument();
});
it("keeps a specific error from a non-network failure", () => {
  show(null, "This address didn't respond as ComfyUI.");
  expect(screen.getByRole("alert")).toHaveTextContent("This address didn't respond as ComfyUI.");
});

// mp-marcostudio-qa#6: help a user with no ComfyUI or with another port.
it("lists the addresses tried, links to the installer, and offers another address", async () => {
  const {default: userEvent} = await import("@testing-library/user-event");
  const user = userEvent.setup(); const connectTo = vi.fn();
  render(<ConnectionHelp address="http://127.0.0.1:8188" error="" busy={false} retry={() => {}} connectTo={connectTo}
    failure={{reason: "unreachable", tried: ["http://127.0.0.1:8188", "http://127.0.0.1:8000"], answered: []}}/>);
  expect(screen.getByText("Tried http://127.0.0.1:8188 and http://127.0.0.1:8000.")).toBeInTheDocument();
  expect(screen.getByRole("link", {name: /Install it/})).toHaveAttribute("href", "https://comfy.org/download");
  await user.type(screen.getByRole("textbox", {name: "ComfyUI uses another address?"}), "127.0.0.1:8192");
  await user.click(screen.getByRole("button", {name: "Connect"}));
  expect(connectTo).toHaveBeenCalledWith("127.0.0.1:8192");
});
