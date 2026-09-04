import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { OctoApiError } from "./api-error.js";

export const BOT_INSTANCE_CONFLICT_CODE = "err.server.bot_api.instance_conflict";
export const BOT_INSTANCE_CONFLICT_MESSAGE =
  "This Bot Token is already bound to another OpenClaw instance. Rotate the token to transfer it.";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function instanceIdPath(options?: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const root = options?.stateDir ?? resolveStateDir(
    options?.env ?? process.env,
    options?.home ? () => options.home! : undefined,
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

async function writeSyncedTemp(file: string, value: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (process.platform === "win32" &&
        (code === "EISDIR" || code === "EINVAL" || code === "EPERM" || code === "ENOTSUP")) {
      return;
    }
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  // Persist the octo/ directory itself before publishing the identity inside
  // it. The OpenClaw state root normally already exists, but octo/ may not.
  await syncDirectory(dirname(dir));
  const candidate = randomUUID();
  const temp = join(dir, `.instance-id.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeSyncedTemp(temp, `${candidate}\n`);
    try {
      await link(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
      const winner = await readInstanceID(file);
      // Another process may have linked the winner but not yet synced the
      // directory. Sync it here as well before this process can register.
      await syncDirectory(dir);
      return winner;
    }
    // fsyncing the file does not make the new directory entry durable. Do not
    // register with the server until the published instance ID survives a
    // crash; losing it after the first claim would require token rotation.
    await syncDirectory(dir);
    return candidate;
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
