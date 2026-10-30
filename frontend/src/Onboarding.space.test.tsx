import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import type { Doctor } from "./api";
import { clearUnverified, unpairIntegrity } from "./browser/integrity";
const calls = vi.hoisted(() => ({check: vi.fn(), start: vi.fn(), supports: vi.fn(), integrity: vi.fn(), address: "http://127.0.0.1:8192"}));
vi.mock("./browser/manager", () => ({canInstall: () => true, installTasks: () => [], managerAvailable: async () => true, reconcileInstalls: async () => [], resumeDownloads: vi.fn(), startDownloads: calls.start}));
vi.mock("./browser/connection", () => ({CONNECTION_DRAFT_KEY: "draft", currentConnectionGeneration: () => 0, endpoint: () => calls.address, discover: vi.fn(), normalizeAddress: (v: string) => v, selectConnection: vi.fn()}));
vi.mock("./browser/modelSpace", async original => ({...await original<typeof import("./browser/modelSpace")>(), checkStorage: calls.check, supportsStoragePairing: calls.supports, supportsIntegrityVerification: calls.integrity}));
const id = "a".repeat(64);
const model = {key: "first", filename: "first.safetensors", category: "vae", url: "https://example.com/first", size: 2e9, sha256: id, repository: "a/b", loader: "", field: "", available: false, installable: true};
const doctor = {connected: true, address: "http://127.0.0.1:8192", ready: false, model_requirements: [model], checks: []} as unknown as Doctor;
const result = (available: number) => ({version: 1, models: [{id, status: "available", available_bytes: available, volume: "disk"}]});
beforeEach(() => { clearUnverified(); unpairIntegrity(); vi.stubGlobal("localStorage", {getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn()}); calls.address = "http://127.0.0.1:8192"; calls.check.mockReset().mockResolvedValue(result(5e9)); calls.supports.mockReset().mockResolvedValue(true); calls.integrity.mockReset().mockResolvedValue(false); calls.start.mockReset().mockResolvedValue([]); HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");}; });
it("shows destination space, then rechecks before the user-confirmed download", async () => {
  const user = userEvent.setup(); render(<Onboarding featureId="relight" doctor={doctor} checking={false} locked={false} refresh={async () => {}} connected={async () => {}} close={() => {}}/>);
  await user.type(await screen.findByLabelText("Helper pairing code"), "secret");
  await user.click(screen.getByRole("button", {name: "Check disk space"}));
  await user.click(await screen.findByRole("checkbox", {name: /Select first/}));
  expect(await screen.findByText(/5.0 GB available/)).toBeVisible();
  await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
  calls.check.mockResolvedValue(result(1e9));
  await user.click(screen.getByRole("button", {name: "Download selected"}));
  expect(await screen.findByText(/Not enough available disk space/)).toBeVisible();
  expect(calls.start).not.toHaveBeenCalled();
  await waitFor(() => expect(calls.check).toHaveBeenCalledTimes(2));
});

it("does not download to a changed connection after checking another computer", async () => {
  const user = userEvent.setup(); render(<Onboarding featureId="relight" doctor={doctor} checking={false} locked={false} refresh={async () => {}} connected={async () => {}} close={() => {}}/>);
  await user.type(await screen.findByLabelText("Helper pairing code"), "secret");
  await user.click(screen.getByRole("button", {name: "Check disk space"}));
  await user.click(await screen.findByRole("checkbox", {name: /Select first/}));
  await screen.findByText(/5.0 GB available/);
  await user.click(screen.getByRole("checkbox", {name: /I confirm downloading/}));
  calls.check.mockImplementationOnce(async () => {calls.address = "http://127.0.0.1:8197"; return result(5e9);});
  await user.click(screen.getByRole("button", {name: "Download selected"}));
  expect(await screen.findByText(/ComfyUI connection changed/)).toBeVisible();
  expect(calls.start).not.toHaveBeenCalled();
});


it("requires checksum capability in addition to pairing before enabling verification", async () => {
  const user = userEvent.setup();
  const existingDoctor = {...doctor, model_requirements: [{...model, available: true, installable: false}],
    checks: [{name: "integrity:first", status: "fail", message: "not checked"}]} as unknown as Doctor;
  render(<Onboarding featureId="relight" doctor={existingDoctor} checking={false} locked={false} refresh={async () => {}} connected={async () => {}} close={() => {}}/>);
  await user.type(await screen.findByLabelText("Helper pairing code"), "secret");
  await user.click(screen.getByRole("button", {name: "Pair helper"}));
  expect(screen.queryByRole("button", {name: "Verify model files"})).not.toBeInTheDocument();
  expect(screen.getByText(/checksum checks are unavailable/)).toBeVisible();
});

it("offers verification after an available checksum helper is paired", async () => {
  calls.integrity.mockResolvedValue(true);
  const user = userEvent.setup();
  const existingDoctor = {...doctor, model_requirements: [{...model, available: true, installable: false}],
    checks: [{name: "integrity:first", status: "fail", message: "not checked"}]} as unknown as Doctor;
  render(<Onboarding featureId="relight" doctor={existingDoctor} checking={false} locked={false} refresh={async () => {}} connected={async () => {}} close={() => {}}/>);
  await user.type(await screen.findByLabelText("Helper pairing code"), "secret");
  await user.click(screen.getByRole("button", {name: "Pair helper"}));
  expect(await screen.findByRole("button", {name: "Verify model files"})).toBeEnabled();
});


it("offers an explicitly acknowledged manual fallback and the helper download", async () => {
  calls.supports.mockResolvedValue(false);
  calls.integrity.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {status: 404})));
  const user = userEvent.setup();
  const existingDoctor = {...doctor, model_requirements: [{...model, available: true, installable: false}],
    checks: [{name: "integrity:first", status: "fail", message: "not checked"}]} as unknown as Doctor;
  const refresh = vi.fn(async () => {});
  render(<Onboarding featureId="relight" doctor={existingDoctor} checking={false} locked={false} refresh={refresh} connected={async () => {}} close={() => {}}/>);
  expect(await screen.findByRole("link", {name: /Download or update MarcoStudio nodes/})).toHaveAttribute("download");
  const button = screen.getByRole("button", {name: "Continue without verification"});
  expect(button).toBeDisabled();
  await user.click(screen.getByRole("checkbox", {name: /I understand these model files have not been verified/}));
  await user.click(button);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("retains pairing across modal close and allows explicit unpair", async () => {
  const user = userEvent.setup();
  const props = {featureId: "relight" as const, doctor, checking: false, locked: false, refresh: async () => {}, connected: async () => {}, close: () => {}};
  const view = render(<Onboarding {...props}/>);
  await user.type(await screen.findByLabelText("Helper pairing code"), "secret");
  await user.click(screen.getByRole("button", {name: "Check disk space"}));
  view.unmount();
  render(<Onboarding {...props}/>);
  expect(await screen.findByRole("button", {name: "Unpair helper"})).toBeVisible();
  await user.click(screen.getByRole("button", {name: "Unpair helper"}));
  expect(await screen.findByLabelText("Helper pairing code")).toBeVisible();
});


it("offers helper download even when every model is missing", async () => {
  calls.integrity.mockResolvedValue(false);
  render(<Onboarding featureId="relight" doctor={doctor} checking={false} locked={false} refresh={async () => {}} connected={async () => {}} close={() => {}}/>);
  expect(await screen.findByRole("link", {name: /Download or update MarcoStudio nodes/})).toHaveAttribute("download");
});
