import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOT_INSTANCE_CONFLICT_CODE,
  getOrCreateInstanceId,
  instanceIdPath,
  isBotInstanceConflictError,
} from "./instance-id.js";
import { OctoApiError } from "./api-error.js";

const dirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "octo-instance-id-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("getOrCreateInstanceId", () => {
  it("persists one stable installation ID with private permissions", async () => {
    const stateDir = await tempStateDir();
    const first = await getOrCreateInstanceId({ stateDir });
    const second = await getOrCreateInstanceId({ stateDir });

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readFile(instanceIdPath({ stateDir }), "utf8")).trim()).toBe(first);
    expect((await stat(instanceIdPath({ stateDir }))).mode & 0o777).toBe(0o600);
  });

  it("converges concurrent first starts on the same ID", async () => {
    const stateDir = await tempStateDir();
    const ids = await Promise.all(
      Array.from({ length: 16 }, () => getOrCreateInstanceId({ stateDir })),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("fails closed when persisted state is malformed", async () => {
    const stateDir = await tempStateDir();
    const file = instanceIdPath({ stateDir });
    await getOrCreateInstanceId({ stateDir });
    await writeFile(file, "corrupt\n", "utf8");

    await expect(getOrCreateInstanceId({ stateDir })).rejects.toThrow(
      "Octo instance ID file is invalid",
    );
  });

  it("prefers OPENCLAW_STATE_DIR and supports OPENCLAW_HOME", () => {
    expect(instanceIdPath({ env: { OPENCLAW_STATE_DIR: "/state", OPENCLAW_HOME: "/home" }, home: "/fallback" }))
      .toBe("/state/octo/instance-id");
    expect(instanceIdPath({ env: { OPENCLAW_HOME: "/home" }, home: "/fallback" }))
      .toBe("/home/octo/instance-id");
    expect(instanceIdPath({ env: {}, home: "/fallback" }))
      .toBe("/fallback/.openclaw/octo/instance-id");
  });
});

describe("isBotInstanceConflictError", () => {
  it("matches only the stable register conflict contract", () => {
    const conflict = OctoApiError.from(
      { status: 409 },
      "/v1/bot/register?force_refresh=true",
      JSON.stringify({ error: { code: BOT_INSTANCE_CONFLICT_CODE } }),
    );
    expect(isBotInstanceConflictError(conflict)).toBe(true);
    expect(isBotInstanceConflictError(OctoApiError.from({ status: 409 }, "/other", conflict.body)))
      .toBe(false);
    expect(isBotInstanceConflictError(OctoApiError.from({ status: 500 }, "/v1/bot/register", conflict.body)))
      .toBe(false);
  });
});
