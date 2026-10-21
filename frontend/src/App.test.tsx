import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import App from "./App";

const defaults = {
  direction: "front",
  softness: "soft",
  brightness: 50,
  color: "#ffffff",
  mode: "flash",
  seed: 0,
};
const source = {
  id: "source-1",
  url: "/api/assets/source-1",
  width: 640,
  height: 480,
  filename: "portrait.png",
  media_type: "image/png",
};
const output = {
  ...source,
  id: "output-1",
  url: "/api/assets/output-1",
  filename: "relit.png",
};
const job = {
  feature: "relight",
  id: "job-1",
  status: "succeeded",
  settings: { ...defaults, direction: "right", brightness: 80 },
  source_id: "source-1",
  outputs: [output],
  error: null,
  created_at: "2026-10-16T12:00:00Z",
  updated_at: "2026-10-16T12:00:00Z",
  progress: null,
  elapsed_seconds: 12,
  queue_seconds: 1,
};
let history: unknown[] = [];
let ready = true;
let postError: string | null = null;
let delayedPost = false;
let networkFailure = false;
let polledJob = job;
let metadataWait: Promise<void> | undefined;
let submissionWait: Promise<void> | undefined;
let settingsWait: Promise<void> | undefined;
let studioSettings = {
  comfy_url: "http://localhost:8188",
  proxy_url: "http://localhost:8189",
  comfy_dir: "C:\\AI\\ComfyUI",
  data_dir: "data",
  transport: "Comfy SDK + local API proxy",
};
let metadataAsset = source;
let resolutionError: string | undefined;
let resolutionJob = {
  ...job,
  status: "abandoned",
  outputs: [] as typeof job.outputs,
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let calls: { url: string; method: string; body: any }[] = [];
beforeEach(() => {
  history = [];
  ready = true;
  postError = null;
  delayedPost = false;
  networkFailure = false;
  polledJob = job;
  metadataWait = undefined;
  submissionWait = undefined;
  settingsWait = undefined;
  studioSettings = {
    comfy_url: "http://localhost:8188",
    proxy_url: "http://localhost:8189",
    comfy_dir: "C:\\AI\\ComfyUI",
    data_dir: "data",
    transport: "Comfy SDK + local API proxy",
  };
  metadataAsset = source;
  resolutionError = undefined;
  resolutionJob = { ...job, status: "abandoned", outputs: [] };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      calls.push({ url, method, body: init?.body });
      if (url.endsWith("/meta")) await metadataWait;
      if (url === "/api/settings" && method === "GET") await settingsWait;
      if (method === "POST" && url.startsWith("/api/jobs"))
        await submissionWait;
      let data: unknown;
      if (url === "/api/features")
        data = [
          {
            id: "relight",
            name: "Relight",
            supported_modes: ["flash"],
            defaults,
          },
          {
            id: "remove-background",
            name: "Remove Background",
            supported_modes: ["standard"],
            defaults: { mode: "standard", seed: 0 },
          },
        ];
      else if (url === "/api/settings") {
        if (method === "PUT")
          studioSettings = {
            ...studioSettings,
            ...JSON.parse(String(init?.body)),
          };
        data = studioSettings;
      } else if (url.startsWith("/api/doctor"))
        data = {
          ready,
          checks: [
            {
              name: "runtime",
              status: ready ? "pass" : "fail",
              message: ready
                ? "Connected"
                : "ComfyUI unreachable or response invalid: ConnectError",
            },
          ],
          models: {},
          runtime: {},
        };
      else if (url === "/api/assets" && method === "POST") data = source;
      else if (url.endsWith("/meta")) data = metadataAsset;
      else if (url === "/api/jobs" && method === "GET") data = history;
      else if (url === "/api/jobs" && method === "POST") {
        if (networkFailure) throw new TypeError("Failed to fetch");
        if (delayedPost)
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (postError)
          return new Response(JSON.stringify({ detail: postError }), {
            status: 503,
          });
        const payload = JSON.parse(String(init?.body));
        data = { ...job, feature: payload.feature, settings: payload.settings };
      } else if (url.endsWith("/cancel"))
        data = { ...job, status: "cancel_requested", outputs: [] };
      else if (url.endsWith("/resolve")) {
        if (resolutionError)
          return new Response(JSON.stringify({ detail: resolutionError }), {
            status: 409,
          });
        data = resolutionJob;
      } else data = polledJob;
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function upload() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled(),
  );
  await userEvent.upload(
    screen.getByLabelText("Upload source image"),
    new File(["image"], "portrait.png", { type: "image/png" }),
  );
  await screen.findByAltText("Source: portrait.png");
}
describe("Relight studio", () => {
  it("submits background removal without light settings and restores its tool from history", async () => {
    history = [
      {
        ...job,
        feature: "remove-background",
        settings: { mode: "standard", seed: 7 },
      },
    ];
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Remove Background",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Flash" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Brightness")).not.toBeInTheDocument();
    expect(screen.getByAltText("Source: portrait.png")).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByAltText("Source: portrait.png")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Use as source" }),
    );
    const generate = screen.getByRole("button", { name: "Remove background" });
    await waitFor(() => expect(generate).toBeEnabled());
    await userEvent.click(generate);
    await waitFor(() =>
      expect(
        calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        calls.find((x) => x.url === "/api/jobs" && x.method === "POST")!.body,
      ),
    ).toMatchObject({
      feature: "remove-background",
      source_id: output.id,
      settings: { mode: "standard", seed: 7 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Relight" }));
    expect(screen.getByLabelText("Brightness")).toBeInTheDocument();
  });
  it("uploads the source and submits the selected light settings only on Generate", async () => {
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Right" }));
    fireEvent.change(screen.getByLabelText("Brightness"), {
      target: { value: "80" },
    });
    expect(
      calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByAltText("Result: relit.png");
    const sent = JSON.parse(
      calls.find((x) => x.url === "/api/jobs" && x.method === "POST")!.body,
    );
    expect(sent).toMatchObject({
      source_id: "source-1",
      settings: { ...defaults, direction: "right", brightness: 80 },
    });
    expect(sent.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (calls.find((x) => x.url === "/api/assets")!.body as FormData).get(
        "file",
      ),
    ).toBeInstanceOf(File);
  });
  it("prevents duplicate submissions with Flash enabled", async () => {
    delayedPost = true;
    render(<App />);
    await upload();
    expect(screen.getByRole("switch", { name: "Flash" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Flash" })).toBeDisabled();
    await userEvent.dblClick(screen.getByRole("button", { name: "Generate" }));
    await screen.findByAltText("Result: relit.png");
    expect(
      calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
    ).toHaveLength(1);
  });
  it("restores the recorded source, controls and result from history", async () => {
    history = [job];
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await screen.findByAltText("Source: portrait.png");
    expect(screen.getByLabelText("Brightness")).toHaveValue("80");
    expect(screen.getByRole("button", { name: "Right" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByAltText("Result: relit.png")).toBeInTheDocument();
  });
  it("shows backend submission errors without retrying automatically", async () => {
    postError = "The image service is disconnected.";
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(postError);
    expect(
      calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
    ).toHaveLength(1);
  });
  it("blocks Generate when readiness fails and opens actionable setup", async () => {
    ready = false;
    render(<App />);
    await screen.findByText("Setup needed");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("dialog", { name: "Studio settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ComfyUI unreachable or response invalid: ConnectError"),
    ).toBeInTheDocument();
  });
  it("allows keyboard custom direction and validates seed without submitting", async () => {
    render(<App />);
    await upload();
    fireEvent.change(screen.getByLabelText("Azimuth"), {
      target: { value: "35" },
    });
    fireEvent.change(screen.getByLabelText("Elevation"), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText("Seed"), {
      target: { value: "-1" },
    });
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Seed"), {
      target: { value: "123" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(
        calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        calls.find((x) => x.url === "/api/jobs" && x.method === "POST")!.body,
      ).settings,
    ).toMatchObject({
      direction: "custom",
      azimuth: 35,
      elevation: 25,
      seed: 123,
    });
  });
  it("saves only edited connection fields and checks the saved settings", async () => {
    render(<App />);
    await screen.findByText("ComfyUI connected");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("button", { name: "Save and check" }),
    ).toBeDisabled();
    expect(screen.queryByLabelText("API proxy URL")).not.toBeInTheDocument();
    const url = screen.getByLabelText("ComfyUI URL");
    await userEvent.clear(url);
    await userEvent.type(url, "http://localhost:9999");
    await userEvent.click(
      screen.getByRole("button", { name: "Save and check" }),
    );
    await waitFor(() =>
      expect(calls.filter((x) => x.method === "PUT")).toHaveLength(1),
    );
    expect(JSON.parse(calls.find((x) => x.method === "PUT")!.body)).toEqual({
      comfy_url: "http://localhost:9999",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and check" }),
      ).toBeDisabled(),
    );
    expect(calls.filter((x) => x.url.startsWith("/api/doctor"))).toHaveLength(
      2,
    );
    expect(
      calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
    ).toHaveLength(0);
  });
  it("preserves an advanced connection edit while collapsed and requires the ComfyUI folder", async () => {
    render(<App />);
    await screen.findByText("ComfyUI connected");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const proxy = screen.getByLabelText("API proxy URL");
    await userEvent.clear(proxy);
    await userEvent.type(proxy, "http://localhost:8190");
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const folder = screen.getByLabelText("ComfyUI folder");
    await userEvent.clear(folder);
    await userEvent.click(
      screen.getByRole("button", { name: "Save and check" }),
    );
    expect(calls.filter((x) => x.method === "PUT")).toHaveLength(0);
    await userEvent.type(folder, "C:\\AI\\ComfyUI");
    await userEvent.click(
      screen.getByRole("button", { name: "Save and check" }),
    );
    await waitFor(() =>
      expect(calls.filter((x) => x.method === "PUT")).toHaveLength(1),
    );
    expect(JSON.parse(calls.find((x) => x.method === "PUT")!.body)).toEqual({
      proxy_url: "http://localhost:8190",
    });
  });
  it("locks connection edits during an active job while allowing setup checks", async () => {
    history = [{ ...job, status: "running", outputs: [] }];
    polledJob = { ...job, status: "running", outputs: [] };
    render(<App />);
    await screen.findByText("Generating…");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("ComfyUI URL")).toBeDisabled();
    expect(screen.getByLabelText("ComfyUI folder")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save and check" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("API proxy URL")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await waitFor(() =>
      expect(calls.filter((x) => x.url.startsWith("/api/doctor"))).toHaveLength(
        2,
      ),
    );
    expect(calls.filter((x) => x.method !== "GET")).toHaveLength(0);
  });
  it("retains the request identity when explicitly retrying an uncertain submission", async () => {
    networkFailure = true;
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("alert");
    expect(
      calls.filter((x) => x.url === "/api/jobs" && x.method === "POST"),
    ).toHaveLength(1);
    networkFailure = false;
    await userEvent.click(
      screen.getByRole("button", { name: "Retry same request" }),
    );
    await screen.findByAltText("Result: relit.png");
    const posts = calls.filter(
      (x) => x.url === "/api/jobs" && x.method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);
  });
  it("keeps the safe retry accessible after dismissing a connection error", async () => {
    networkFailure = true;
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("alert");
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss error" }),
    );
    expect(
      screen.getByRole("button", { name: "Retry same request" }),
    ).toBeInTheDocument();
  });
  it("compares, downloads and reuses a result while preserving the original until requested", async () => {
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByAltText("Result: relit.png");
    expect(screen.getByAltText("Source: portrait.png")).toHaveAttribute(
      "src",
      "/api/assets/source-1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    fireEvent.change(screen.getByLabelText("Compare original and result"), {
      target: { value: "72" },
    });
    expect(screen.getByAltText("Result: relit.png")).toHaveStyle({
      clipPath: "inset(0 0 0 72%)",
    });
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "download",
      "relit.png",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Use as source" }),
    );
    expect(screen.getByAltText("Source: relit.png")).toHaveAttribute(
      "src",
      "/api/assets/output-1",
    );
    expect(screen.queryByAltText("Result: relit.png")).not.toBeInTheDocument();
  });
  it("regenerates from the recorded job without substituting edited settings", async () => {
    history = [job];
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await screen.findByAltText("Source: portrait.png");
    await userEvent.click(screen.getByRole("button", { name: "Left" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Regenerate recorded job" }),
    );
    await waitFor(() =>
      expect(
        calls.some((item) => item.url === "/api/jobs/job-1/regenerate"),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        calls.find((item) => item.url === "/api/jobs/job-1/regenerate")!.body,
      ),
    ).toEqual({ request_id: expect.any(String) });
  });
  it("shows queue and execution state instead of setup readiness while polling", async () => {
    history = [{ ...job, status: "queued", outputs: [] }];
    polledJob = { ...job, status: "queued", outputs: [] };
    vi.useFakeTimers();
    const view = render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Studio status")).toHaveTextContent("Queued");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.filter((item) => item.url === "/api/jobs/job-1")).toHaveLength(
      1,
    );
    expect(
      calls.filter((item) => item.url.startsWith("/api/doctor")),
    ).toHaveLength(1);
    polledJob = { ...job, status: "running", outputs: [] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByLabelText("Studio status")).toHaveTextContent(
      "Generating",
    );
    polledJob = job;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByLabelText("Studio status")).toHaveTextContent(
      "ComfyUI connected",
    );
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls.filter((item) => item.url === "/api/jobs/job-1")).toHaveLength(
      3,
    );
  });
  it("keeps cancellation pending until a terminal job status is returned", async () => {
    history = [{ ...job, status: "running", outputs: [] }];
    polledJob = { ...job, status: "running", outputs: [] };
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await screen.findByAltText("Source: portrait.png");
    await userEvent.click(
      screen.getByRole("button", { name: "Request cancellation" }),
    );
    expect(
      await screen.findByRole("button", { name: "Cancellation requested" }),
    ).toBeDisabled();
    expect(screen.queryByAltText("Result: relit.png")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });
  it("polls uncertain generations, blocks new submissions across selection changes, and resumes after reconciliation", async () => {
    history = [{ ...job, status: "needs_attention", outputs: [] }];
    polledJob = { ...job, status: "needs_attention", outputs: [] };
    render(<App />);
    await upload();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByText(/New generations are paused/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Open generation/ }),
    );
    await screen.findByAltText("Source: portrait.png");
    expect(
      screen.getByRole("button", { name: "Regenerate recorded job" }),
    ).toBeDisabled();
    await waitFor(
      () =>
        expect(calls.some((item) => item.url === "/api/jobs/job-1")).toBe(true),
      { timeout: 2000 },
    );
    polledJob = job;
    await screen.findByAltText("Result: relit.png", {}, { timeout: 2500 });
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });
  it("blocks source reuse, replacement and history changes during a pending submission", async () => {
    history = [job];
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await screen.findByAltText("Result: relit.png");
    const pending = deferred();
    submissionWait = pending.promise;
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      screen.getByRole("button", { name: "Use as source" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Upload source image")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Open generation/ }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use as source" }));
    expect(screen.getByAltText("Source: portrait.png")).toBeInTheDocument();
    await act(async () => {
      pending.release();
    });
    expect(screen.getByAltText("Source: portrait.png")).toBeInTheDocument();
  });
  it("blocks Generate and all source mutations while loading a history selection", async () => {
    history = [{ ...job, source_id: "source-2" }];
    render(<App />);
    await upload();
    metadataAsset = {
      ...source,
      id: "source-2",
      url: "/api/assets/source-2",
      filename: "other.png",
    };
    const pending = deferred();
    metadataWait = pending.promise;
    await userEvent.click(
      screen.getByRole("button", { name: /Open generation/ }),
    );
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByLabelText("Upload source image")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Open generation/ }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      calls.filter(
        (item) => item.url === "/api/jobs" && item.method === "POST",
      ),
    ).toHaveLength(0);
    await act(async () => {
      pending.release();
    });
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
    expect(screen.getByAltText("Source: other.png")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      JSON.parse(
        calls.find(
          (item) => item.url === "/api/jobs" && item.method === "POST",
        )!.body,
      ).source_id,
    ).toBe("source-2");
  });
  it("opens Settings only after startup connection values are available", async () => {
    const pending = deferred();
    settingsWait = pending.promise;
    render(<App />);
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
    await act(async () => {
      pending.release();
    });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("ComfyUI URL")).toHaveValue(
      "http://localhost:8188",
    );
  });
  it("resolves an uncertain job only after explicit confirmation and unblocks generation", async () => {
    history = [{ ...job, status: "needs_attention", outputs: [] }];
    polledJob = { ...job, status: "needs_attention", outputs: [] };
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    const resolve = await screen.findByRole("button", {
      name: "Resolve uncertain job",
    });
    expect(calls.filter((item) => item.method === "POST")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Request cancellation" }),
    ).not.toBeInTheDocument();
    await userEvent.click(resolve);
    expect(screen.getByText(/Check ComfyUI/)).toHaveTextContent(
      "no longer running",
    );
    expect(calls.filter((item) => item.method === "POST")).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "I checked — stop tracking" }),
    );
    await screen.findByText("Generation Stopped tracking");
    expect(calls.filter((item) => item.method === "POST")).toHaveLength(1);
    expect(
      JSON.parse(
        calls.find((item) => item.url === "/api/jobs/job-1/resolve")!.body,
      ),
    ).toEqual({ confirm_not_running: true });
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
    expect(
      screen.queryByText(/New generations are paused/),
    ).not.toBeInTheDocument();
  });
  it("shows a resolution refusal and keeps the uncertain job blocked", async () => {
    history = [{ ...job, status: "needs_attention", outputs: [] }];
    polledJob = { ...job, status: "needs_attention", outputs: [] };
    resolutionError =
      "This generation is still running. Wait for it to finish.";
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Resolve uncertain job" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "I checked — stop tracking" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(resolutionError);
    expect(
      screen.getByRole("button", { name: "Checking job status…" }),
    ).toBeDisabled();
    expect(calls.filter((item) => item.method === "POST")).toHaveLength(1);
  });
  it("accepts an existing terminal result returned while resolving uncertainty", async () => {
    history = [{ ...job, status: "needs_attention", outputs: [] }];
    polledJob = { ...job, status: "needs_attention", outputs: [] };
    resolutionJob = job;
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open generation/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Resolve uncertain job" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "I checked — stop tracking" }),
    );
    await screen.findByAltText("Result: relit.png");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });
  it("retains the original submission identity when a server error may follow persistence", async () => {
    postError = "The response was interrupted after submission.";
    render(<App />);
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Retry same request" });
    expect(
      calls.filter(
        (item) => item.method === "POST" && item.url === "/api/jobs",
      ),
    ).toHaveLength(1);
    postError = null;
    await userEvent.click(retry);
    await screen.findByAltText("Result: relit.png");
    const submissions = calls.filter(
      (item) => item.method === "POST" && item.url === "/api/jobs",
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1].body).toEqual(submissions[0].body);
  });
});
