import { describe, expect, it } from "vitest";
import { wantsBrowserRuntime } from "./runtimeHint";

describe("wantsBrowserRuntime", () => {
  it("probes for the local service on the loopback hosts it can listen on", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(wantsBrowserRuntime("", host)).toBe(false);
  });

  it("skips the probe on any other host, where no local service can answer", () => {
    for (const host of ["example.com", "192.168.1.20"]) expect(wantsBrowserRuntime("", host)).toBe(true);
  });

  it("skips the probe when the URL asks for the browser runtime", () => {
    expect(wantsBrowserRuntime("?runtime=browser", "127.0.0.1")).toBe(true);
    expect(wantsBrowserRuntime("?runtime=local", "127.0.0.1")).toBe(false);
  });
});
