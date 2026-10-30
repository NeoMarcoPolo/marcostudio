import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import type { Doctor } from "./api";

const manager = vi.hoisted(() => ({ start: vi.fn(), available: vi.fn(), tasks: vi.fn() }));
vi.mock("./browser/manager", () => ({
  canInstall: () => true, installTasks: manager.tasks, managerAvailable: manager.available,
  reconcileInstalls: async () => [], resumeDownloads: vi.fn(), startDownloads: manager.start,
}));
vi.mock("./browser/connection", () => ({
  CONNECTION_DRAFT_KEY: "draft", endpoint: () => "http://127.0.0.1:8192",
  discover: vi.fn(), normalizeAddress: (v: string) => v, selectConnection: vi.fn(),
}));
const model = (key: string, size: number) => ({ key, filename: `${key}.safetensors`, category: "vae", url: `https://example.com/${key}`, size,
  sha256: "", repository: "a/b", loader: "", field: "", available: false, installable: true });
const models = [model("first", 2e9), model("second", 3e9)];
const report = (requirements = models, checks: unknown[] = []) => ({ connected: true, address: "http://127.0.0.1:8192", ready: false,
  model_requirements: requirements, checks, missing_nodes: [], models: {} }) as unknown as Doctor;
const props = (doctor = report()) => ({featureId: "relight" as const, doctor, checking: false, locked: false,
  refresh: vi.fn(async () => {}), connected: vi.fn(async () => {}), close: vi.fn()});
beforeEach(() => {
  vi.stubGlobal("localStorage", {getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn()}); manager.start.mockReset().mockResolvedValue([]); manager.available.mockReset().mockResolvedValue(true);
  manager.tasks.mockReset().mockReturnValue([]); HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
describe("model download consent", () => {
  it("shows sizes and submits only the explicitly selected and confirmed model", async () => {
    const user = userEvent.setup(); render(<Onboarding {...props()} />);
    await waitFor(() => expect(screen.getByRole("checkbox", {name: /Select first/})).toBeInTheDocument());
    expect(screen.getByText(/2.0 GB/)).toBeInTheDocument(); expect(screen.getByText(/3.0 GB/)).toBeInTheDocument();
    const button = screen.getByRole("button", {name: "Download selected"}); expect(button).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {name: /Select first/})); expect(button).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/})); expect(button).toBeEnabled();
    await user.click(button); await waitFor(() => expect(manager.start).toHaveBeenCalledOnce());
    expect(manager.start).toHaveBeenCalledWith([models[0]]);
  });
  it("keeps a selection when returning from model details", async () => {
    const user = userEvent.setup(); render(<Onboarding {...props()} />);
    await waitFor(() => expect(screen.getByRole("checkbox", {name: /Select first/})).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", {name: /Select first/}));
    await user.click(screen.getByRole("button", {name: /Details for first/}));
    expect(screen.getByRole("heading", {name: "Model details"})).toBeInTheDocument();
    expect(screen.getByRole("link", {name: "Download manually"})).toHaveAttribute("href", models[0].url);
    await user.click(screen.getByRole("button", {name: /Back to setup/}));
    expect(screen.getByRole("checkbox", {name: /Select first/})).toBeChecked();
  });
  it("invalidates consent after selection or queue eligibility changes", async () => {
    const user = userEvent.setup(); const initial = props(); const view = render(<Onboarding {...initial} />);
    await waitFor(() => expect(screen.getByRole("checkbox", {name: /Select all/})).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", {name: /Select all/}));
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
    await user.click(screen.getByRole("checkbox", {name: /Select second/}));
    expect(screen.getByRole("checkbox", {name: /I confirm downloading/})).not.toBeChecked();
    expect(screen.getByRole("button", {name: "Download selected"})).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
    view.rerender(<Onboarding {...initial} doctor={report([{...models[0], size: 4e9}, models[1]])} />);
    expect(screen.getByRole("checkbox", {name: /I confirm downloading/})).not.toBeChecked();
    expect(screen.getByRole("button", {name: "Download selected"})).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
    view.rerender(<Onboarding {...initial} doctor={report(models, [{name: "manager:queue", status: "fail", message: "Queue busy"}])} />);
    expect(screen.getByText("Queue busy")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Download selected"})).toBeDisabled();
    expect(screen.getByRole("checkbox", {name: /I confirm downloading/})).not.toBeChecked();
    expect(manager.start).not.toHaveBeenCalled();
  });
});
