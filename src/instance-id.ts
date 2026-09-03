import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OctoApiError } from "./api-error.js";

export const BOT_INSTANCE_CONFLICT_CODE = "err.server.bot_api.instance_conflict";
export const BOT_INSTANCE_CONFLICT_MESSAGE =
  "This Bot Token is already bound to another OpenClaw instance. Rotate the token to transfer it.";

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function configuredStateDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.OPENCLAW_STATE_DIR?.trim() || env.OPENCLAW_HOME?.trim();
  if (!configured) return join(home, ".openclaw");
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function instanceIdPath(options?: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const root = options?.stateDir ?? configuredStateDir(
    options?.env ?? process.env,
    options?.home ?? homedir(),
  );
  return join(root, "octo", "instance-id");
}

function parseInstanceID(raw: string, file: string): string {
  const value = raw.trim();
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw new Error(`Octo instance ID file is invalid: ${file}`);
  }
  return value;
}

async function readInstanceID(file: string): Promise<string> {
  return parseInstanceID(await readFile(file, "utf8"), file);
}

/**
 * Return the stable ID for this OpenClaw installation.
 *
 * A fully written temporary file is hard-linked into place so concurrent first
 * starts cannot observe a partially written winner. Existing unreadable or
 * malformed state fails closed: silently replacing it would make the server
 * see this installation as a different owner.
 */
export async function getOrCreateInstanceId(options?: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<string> {
  const file = instanceIdPath(options);
  try {
    return await readInstanceID(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
  }

  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const candidate = randomUUID();
  const temp = join(dir, `.instance-id.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${candidate}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temp, file);
    return candidate;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
    return await readInstanceID(file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export function isBotInstanceConflictError(err: unknown): err is OctoApiError {
  return (
    err instanceof OctoApiError &&
    err.status === 409 &&
    err.code === BOT_INSTANCE_CONFLICT_CODE &&
    err.path.startsWith("/v1/bot/register")
  );
}
