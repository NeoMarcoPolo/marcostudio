import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import { SettingsDialog, withScheme } from "./SettingsDialog";
import type { Doctor } from "./api";

// mp-marcostudio-qa#5: ComfyUI prints its address as "127.0.0.1:8188". A
// type="url" field fails the browser's own check before the app sees it.
vi.mock("./browser/manager", () => ({
  canInstall: () => true, installTasks: () => [], managerAvailable: async () => true,
  reconcileInstalls: async () => [], resumeDownloads: vi.fn(), startDownloads: vi.fn(),
}));
const discover = vi.hoisted(() => vi.fn());
vi.mock("./browser/connection", async original => ({
  ...(await original<typeof import("./browser/connection")>()),
  endpoint: () => "http://127.0.0.1:8192", discover, selectConnection: vi.fn(),
}));
const report = {connected: true, address: "http://127.0.0.1:8192", ready: false, model_requirements: [],
  checks: [], missing_nodes: [], models: {}} as unknown as Doctor;
beforeEach(() => {
  vi.stubGlobal("localStorage", {getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn()});
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  discover.mockReset().mockRejectedValue(new Error("Couldn't connect to ComfyUI."));
});

it("adds http:// only when the address has no scheme", () => {
  expect(withScheme(" 127.0.0.1:8192 ")).toBe("http://127.0.0.1:8192");
  expect(withScheme("https://127.0.0.1:8192")).toBe("https://127.0.0.1:8192");
  expect(withScheme("  ")).toBe("");
});

it("accepts a host and port without a scheme in setup", async () => {
  const user = userEvent.setup();
  render(<Onboarding featureId="relight" doctor={report} checking={false} locked={false}
    refresh={vi.fn(async () => {})} connected={vi.fn(async () => {})} close={vi.fn()}/>);
  await user.click(screen.getAllByRole("button", {name: "Change address"})[0]);
  const input = screen.getByRole("textbox", {name: "ComfyUI address"}) as HTMLInputElement;
  await user.clear(input); await user.type(input, "127.0.0.1:8192");
  expect(input.checkValidity()).toBe(true);
  await user.click(screen.getByRole("button", {name: "Connect"}));
  expect(discover).toHaveBeenCalledWith("http://127.0.0.1:8192");
});

it("saves a host and port without a scheme as an http address in settings", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async (changes: object) => ({comfy_url: "", proxy_url: "", comfy_dir: "/c", data_dir: "/d", ...changes}));
  render(<SettingsDialog value={{comfy_url: "http://127.0.0.1:8188", proxy_url: "http://127.0.0.1:8189", comfy_dir: "/c", data_dir: "/d"} as never}
    checking={false} locked={false} close={vi.fn()} refresh={vi.fn()} save={save as never}/>);
  const input = screen.getByLabelText("ComfyUI URL") as HTMLInputElement;
  await user.clear(input); await user.type(input, "127.0.0.1:8192");
  expect(input.checkValidity()).toBe(true);
  await user.click(screen.getByRole("button", {name: "Save and check"}));
  expect(save).toHaveBeenCalledWith({comfy_url: "http://127.0.0.1:8192"});
});
