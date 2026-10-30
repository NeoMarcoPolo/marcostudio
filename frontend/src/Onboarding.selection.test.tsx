import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import type { Doctor } from "./api";
import { createDownloadSnapshots, observeDownloadTasks } from "./notificationEvents";

const manager = vi.hoisted(() => ({ start: vi.fn(), available: vi.fn(), tasks: vi.fn() }));
vi.mock("./browser/manager", () => ({
  canInstall: () => true, installTasks: manager.tasks, managerAvailable: manager.available,
  reconcileInstalls: async () => manager.tasks(), resumeDownloads: vi.fn(), startDownloads: manager.start,
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
  it("announces a fast completion once when refresh observes it before submission returns", async () => {
    const user = userEvent.setup(); let finish!: () => void;
    manager.start.mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const snapshots = createDownloadSnapshots();
    const events: ReturnType<typeof observeDownloadTasks> = [];
    const onTasks = vi.fn((address, tasks, ids) => {events.push(...observeDownloadTasks(snapshots, address, tasks, ids));});
    render(<Onboarding {...props()} onTasks={onTasks}/>);
    await waitFor(() => expect(onTasks).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("checkbox", {name: /Select first/})).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", {name: /Select first/}));
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
    await user.click(screen.getByRole("button", {name: "Download selected"}));
    expect(manager.start).toHaveBeenCalledOnce();
    manager.tasks.mockReturnValue([{id: "fast-task", model: models[0], state: "succeeded"}]);
    const previousCalls = onTasks.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(onTasks.mock.calls.length).toBeGreaterThan(previousCalls));
    expect(events).toEqual([]);
    finish();
    await waitFor(() => expect(events).toEqual([{text: "Model download complete: first.safetensors", failure: false}]));
    fireEvent.focus(window);
    expect(events).toHaveLength(1);
  });
  it("reports task snapshots around refresh even when refresh reconciles first", async () => {
    const pending = {id: "model-task", model: models[0], state: "queued", submittedAt: 1000};
    const complete = {...pending, state: "succeeded", observedFinishedAt: 201000};
    manager.tasks.mockReturnValue([pending]);
    const onTasks = vi.fn();
    const refresh = vi.fn(async () => {manager.tasks.mockReturnValue([complete]);});
    render(<Onboarding {...props()} refresh={refresh} onTasks={onTasks}/>);
    await waitFor(() => expect(onTasks.mock.calls.some(call => call[1][0]?.state === "succeeded")).toBe(true));
    expect(onTasks.mock.calls[0][1][0].state).toBe("queued");
  });
  it("reports a fast terminal submission even if setup closes before the request resolves", async () => {
    const user = userEvent.setup(); let finish!: () => void;
    manager.start.mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const onTasks = vi.fn(); const view = render(<Onboarding {...props()} onTasks={onTasks}/>);
    await waitFor(() => expect(screen.getByRole("checkbox", {name: /Select first/})).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", {name: /Select first/}));
    await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
    await user.click(screen.getByRole("button", {name: "Download selected"}));
    expect(manager.start).toHaveBeenCalledOnce();
    view.unmount();
    manager.tasks.mockReturnValue([{id: "fast-task", model: models[0], state: "succeeded"}]);
    finish();
    await waitFor(() => expect(onTasks).toHaveBeenCalledWith("http://127.0.0.1:8192", expect.any(Array), ["fast-task"]));
  });
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
  it("prioritizes unresolved batches over newer finished work and lets users review models without submitting", async () => {
    const user = userEvent.setup();
    const pending = {id: "old-pending", model: models[0], state: "queued", batchId: "a", submittedAt: Date.now()};
    const other = {id: "other-pending", model: models[1], state: "unknown", batchId: "b", submittedAt: Date.now()};
    const complete = {id: "newer-completed", model: models[0], state: "succeeded", batchId: "c", submittedAt: Date.now(), observedFinishedAt: Date.now()};
    manager.tasks.mockReturnValue([pending, other, complete]);
    render(<Onboarding {...props()} />);
    await waitFor(() => expect(screen.getByRole("combobox", {name: "Download batch"})).toBeInTheDocument());
    const picker = screen.getByRole("combobox", {name: "Download batch"});
    expect(picker).toHaveValue("batch:a");
    expect(screen.getByText("Queued or downloading in ComfyUI.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", {name: /Select first/})).not.toBeInTheDocument();
    await user.selectOptions(picker, "batch:b");
    expect(screen.getByText("Waiting for ComfyUI to confirm the request.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Review missing models"}));
    expect(screen.getByText("first.safetensors")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Download selected"})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: /Back to download progress/}));
    expect(screen.getByRole("combobox", {name: "Download batch"})).toHaveValue("batch:b");
    expect(manager.start).not.toHaveBeenCalled();
  });
  it("avoids a duplicate active-queue warning during a tracked download but retains an unknown-queue warning", async () => {
    const pending = {id: "pending", model: models[0], state: "queued", batchId: "a", submittedAt: Date.now()};
    manager.tasks.mockReturnValue([pending]);
    const active = "ComfyUI Manager has downloads or other setup tasks in progress. Wait for its queue to finish, then check again.";
    const unknown = "Couldn't check the ComfyUI Manager queue. Check the connection and try again.";
    const initial = props(report(models, [{name: "manager:queue", status: "fail", message: active}]));
    const view = render(<Onboarding {...initial}/>);
    await waitFor(() => expect(screen.getByRole("region", {name: "Download progress"})).toBeInTheDocument());
    expect(screen.queryByText(active)).not.toBeInTheDocument();
    view.rerender(<Onboarding {...initial} doctor={report(models, [{name: "manager:queue", status: "fail", message: unknown}])}/>);
    expect(screen.getByText(unknown)).toBeInTheDocument();
  });
});
