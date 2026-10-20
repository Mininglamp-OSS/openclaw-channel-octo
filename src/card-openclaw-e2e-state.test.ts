import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireCardE2ERunState } from "../e2e/card-run-state.mjs";
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile,
}));
const runId = "abcdef12-3456-4789-abcd-ef1234567890";
const root = `/var/lib/octo-host-e2e/runs/${runId}`;
const state = {
  OCTO_E2E_CONTAINER: "synthetic-dedicated-container", OCTO_E2E_TARGET_UID: "synthetic-user",
  OCTO_E2E_RUN_ID: runId, OCTO_E2E_PROFILE: `${root}/profile`,
  OCTO_E2E_REQUEST_ROOT: `${root}/requests`, OCTO_E2E_GATEWAY_LOG: `${root}/gateway.log`,
};
beforeEach(() => {
  vi.resetModules(); execFile.mockClear();
  vi.stubEnv("OCTO_OPENCLAW_E2E", "1");
  for (const [key, value] of Object.entries(state)) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("accepts the exact runner-generated namespace without invoking Docker", () => {
  expect(requireCardE2ERunState(state)).toEqual({ container: state.OCTO_E2E_CONTAINER,
    targetUid: state.OCTO_E2E_TARGET_UID, runId, profile: `${root}/profile`,
    requestRoot: `${root}/requests`, gatewayLog: `${root}/gateway.log` });
  expect(execFile).not.toHaveBeenCalled();
});
for (const key of Object.keys(state)) {
  for (const value of [undefined, "", "  "]) it(`enabled suite refuses ${key}=${JSON.stringify(value)} before Docker`, async () => {
    vi.stubEnv(key, value);
    await expect(import("./card-openclaw-e2e.test.ts")).rejects.toThrow(key);
    expect(execFile).not.toHaveBeenCalled();
  });
}
it.each([
  ["OCTO_E2E_RUN_ID", "not-a-run-uuid"],
  ["OCTO_E2E_CONTAINER", "--privileged"],
  ["OCTO_E2E_PROFILE", "/root/.openclaw-dev"],
  ["OCTO_E2E_PROFILE", `${root}/profile/../profile`],
  ["OCTO_E2E_REQUEST_ROOT", "/tmp/octo-host-e2e"],
  ["OCTO_E2E_GATEWAY_LOG", "/tmp/gateway.log"],
  ["OCTO_E2E_REQUEST_ROOT", `/var/lib/octo-host-e2e/runs/12345678-1234-1234-1234-123456789abc/requests`],
])("enabled suite refuses inconsistent %s before Docker", async (key, value) => {
  vi.stubEnv(key, value);
  await expect(import("./card-openclaw-e2e.test.ts")).rejects.toThrow(key);
  expect(execFile).not.toHaveBeenCalled();
});
