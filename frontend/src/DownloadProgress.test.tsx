import {act, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DownloadProgress} from "./Onboarding";
import type {InstallTask} from "./browser/manager";

const task = (id: string, state: InstallTask["state"], batchId = "batch", submittedAt = 100_000): InstallTask => ({
  id, state, batchId, submittedAt, model: {url: `https://example.com/${id}`, filename: id} as InstallTask["model"],
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(160_000); });
afterEach(() => vi.useRealTimers());

describe("download progress", () => {
  it("counts only the current batch and tracks time since submission", () => {
    const completed = task("one", "succeeded");
    const pending = task("two", "queued");
    const unrelated = task("older", "succeeded", "old-batch");
    render(<DownloadProgress tasks={[unrelated, completed, pending]} active={pending} installing={false} resume={() => {}}/>);
    expect(screen.getByText("1 of 2 tracked files completed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", {name: "Files completed"})).toHaveAttribute("value", "1");
    expect(screen.getByText("Elapsed since request: 1m 0s")).toBeInTheDocument();
    expect(screen.getByText(/Queued or downloading/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("Elapsed since request: 1m 3s")).toBeInTheDocument();
  });
  it("freezes observed duration when all files finish and displays failures", () => {
    const completed = {...task("one", "succeeded"), observedFinishedAt: 130_000};
    const failed = {...task("two", "failed"), observedFinishedAt: 145_000};
    render(<DownloadProgress tasks={[completed, failed]} active={failed} installing={false} resume={() => {}}/>);
    expect(screen.getByText("1 of 2 tracked files completed · 1 failed")).toBeInTheDocument();
    expect(screen.getByText("Time until completion observed: 0m 45s")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Resume downloads"})).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText("Time until completion observed: 0m 45s")).toBeInTheDocument();
  });
  it("shows indeterminate status and no invented elapsed time for old tasks", () => {
    const legacy = {...task("old", "unknown"), batchId: undefined, submittedAt: undefined};
    render(<DownloadProgress tasks={[legacy]} active={legacy} installing={false} resume={() => {}}/>);
    expect(screen.getByRole("progressbar", {name: "Download status"})).not.toHaveAttribute("value");
    expect(screen.getByText("Elapsed time unavailable for this request.")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for ComfyUI to confirm/)).toBeInTheDocument();
  });
  it("rotates tips while pending, lets users pause and move to the next tip, and cleans up timers", () => {
    const pending = task("one", "queued");
    const view = render(<DownloadProgress tasks={[pending]} active={pending} installing={false} resume={() => {}}/>);
    expect(screen.getByText(/Relight lets you adjust/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(15000); });
    expect(screen.getByText(/Remove Background can create/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Pause tips"}));
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByText(/Remove Background can create/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Next tip"}));
    expect(screen.getByText(/AI Stylist uses/)).toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not rotate automatically when reduced motion is requested", () => {
    const matchMedia = vi.fn().mockReturnValue({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()});
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const pending = task("one", "queued");
      const view = render(<DownloadProgress tasks={[pending]} active={pending} installing={false} resume={() => {}}/>);
      act(() => { vi.advanceTimersByTime(30000); });
      expect(screen.getByText(/Relight lets you adjust/)).toBeInTheDocument();
      expect(screen.queryByRole("button", {name: "Pause tips"})).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", {name: "Next tip"}));
      expect(screen.getByText(/Remove Background can create/)).toBeInTheDocument();
      view.unmount();
    } finally { vi.unstubAllGlobals(); }
  });
});
