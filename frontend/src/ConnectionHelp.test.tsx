import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
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
