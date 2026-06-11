/**
 * Octo Management agent tool.
 *
 * Registered via `agentTools` on the channel plugin, this tool gives the LLM
 * direct access to Octo group management operations without going through
 * the `message` tool action routing (which only supports a fixed whitelist of
 * action names in OpenClaw core).
 *
 * Operations: list-groups, group-info, group-members, group-md-read, group-md-update,
 * thread management, voice-context, etc.
 */

import {
  listOctoAccountIds,
  resolveOctoAccount,
  resolveDefaultOctoAccountId,
} from "./accounts.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  getGroupMd,
  updateGroupMd,
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  searchSpaceMembers,
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listThreadMembers,
  joinThread,
  leaveThread,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
  getThreadMd,
  updateThreadMd,
  resolveSecret,
  resolveTargetsByName,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate, broadcastThreadMdUpdate, getKnownGroupIds } from "./group-md.js";
import type { TargetCandidate } from "./types.js";
import { mkdir, realpath, lstat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  parse as parsePath,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk";
// 🔴 Canonical, platform-owned agent-workspace resolver. This is the SAME logic
// the OpenClaw host uses to decide where an agent's workspace lives, so the
// write-secret jail default stays in lock-step with the platform instead of a
// hand-rolled re-derivation that drifts (the source of the non-default-agent
// jail-escape + symlink-normalization bugs this rework fixes). It encodes:
//   • default agent  → agents.defaults.workspace (or the agent's own workspace);
//   • non-default    → agents.defaults.workspace/<normalizedAgentId> (per-agent
//                      subdir — never the bare shared parent);
//   • `~` home expansion via resolveUserPath.
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";

/**
 * Placeholder token replaced by the resolved plaintext secret inside the
 * caller-supplied write template. Using an explicit token keeps the LLM in
 * control of *how* the secret is laid out in the file (env line, JSON field,
 * raw value, …) while the plaintext itself only ever materializes inside the
 * tool, never in the tool's arguments or return value.
 */
const SECRET_PLACEHOLDER = "{{secret}}";

/**
 * Permissions for a freshly created secret file: owner read/write only (0o600).
 * A file that now holds a plaintext API key must not be world/group readable.
 */
const SECRET_FILE_MODE = 0o600;

/**
 * Containment test: is `candidate` the jail `root` itself or a path strictly
 * beneath it?
 *
 * We use `path.relative(root, candidate)` rather than string-prefix matching on
 * `root + sep`. The prefix form has two failure modes that BOTH bit us in
 * production:
 *   • `root === "/"` makes `root + sep === "//"`, so `candidate.startsWith("//")`
 *     is false for every real path → the jail rejects everything (self-lock).
 *   • Patching that special-case the other way (treating `/` as "always inside")
 *     turns the jail into a no-op fail-open.
 * `path.relative` has neither pathology: the candidate is inside the root iff
 * the relative path is empty (candidate === root), does not start with `..`
 * (would climb out), and is not itself absolute (different root / drive on
 * Windows). The same predicate is reused at every containment site (lexical
 * check, symlink walk, post-mkdir re-check) so they cannot drift apart.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Confine a caller-supplied write target to an operator-approved jail root.
 *
 * 🔴 SECURITY (P0): `filePath` comes from the LLM tool call, which is reachable
 * via inbound group-chat messages — an untrusted, prompt-injectable surface.
 * Without confinement, `write-secret` is an arbitrary-file-write of the owner's
 * plaintext secret (e.g. "append my key to ~/.bashrc" / ".ssh/authorized_keys"
 * / a web root). The OWNER may have triggered the conversation, but the caller
 * that actually picks `filePath`/`template` is a prompt-injectable LLM driven by
 * arbitrary group-chat members, so OS-level "owner can write anyway" reasoning
 * does NOT make the jail redundant — it is the only boundary between an injected
 * instruction and an arbitrary owner-writable file.
 *
 * 🔴 FAIL-CLOSED: the jail root is resolved by the caller — an explicit
 * `secretsFileRoot` if configured, otherwise the agent's workspace (see
 * resolveAgentWorkspaceRoot). There is deliberately NO fallback to
 * `process.cwd()`: a CWD of `/` is exactly what produced the historical
 * self-lock and fail-open bugs, and silently writing owner secrets under
 * whatever directory the process happens to run in is itself unsafe. If neither
 * an explicit root nor a workspace resolves to a usable (non-root) directory,
 * we refuse the write outright rather than guess one.
 *
 * When a root IS configured, we reject anything that escapes it — `..`
 * traversal, absolute paths pointing elsewhere, and symlink escapes (resolved,
 * dangling, or otherwise unverifiable). The actual write additionally uses
 * O_NOFOLLOW to defeat a TOCTOU swap between this check and the write.
 *
 * Returns the safe absolute path, or an error string describing the rejection
 * (never echoing secret material — only the caller-typed path).
 */
async function confineSecretPath(
  filePath: string,
  rootInput: string | undefined,
): Promise<{ ok: true; abs: string; root: string } | { ok: false; error: string }> {
  // 🔴 FAIL-CLOSED: no operator-configured root → refuse. Never fall back to
  // process.cwd() (the source of the `/`-degenerate self-lock + fail-open bugs).
  const rootRaw = rootInput?.trim();
  if (!rootRaw) {
    return {
      ok: false,
      error:
        "write-secret is not configured: no jail root could be resolved. Set an explicit secretsFileRoot (the directory secrets may be written under), or configure the agent's workspace via agents.list[].workspace or agents.defaults.workspace, before this action can be used.",
    };
  }

  // Resolve the configured root to an absolute, symlink-free canonical form so
  // containment checks compare apples to apples. 🔴 We canonicalize through the
  // NEAREST EXISTING ANCESTOR rather than `realpath(root)` outright: on a
  // workspace-default jail's first write the root directory often doesn't exist
  // yet, and a plain realpath() would throw ENOENT and leave us with the LEXICAL
  // (un-canonicalized) form. That lexical root later diverges from the
  // post-mkdir `realpath(dir)` whenever any ancestor is a symlink (macOS
  // `/tmp`→`/private/tmp`, container bind-mounts, a symlinked `$HOME`),
  // false-rejecting a legitimate write as "escaped the allowed root after
  // creation". Canonicalizing the existing prefix makes both sides symlink-free.
  const root = await canonicalizeThroughExisting(rootRaw);

  // Resolve the requested path against the root. resolvePath collapses any
  // `..`/`.` segments; an absolute `filePath` replaces the root entirely, which
  // the containment check below then rejects unless it still lands inside root.
  const candidate = resolvePath(root, filePath);

  // Lexical containment (path.relative form): candidate must be the root itself
  // or sit strictly beneath it. This defeats `..` traversal and
  // absolute-elsewhere without the `root + sep` self-lock/fail-open pitfalls.
  if (!isInsideRoot(root, candidate)) {
    return {
      ok: false,
      error: `Refusing to write the secret outside the allowed directory. "${filePath}" resolves outside the permitted root. Use a path inside the workspace.`,
    };
  }

  // Symlink-escape guard: walk the path one component at a time, from the root
  // down to the target. At each component that exists on disk:
  //   • a symlink whose canonical target stays inside the jail → keep walking;
  //   • a symlink whose canonical target escapes the jail       → reject;
  //   • a symlink that does NOT resolve (dangling / unverifiable) → reject
  //     UNCONDITIONALLY. This is the key fix: a dangling symlink inside the jail
  //     (lstat() succeeds, isSymbolicLink()=true, but realpath() throws ENOENT
  //     because the target does not exist yet) would otherwise be mistaken for
  //     "a plain file that will be created here". writeFile() FOLLOWS the link
  //     and creates the plaintext secret at the link's out-of-jail target. We
  //     never trust a symlink we cannot prove lands inside the jail.
  //   • a component that simply does not exist (ENOENT on lstat itself, not a
  //     symlink) → it and everything below it will be freshly created as plain
  //     entries inside the already-validated jail, so we can stop walking.
  const rel = candidate === root ? "" : relative(root, candidate);
  const segments = rel ? rel.split(sep) : [];
  let current = root;
  for (const seg of segments) {
    current = `${current}${sep}${seg}`;
    let st;
    try {
      st = await lstat(current);
    } catch {
      // This component does not exist. Deeper components don't either; they will
      // be created as plain files/dirs inside the validated jail. Safe to stop.
      break;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(current);
      } catch {
        // Dangling or otherwise unverifiable symlink — never trust it.
        return {
          ok: false,
          error: `Refusing to write the secret: "${filePath}" passes through a symlink that cannot be verified to stay inside the allowed directory.`,
        };
      }
      if (!isInsideRoot(root, real)) {
        return {
          ok: false,
          error: `Refusing to write the secret: "${filePath}" resolves through a symlink that escapes the allowed directory.`,
        };
      }
      // Symlink stays inside the jail: deeper components are re-checked on the
      // next iterations (lstat naturally follows this contained intermediate
      // link), so continue.
    }
  }

  return { ok: true, abs: candidate, root };
}

/**
 * Canonical agent-id matcher, aligned with the platform's `normalizeAgentId`
 * (openclaw/plugin-sdk/routing). Agent entries in `cfg.agents.list[]` are keyed
 * by OpenClaw agent id, which is lower-cased and slug-normalized; comparing raw
 * strings (the previous `a.id === agentAccountId`) misses legitimate matches
 * whenever casing or punctuation differs. We normalize BOTH sides before
 * comparison so the match key lives in the same namespace as the platform.
 */
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "main";
  const lower = trimmed.toLowerCase();
  if (VALID_AGENT_ID_RE.test(trimmed)) return lower;
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

/**
 * Expand `$VAR` / `${VAR}` (POSIX) and `%VAR%` (Windows) against the process
 * environment, returning `undefined` if ANY referenced variable is undefined.
 *
 * The platform's canonical `resolveAgentWorkspaceDir` (via `resolveUserPath`)
 * expands a leading `~` but does NOT substitute environment variables, so an
 * operator who parameterizes a workspace as `${SECRETS_BASE}/octo` would
 * otherwise get a literal `./${SECRETS_BASE}` directory. We pre-expand env vars
 * on the configured workspace string BEFORE handing it to the platform resolver.
 *
 * 🔴 FAIL-CLOSED on an UNDEFINED variable. Leaving an unresolved `${UNDEF}` as a
 * literal segment is NOT safe: `path.resolve("${UNDEF}/octo")` silently anchors
 * the relative remainder to `process.cwd()`, which would sail past the
 * filesystem-root degeneracy guards and rebuild exactly the cwd-anchored jail
 * this PR's fail-closed guarantee exists to prevent. So a reference to a variable
 * the operator never set collapses the whole resolution to `undefined`, and the
 * caller fails closed (refuses the write) rather than guessing a jail root from
 * the process working directory. A string with no variable references at all is
 * returned unchanged.
 */
function expandEnvVars(input: string): string | undefined {
  let missing = false;
  let out = input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => {
      const val = process.env[a ?? b];
      if (val === undefined) {
        missing = true;
        return m;
      }
      return val;
    },
  );
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const val = process.env[name];
    if (val === undefined) {
      missing = true;
      return m;
    }
    return val;
  });
  return missing ? undefined : out;
}

/**
 * Is `p` a filesystem root — POSIX `/` or a Windows drive root like `C:\`?
 *
 * `path.parse(p).root === p` is true exactly for those roots and nothing else,
 * which is why we use it instead of a bare `=== sep` compare: the old check
 * missed Windows drive roots (`resolvePath("C:\\") !== "/"`), and — crucially —
 * it ran on the LEXICAL form, so a workspace configured as a symlink TO `/`
 * (e.g. `/tmp/ws-link` → `/`) sailed past it and only degenerated into a
 * root-wide jail later, inside confineSecretPath's realpath().
 */
function isFilesystemRoot(p: string): boolean {
  return parsePath(p).root === p;
}

/**
 * Canonicalize an absolute path through its NEAREST EXISTING ANCESTOR.
 *
 * `realpath(p)` throws ENOENT the moment any component of `p` does not yet exist
 * — which is the common case for a workspace-default jail on its very first
 * write (the workspace dir hasn't been created). The old code fell back to the
 * LEXICAL (un-canonicalized) form in that case. That produced a subtle but
 * security-relevant inconsistency: the jail root was stored lexically, but the
 * post-mkdir guard later compared it against `realpath(dir)` of the now-created
 * directory. If ANY ancestor was a symlink (macOS `/tmp`→`/private/tmp`, a
 * container bind-mount, a symlinked `$HOME`/workspace), the two diverged and a
 * perfectly legitimate first write was rejected with "destination directory
 * escaped the allowed root after creation".
 *
 * The fix: canonicalize the deepest ancestor that DOES exist, then re-append the
 * still-missing tail. The result is symlink-free for every component that could
 * possibly be a symlink (a not-yet-existing component cannot be one), so a later
 * `realpath` of the created directory compares apples to apples. This neither
 * loosens nor tightens containment — it only makes the root's canonical form
 * consistent with how every downstream check canonicalizes paths.
 */
async function canonicalizeThroughExisting(absInput: string): Promise<string> {
  const abs = resolvePath(absInput);
  let dir = abs;
  const tail: string[] = [];
  // Walk up until we find an ancestor that exists (and can be realpath'd).
  // Stop at the filesystem root regardless.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await realpath(dir);
      return tail.length ? resolvePath(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        // Reached the filesystem root and even it didn't resolve — fall back to
        // the lexical absolute form (no symlink can hide above the root).
        return abs;
      }
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

/**
 * Resolve the DEFAULT jail root for write-secret from the agent's workspace.
 *
 * This is the fallback used when no explicit per-account `secretsFileRoot` is
 * configured (the explicit value is handled by the caller and ALWAYS wins over
 * this default, so an operator can still lock writes to a narrower directory).
 *
 * 🔴 We delegate the actual path derivation to the platform-canonical
 * `resolveAgentWorkspaceDir`, the SAME function the OpenClaw host uses, instead
 * of re-deriving it here. That resolver encodes the per-agent semantics a
 * hand-rolled version kept getting wrong:
 *   • DEFAULT agent → `agents.defaults.workspace` (or its own `workspace`);
 *   • NON-DEFAULT agent with no own workspace → `agents.defaults.workspace/<id>`
 *     — a per-agent SUBDIRECTORY, never the bare shared parent. (The previous
 *     hand-rolled code jailed every non-default agent to the WHOLE
 *     `defaults.workspace`, letting e.g. a `worker` agent write into a sibling
 *     `main/.env` — a cross-agent secret-write escape.)
 * It also applies `~` expansion via `resolveUserPath`.
 *
 * The OpenClaw agent id (`agentId`) is the namespace `cfg.agents.list[]` is
 * keyed by; the channel/Octo account id (`agentAccountId`) is only a fallback
 * for deployments where the two coincide, because account id ≠ agent id in
 * multi-agent setups (e.g. agent `main` ↔ octo account `default`).
 *
 * Two things the platform resolver intentionally does NOT do, which this wrapper
 * adds because a SECRET jail has stricter requirements than a general workspace:
 *   1. ENV-VAR EXPANSION. The resolver expands `~` but not `$VAR`/`${VAR}`, so we
 *      pre-expand env vars on the configured workspace strings first.
 *   2. FAIL-CLOSED. The resolver always SYNTHESIZES a path (e.g.
 *      `~/.openclaw/workspace`) even when nothing is configured. Silently
 *      writing the owner's plaintext secret under a synthesized default the
 *      operator never opted into is unsafe, so we return `undefined` (→ caller
 *      fails closed) unless a workspace is ACTUALLY configured for this agent.
 *
 * 🔴 SECURITY — realpath-after-canon degenerate guard: NEVER falls back to
 * `process.cwd()`. The resolved workspace is realpath-canonicalized and ONLY
 * THEN checked for filesystem-root degeneracy, so a workspace pointing (directly
 * or via symlink) at `/` or a drive root resolves to that root and is rejected
 * here instead of degenerating into a root-wide jail downstream. We also reject
 * when the CONFIGURED BASE is itself a filesystem root, because the platform
 * resolver would turn `defaults.workspace="/"` into `"/<agentId>"` for a
 * non-default agent — a per-agent subdir of `/` is still a root-adjacent jail
 * the operator plainly did not intend. (An operator who *explicitly* sets
 * secretsFileRoot="/" is a separate, deliberate opt-in handled by the caller and
 * is intentionally NOT subject to this default-degeneracy guard.)
 */
async function resolveAgentWorkspaceRoot(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  agentAccountId: string | undefined,
): Promise<string | undefined> {
  const agents = cfg.agents;
  if (!agents) return undefined;

  // Effective agent id: prefer the OpenClaw agent id, fall back to the Octo
  // account id only when the agent id is absent. The platform resolver
  // normalizes this internally, so we pass it through as-is.
  const effectiveId = (agentId ?? agentAccountId)?.trim();
  if (!effectiveId) return undefined;
  const normId = normalizeAgentId(effectiveId);

  // Find this agent's OWN configured workspace (if any) and the shared default,
  // matching the platform's id namespace (lower/slug-normalized).
  const list = agents.list;
  const matched = list?.find(
    (a) => a.id != null && normalizeAgentId(a.id) === normId,
  );
  const ownWorkspaceRaw = matched?.workspace?.trim();
  const defaultWorkspaceRaw = agents.defaults?.workspace?.trim();

  // Determine the EFFECTIVE base the platform resolver will use for this agent,
  // mirroring its precedence: an agent's own workspace wins; otherwise the shared
  // default (which the resolver uses verbatim for the default agent, or appends
  // `/<agentId>` to for a non-default agent).
  const usingOwnWorkspace = Boolean(ownWorkspaceRaw);
  const configuredBaseRaw = ownWorkspaceRaw || defaultWorkspaceRaw;

  // 🔴 FAIL-CLOSED: only proceed when a workspace is ACTUALLY configured for
  // this agent (its own, or a shared default it can inherit). Without this the
  // platform resolver would synthesize `~/.openclaw/workspace` and we'd silently
  // jail secrets under a directory the operator never opted into.
  if (!configuredBaseRaw) return undefined;

  // Env-expand the EFFECTIVE base BEFORE handing it to the platform resolver.
  // 🔴 expandEnvVars FAILS CLOSED on an undefined variable (returns undefined)
  // rather than leaving a literal `${UNDEF}` that `path.resolve` would anchor to
  // process.cwd() and slip past the filesystem-root guards below — so an operator
  // typo / unset var refuses the write instead of silently rebuilding a
  // cwd-anchored jail.
  const configuredBaseExpanded = expandEnvVars(configuredBaseRaw);
  if (configuredBaseExpanded === undefined) return undefined;

  // 🔴 Reject a configured BASE that is a filesystem root up-front: for a
  // non-default agent the platform would append `/<agentId>` and produce a
  // root-adjacent jail (`/<agentId>`), which is just as unintended as a
  // root-wide one. resolveUserPath('~') etc. can't yield a root from a non-root
  // input, so this only catches an explicit `/` / drive-root base.
  if (isFilesystemRoot(resolvePath(configuredBaseExpanded))) {
    return undefined;
  }

  // Hand the platform resolver an env-EXPANDED view of this agent's config so
  // its `~`-expansion + per-agent derivation operate on real path segments. We
  // override ONLY the single workspace field the resolver will actually read for
  // this agent (its own entry, or the shared default), preserving the rest of cfg.
  const resolverCfg: OpenClawConfig = {
    ...cfg,
    agents: {
      ...agents,
      ...(usingOwnWorkspace
        ? {
            list: Array.isArray(list)
              ? list.map((a) =>
                  a.id != null && normalizeAgentId(a.id) === normId
                    ? { ...a, workspace: configuredBaseExpanded }
                    : a,
                )
              : list,
          }
        : {
            defaults: {
              ...agents.defaults,
              workspace: configuredBaseExpanded,
            },
          }),
    },
  } as OpenClawConfig;

  let derived: string;
  try {
    derived = resolveAgentWorkspaceDir(resolverCfg, effectiveId);
  } catch {
    return undefined;
  }
  if (!derived?.trim()) return undefined;

  // Canonicalize through the nearest existing ancestor so the jail root is
  // symlink-free and consistent with the post-mkdir `realpath(dir)` comparison
  // (defeats the symlink-ancestor false-reject) AND so a symlink-to-`/` is
  // caught by the degenerate-root guard below.
  const canonical = await canonicalizeThroughExisting(derived);

  // 🔴 Degenerate-root guard, AFTER canonicalization: a workspace that resolves
  // to a filesystem root must NOT become a root-wide secret jail. Treat it as
  // "no usable default" so the caller fails closed.
  if (isFilesystemRoot(canonical)) return undefined;
  return canonical;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

type LogSink = {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

// ---------------------------------------------------------------------------
// Resolve-targets short-TTL cache
// ---------------------------------------------------------------------------

/**
 * Short-TTL in-process cache for resolveTargetsByName results. The agent often
 * resolves the same name several times within one conversation turn (read it,
 * ask the user, resolve again); a 30s TTL collapses those into a single backend
 * fetch without risking a stale view across turns. Mirrors the reset-hook style
 * of member-cache (`_clearMemberCache`) / owner-registry (`_clearOwnerRegistry`).
 */
const RESOLVE_CACHE_TTL_MS = 30_000;

interface ResolveCacheEntry {
  result: { candidates: TargetCandidate[]; total: number; truncated: boolean };
  expiry: number;
}

const _resolveCache = new Map<string, ResolveCacheEntry>();

/** Visible for testing — clears the resolve-targets cache. */
export function _clearResolveCache(): void {
  _resolveCache.clear();
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createOctoManagementTools(params: {
  cfg?: OpenClawConfig;
  agentAccountId?: string;
  agentId?: string;
}): any[] {
  const cfg = params.cfg;
  const agentAccountId = params.agentAccountId;
  const agentId = params.agentId;
  if (!cfg) return [];

  // Check if any account is configured
  try {
    const ids = listOctoAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveOctoAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }

  const buildTool = (name: string) => ({
    name,
    label: "Octo Management",
    description:
      "Manage Octo groups and personal voice correction context: list groups, get group info/members, " +
      "read or update GROUP.md (group-level and thread-level), and manage personal voice correction context. " +
      "Use this tool for any Octo management operations. " +
      "It also handles user-managed secrets (external API keys): when the user asks to write one of THEIR " +
      "stored keys into a local file, call action 'write-secret' and pass the user's ALIAS for the key " +
      "(the display name they used, e.g. \"my openai key\"), never a raw secret value. The tool fetches the " +
      "current value internally and writes it to the file; the plaintext is NEVER returned to you.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list-groups",
            "group-info",
            "group-members",
            "group-md-read",
            "group-md-update",
            "search-members",
            "resolve",
            "create-group",
            "update-group",
            "add-members",
            "remove-members",
            "create-thread",
            "list-threads",
            "get-thread",
            "delete-thread",
            "list-thread-members",
            "join-thread",
            "leave-thread",
            "thread-md-read",
            "thread-md-update",
            "voice-context-read",
            "voice-context-update",
            "voice-context-delete",
            "write-secret",
          ],
          description: "The management action to perform.",
        },
        groupId: {
          type: "string",
          description:
            "The group_no (group ID). Required for all group-level actions " +
            "(group-info, group-members, group-md-read, group-md-update, update-group, " +
            "add-members, remove-members) and all thread actions " +
            "(create-thread, list-threads, get-thread, delete-thread, list-thread-members, " +
            "join-thread, leave-thread, thread-md-read, thread-md-update). " +
            "Not required for: list-groups, search-members, create-group, voice-context-*.",
        },
        content: {
          type: "string",
          description:
            "The new content. Required for group-md-update, thread-md-update, and voice-context-update.",
        },
        keyword: {
          type: "string",
          description:
            "Search keyword for search-members action. Fuzzy matches user names in the bot's Space.",
        },
        members: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of member UIDs. Required for create-group, add-members, remove-members.",
        },
        name: {
          type: "string",
          description:
            "Group name. Optional for create-group, update-group; for action=resolve it is the target name to search for.",
        },
        kind: {
          type: "string",
          enum: ["group", "thread", "all"],
          description: "For resolve only. Filter candidate kind. Default all.",
        },
        limit: {
          type: "number",
          description:
            "For resolve only. Max candidates (default 20, capped 50 by the server).",
        },
        notice: {
          type: "string",
          description:
            "Group notice/announcement. Optional for update-group.",
        },
        creator: {
          type: "string",
          description:
            "UID of the user who requested group creation (becomes group owner). Required for create-group.",
        },
        threadName: {
          type: "string",
          description: "Thread name. Required for create-thread.",
        },
        shortId: {
          type: "string",
          description:
            "Thread short ID. Required for get-thread, delete-thread, list-thread-members, join-thread, leave-thread, thread-md-read, thread-md-update.",
        },
        accountId: {
          type: "string",
          description:
            "Required when multiple Octo accounts are configured. Use the exact accountId from the current Octo context; casing is normalized when unambiguous. Omit when only one account is configured.",
        },
        alias: {
          type: "string",
          description:
            "For write-secret only. The user's alias for one of THEIR stored secrets — the display name they " +
            "referred to it by (e.g. \"openai key\"), or a secret_id returned by a previous ambiguous result. " +
            "🔴 Pass the alias, NEVER a raw secret value: the tool resolves the current plaintext internally.",
        },
        filePath: {
          type: "string",
          description:
            "For write-secret only. Path of the local file to write the secret into, relative to the " +
            "configured workspace root (e.g. \".env\" or \"config/keys.json\"). Choose the path based on the " +
            "user's instruction. Writes are confined to the workspace root: paths that escape it (via '..', " +
            "an absolute path elsewhere, or a symlink) are rejected.",
        },
        template: {
          type: "string",
          description:
            "For write-secret only. Optional layout for what gets written, with the placeholder " +
            "'{{secret}}' marking where the resolved value goes (e.g. \"OPENAI_API_KEY={{secret}}\\n\" " +
            "or '{\"apiKey\":\"{{secret}}\"}'). If omitted, the raw secret value is written verbatim. " +
            "🔴 Do NOT put the secret value here — only the '{{secret}}' placeholder.",
        },
        mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description:
            "For write-secret only. 'overwrite' (default) replaces the file contents; 'append' adds to the end " +
            "(useful for adding a line to an existing .env). Omit to overwrite.",
        },
      },
      required: ["action"],
    },

    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const action = args.action as string;
      const groupId = (args.groupId ?? args.group_id ?? args.target) as
        | string
        | undefined;
      const content = (args.content ?? args.message) as string | undefined;
      const rawAccountId = (args.accountId as string | undefined) ?? agentAccountId ?? undefined;

      // Treat DEFAULT_ACCOUNT_ID ("default") as a semantic alias — not a
      // real account key — so normalise it to "unspecified".
      // Determine requestedAccountId. The word "default" is both the
      // framework's placeholder constant AND a legitimate config key when
      // the user literally names an account "default". We only strip it
      // when it is NOT an actual configured account.
      const requestedAccountId: string | undefined = (() => {
        if (!rawAccountId) return undefined;
        if (rawAccountId === DEFAULT_ACCOUNT_ID) {
          const ids = listOctoAccountIds(cfg);
          if (ids.includes(DEFAULT_ACCOUNT_ID)) return rawAccountId;
          return undefined;
        }
        return rawAccountId;
      })();

      const knownIds = listOctoAccountIds(cfg);

      // Account routing:
      //   - Single-account: force-route to the only configured account,
      //     regardless of what (if anything) the LLM passed. A stray /
      //     hallucinated accountId can't silently fail auth.
      //   - Multi-account + requested: case-insensitive match against
      //     config keys. Bot IDs generated via util.Ten2Hex are mixed-case
      //     (e.g. "27lZl4QjPzh72d10c8c_bot"); LLMs routinely drop the
      //     capitals in tool calls.
      //   - Multi-account + not requested: require the caller to pick.
      //     Don't silently use the first account — that lets tool calls
      //     target the wrong bot without anyone noticing.
      let accountId: string;
      if (knownIds.length === 1) {
        accountId = knownIds[0];
      } else if (requestedAccountId) {
        // Exact match wins — protects against the pathological case where
        // two accountIds differ only in casing (e.g. "BotA" + "bota"):
        // passing "BotA" must hit the exact one, not whichever sorted
        // first in a lowercase collapse.
        if (knownIds.includes(requestedAccountId)) {
          accountId = requestedAccountId;
        } else {
          const lower = requestedAccountId.toLowerCase();
          const matches = knownIds.filter((id) => id.toLowerCase() === lower);
          if (matches.length === 0) {
            return makeError(
              `Account not found: ${requestedAccountId}. Available: ${knownIds.join(", ")}`,
            );
          }
          if (matches.length > 1) {
            return makeError(
              `Account "${requestedAccountId}" is ambiguous (case-insensitive match hits ${matches.join(", ")}). Pass the exact accountId.`,
            );
          }
          accountId = matches[0];
        }
      } else {
        const defaultId = resolveDefaultOctoAccountId(cfg);
        if (defaultId) {
          accountId = defaultId;
        } else {
          return makeError(
            `Multiple Octo accounts configured; please specify accountId. Available: ${knownIds.join(", ")}`,
          );
        }
      }

      const account = resolveOctoAccount({ cfg, accountId });

      if (!account.config.botToken) {
        return makeError("Octo botToken is not configured for this account");
      }

      const apiUrl = account.config.apiUrl;
      const botToken = account.config.botToken;

      try {
        switch (action) {
          case "list-groups":
            return await handleListGroups({ apiUrl, botToken });

          case "group-info":
            if (!groupId)
              return makeError("groupId is required for group-info");
            return await handleGroupInfo({ apiUrl, botToken, groupId });

          case "group-members":
            if (!groupId)
              return makeError("groupId is required for group-members");
            return await handleGroupMembers({ apiUrl, botToken, groupId });

          case "group-md-read":
            if (!groupId)
              return makeError("groupId is required for group-md-read");
            return await handleGroupMdRead({ apiUrl, botToken, groupId });

          case "group-md-update":
            if (!groupId)
              return makeError("groupId is required for group-md-update");
            if (!content)
              return makeError("content is required for group-md-update");
            return await handleGroupMdUpdate({
              apiUrl,
              botToken,
              groupId,
              content,
              accountId,
            });

          case "search-members": {
            const keyword = (args.keyword ?? args.name ?? args.content) as string | undefined;
            const results = await searchSpaceMembers({
              apiUrl,
              botToken,
              keyword: keyword || undefined,
            });
            return makeSuccess({ members: results });
          }

          case "resolve": {
            const name = (args.name as string | undefined)?.trim();
            if (!name) {
              return makeError("name is required for resolve");
            }
            const rawKind = args.kind as string | undefined;
            if (
              rawKind !== undefined &&
              rawKind !== "group" &&
              rawKind !== "thread" &&
              rawKind !== "all"
            ) {
              return makeError(
                `Invalid kind "${rawKind}" for resolve; use "group", "thread", or "all"`,
              );
            }
            const kind = rawKind as "group" | "thread" | "all" | undefined;
            // Validate limit: accept only a positive integer. Anything else
            // (<=0, NaN, non-integer) is dropped so the backend default applies
            // — never forward a 0 / negative limit into the query.
            let limit: number | undefined;
            if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
              const floored = Math.floor(args.limit);
              if (floored > 0) limit = floored;
            }
            return await handleResolveTargets({
              apiUrl,
              botToken,
              accountId,
              name,
              kind,
              limit,
            });
          }

          case "create-group": {
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for create-group");
            const creatorUid = (args.creator ?? args.creatorUid) as string | undefined;
            if (!creatorUid)
              return makeError("creator is required for create-group");
            const result = await createGroup({
              apiUrl,
              botToken,
              name: (args.name as string | undefined) ?? undefined,
              members,
              creator: creatorUid,
            });
            return makeSuccess(result);
          }

          case "update-group": {
            if (!groupId)
              return makeError("groupId is required for update-group");
            await updateGroup({
              apiUrl,
              botToken,
              groupNo: groupId,
              name: args.name as string | undefined,
              notice: args.notice as string | undefined,
            });
            return makeSuccess({ updated: true, groupId });
          }

          case "add-members": {
            if (!groupId)
              return makeError("groupId is required for add-members");
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for add-members");
            const result = await addGroupMembers({
              apiUrl,
              botToken,
              groupNo: groupId,
              members,
            });
            return makeSuccess(result);
          }

          case "remove-members": {
            if (!groupId)
              return makeError("groupId is required for remove-members");
            const members = args.members as string[] | undefined;
            if (!members?.length)
              return makeError("members is required for remove-members");
            const result = await removeGroupMembers({
              apiUrl,
              botToken,
              groupNo: groupId,
              members,
            });
            return makeSuccess(result);
          }

          // ========== Thread Actions ==========

          case "create-thread": {
            if (!groupId)
              return makeError("groupId is required for create-thread");
            const threadName = (args.threadName ?? args.name) as string | undefined;
            if (!threadName)
              return makeError("threadName is required for create-thread");
            const result = await createThread({
              apiUrl,
              botToken,
              groupNo: groupId,
              name: threadName,
            });
            return makeSuccess(result);
          }

          case "list-threads": {
            if (!groupId)
              return makeError("groupId is required for list-threads");
            const threads = await listThreads({ apiUrl, botToken, groupNo: groupId });
            return makeSuccess({ threads });
          }

          case "get-thread": {
            if (!groupId)
              return makeError("groupId is required for get-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for get-thread");
            const thread = await getThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess(thread);
          }

          case "delete-thread": {
            if (!groupId)
              return makeError("groupId is required for delete-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for delete-thread");
            await deleteThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ deleted: true, groupId, shortId });
          }

          case "list-thread-members": {
            if (!groupId)
              return makeError("groupId is required for list-thread-members");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for list-thread-members");
            const members = await listThreadMembers({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ members });
          }

          case "join-thread": {
            if (!groupId)
              return makeError("groupId is required for join-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for join-thread");
            await joinThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ joined: true, groupId, shortId });
          }

          case "leave-thread": {
            if (!groupId)
              return makeError("groupId is required for leave-thread");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for leave-thread");
            await leaveThread({ apiUrl, botToken, groupNo: groupId, shortId });
            return makeSuccess({ left: true, groupId, shortId });
          }

          case "thread-md-read": {
            if (!groupId)
              return makeError("groupId is required for thread-md-read");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for thread-md-read");
            return await handleThreadMdRead({ apiUrl, botToken, groupId, shortId });
          }

          case "thread-md-update": {
            if (!groupId)
              return makeError("groupId is required for thread-md-update");
            const shortId = args.shortId as string | undefined;
            if (!shortId)
              return makeError("shortId is required for thread-md-update");
            if (!content)
              return makeError("content is required for thread-md-update");
            return await handleThreadMdUpdate({
              apiUrl,
              botToken,
              groupId,
              shortId,
              content,
              accountId,
            });
          }

          case "voice-context-read":
            return await handleVoiceContextRead({ apiUrl, botToken });

          case "voice-context-update": {
            if (
              content === undefined ||
              content === null ||
              content.trim() === ""
            ) {
              return makeError(
                "content is required for voice-context-update and must not be empty",
              );
            }
            return await handleVoiceContextUpdate({
              apiUrl,
              botToken,
              content,
            });
          }

          case "voice-context-delete":
            return await handleVoiceContextDelete({ apiUrl, botToken });

          case "write-secret": {
            const alias = (args.alias as string | undefined)?.trim();
            if (!alias) {
              return makeError("alias is required for write-secret");
            }
            const filePath = (args.filePath as string | undefined)?.trim();
            if (!filePath) {
              return makeError("filePath is required for write-secret");
            }
            const template = args.template as string | undefined;
            // A provided, non-empty template MUST contain the placeholder.
            // Otherwise we'd silently discard the caller's intended layout and
            // write the bare secret — surprising, and prone to malformed config
            // files. Whitespace-only is treated as "omitted" (write raw).
            if (
              template !== undefined &&
              template.trim().length > 0 &&
              !template.includes(SECRET_PLACEHOLDER)
            ) {
              return makeError(
                `template was provided but does not contain the ${SECRET_PLACEHOLDER} placeholder. Include ${SECRET_PLACEHOLDER} where the secret should go, or omit template to write the raw value.`,
              );
            }
            const rawMode = args.mode as string | undefined;
            if (rawMode !== undefined && rawMode !== "overwrite" && rawMode !== "append") {
              return makeError(
                `Invalid mode "${rawMode}" for write-secret; use "overwrite" or "append"`,
              );
            }
            // Jail root resolution (highest priority first):
            //   1. explicit per-account/channel secretsFileRoot (operator can
            //      lock writes to a narrower directory — this always wins).
            //   2. DEFAULT: the agent's workspace, matched by OpenClaw agent id
            //      (cfg.agents.list[].workspace, else cfg.agents.defaults.workspace),
            //      home/env-expanded + realpath-canonicalized.
            // If neither yields a usable non-root directory, confineSecretPath
            // fails closed — there is NO process.cwd() fallback.
            const effectiveSecretsRoot =
              account.config.secretsFileRoot?.trim() ||
              (await resolveAgentWorkspaceRoot(cfg, agentId, agentAccountId));
            return await handleWriteSecret({
              apiUrl,
              botToken,
              alias,
              filePath,
              template,
              mode: rawMode === "append" ? "append" : "overwrite",
              secretsFileRoot: effectiveSecretsRoot,
            });
          }

          default:
            return makeError(`Unknown action: ${action}`);
        }
      } catch (err) {
        return makeError(
          `${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  return [
    buildTool("octo_management"),
  ];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListGroups(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  const groups = await fetchBotGroups({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess({ groups });
}

/**
 * Resolve a NAMED target into concrete channel candidates.
 *
 * Disambiguation is mandatory — this NEVER auto-sends and NEVER silently picks
 * when more than one candidate matches:
 *   • 0 candidates  → not-found result carrying fuzzy name suggestions (so the
 *                     agent can offer "did you mean …?"), nothing sent.
 *   • genuinely unique (1 candidate AND total === 1 AND not truncated)
 *                   → { resolved } echoing kind; the agent must then call send
 *                     with candidate.channelId. Still not sent here.
 *   • anything else (>1 candidates, OR 1 returned but total>1 / truncated)
 *                   → { candidates, total, truncated }; the agent must ask the
 *                     user which one. Not sent here. A single returned candidate
 *                     over a larger match set is NOT treated as unambiguous, so
 *                     a truncated/partial result can never silently auto-resolve.
 *
 * Results are cached for RESOLVE_CACHE_TTL_MS keyed by accountId|name|kind|limit
 * to avoid repeat fetches within one conversation turn.
 */
async function handleResolveTargets(params: {
  apiUrl: string;
  botToken: string;
  accountId: string;
  name: string;
  kind?: "group" | "thread" | "all";
  limit?: number;
}): Promise<ToolResult> {
  // Include the normalized limit in the cache key: a limit:1 lookup returns a
  // bounded page, which must NOT satisfy a later wider (no-limit) lookup for the
  // same name — otherwise the narrow, possibly-truncated result would poison the
  // broader request.
  const limitKey = params.limit == null ? "default" : String(params.limit);
  const cacheKey = `${params.accountId}|${params.name}|${params.kind ?? "all"}|${limitKey}`;
  const cached = _resolveCache.get(cacheKey);
  let result: { candidates: TargetCandidate[]; total: number; truncated: boolean };
  if (cached && cached.expiry > Date.now()) {
    result = cached.result;
  } else {
    result = await resolveTargetsByName({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      name: params.name,
      kind: params.kind,
      limit: params.limit,
    });
    // Only cache POSITIVE (>=1 candidate) results. A 0-candidate miss must NOT
    // be cached: a target freshly created/renamed seconds ago would otherwise be
    // masked by the stale not-found entry for the rest of the 30s TTL.
    if (result.candidates.length > 0) {
      _resolveCache.set(cacheKey, {
        result,
        expiry: Date.now() + RESOLVE_CACHE_TTL_MS,
      });
    }
  }

  const { candidates, total, truncated } = result;

  // 0 candidates → not found. Offer fuzzy suggestions from known group NAMES so
  // the agent can ask "did you mean …?" instead of guessing a group: address.
  if (candidates.length === 0) {
    const suggestions = fuzzyGroupNameSuggestions(params.name);
    return makeSuccess({
      resolved: null,
      candidates: [],
      total: 0,
      error: `No target named "${params.name}" found`,
      suggestions,
    });
  }

  // Genuinely unique → resolved. Require candidates.length === 1 AND total === 1
  // AND not truncated: a single RETURNED candidate over a larger match set (e.g.
  // the agent passed limit:1, or the server truncated) is NOT unambiguous, and
  // auto-resolving it would silently treat a partial result as a confident pick.
  // Echo kind so the agent knows group vs thread. Do NOT auto-send; the agent
  // must call send with candidate.channelId next.
  if (candidates.length === 1 && total === 1 && truncated !== true) {
    return makeSuccess({ resolved: candidates[0] });
  }

  // Otherwise (>1 candidates, OR 1 returned but total>1 / truncated) → return the
  // list; the agent must ask the user which one. Pass truncated through so the
  // agent can suggest refining the name.
  return makeSuccess({ candidates, total, truncated });
}

/**
 * Fuzzy-match a name against the known group NAMES for "did you mean …?"
 * suggestions on a not-found resolve. Intentionally simple: case-insensitive
 * substring match in either direction. getKnownGroupIds() exposes group IDs;
 * when those happen to be human names they match here, otherwise suggestions are
 * empty — which is an acceptable degrade (the agent just gets no hints).
 */
function fuzzyGroupNameSuggestions(name: string): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  for (const known of getKnownGroupIds()) {
    const hay = known.toLowerCase();
    if (hay.includes(needle) || needle.includes(hay)) {
      out.push(known);
    }
  }
  return out;
}

async function handleGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const info = await getGroupInfo({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(info);
}

async function handleGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const members = await getGroupMembers({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess({ members });
}

async function handleGroupMdRead(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const md = await getGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(md);
}

async function handleGroupMdUpdate(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  content: string;
  accountId: string;
}): Promise<ToolResult> {
  const result = await updateGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
    content: params.content,
  });

  // Update disk cache for all agents that have this group
  broadcastGroupMdUpdate({
    accountId: params.accountId,
    groupNo: params.groupId,
    content: params.content,
    version: result.version,
  });

  return makeSuccess({ updated: true, version: result.version });
}

// ---------------------------------------------------------------------------
// Thread MD Handlers
// ---------------------------------------------------------------------------

async function handleThreadMdRead(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  shortId: string;
}): Promise<ToolResult> {
  try {
    const md = await getThreadMd({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      groupNo: params.groupId,
      shortId: params.shortId,
    });
    return makeSuccess(md);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("(404)")) {
      return makeSuccess({ content: "", version: 0, updated_at: null, updated_by: "" });
    }
    return makeError(`Failed to read thread THREAD.md: ${msg}`);
  }
}

async function handleThreadMdUpdate(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  shortId: string;
  content: string;
  accountId: string;
}): Promise<ToolResult> {
  const result = await updateThreadMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
    shortId: params.shortId,
    content: params.content,
  });

  broadcastThreadMdUpdate({
    accountId: params.accountId,
    groupNo: params.groupId,
    shortId: params.shortId,
    content: params.content,
    version: result.version,
  });

  return makeSuccess({ updated: true, version: result.version });
}

// ---------------------------------------------------------------------------
// Voice Context Handlers
// ---------------------------------------------------------------------------

/**
 * Read the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * Returns { has_context, context, updated_at } — normalized by getVoiceContext().
 */
async function handleVoiceContextRead(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  const result = await getVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess(result);
}

/**
 * Set or replace the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * The `content` param is the full voice-context body (not to be confused
 * with GROUP.md content used by group-md-update). Content validation
 * (empty string rejection) is done in the execute() switch before this
 * handler is called.
 */
async function handleVoiceContextUpdate(params: {
  apiUrl: string;
  botToken: string;
  content: string;
}): Promise<ToolResult> {
  await updateVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    content: params.content,
  });
  return makeSuccess({ updated: true });
}

/**
 * Delete the bot owner's personal voice correction context.
 *
 * Operates on the owner associated with the resolved bot account.
 * The `accountId` parameter in the parent execute() selects which bot
 * (and thus which owner) to operate on.
 *
 * Idempotent — deleting non-existent context is not an error.
 */
async function handleVoiceContextDelete(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  await deleteVoiceContext({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess({ deleted: true });
}

// ---------------------------------------------------------------------------
// Secret Write Handler
// ---------------------------------------------------------------------------

/**
 * Resolve a user-managed secret alias and write its current plaintext into a
 * local file.
 *
 * 🔴 RED LINE — plaintext containment (two channels, both closed):
 *   1. Transcript: the resolved value is read from resolveSecret(), substituted
 *      into the (optional) caller template, and written to disk. It is consumed
 *      ENTIRELY inside this function. The ToolResult returned to the LLM
 *      contains only { written, path, mode, display_name? } on success and
 *      structured non-plaintext feedback otherwise — never the value, the
 *      rendered content, or the template-with-secret, so nothing reaches the
 *      transcript / Octo. (No length field either: a byte count is
 *      secret-derived metadata, so we omit it.)
 *   2. Filesystem: `filePath` is attacker-influenceable (the tool is reachable
 *      from inbound chat). confineSecretPath() jails every write under an
 *      operator-approved root, rejecting `..`, absolute-elsewhere, and symlink
 *      escapes (including dangling/unverifiable links) BEFORE the secret is ever
 *      resolved. The write opens the target with O_NOFOLLOW to close any TOCTOU
 *      symlink swap, and the file is created 0o600 so a plaintext key is not
 *      left world/group readable.
 *
 * Use-time resolution: resolveSecret is called on every invocation, so the
 * latest value is always written (owner key rotation takes effect with no
 * restart and no cache to invalidate).
 */
async function handleWriteSecret(params: {
  apiUrl: string;
  botToken: string;
  alias: string;
  filePath: string;
  template?: string;
  mode: "overwrite" | "append";
  secretsFileRoot?: string;
}): Promise<ToolResult> {
  // Confine the destination BEFORE resolving the secret. If the path is unsafe
  // we never fetch the plaintext at all — minimizing its lifetime.
  const confined = await confineSecretPath(params.filePath, params.secretsFileRoot);
  if (!confined.ok) {
    return makeError(confined.error);
  }
  const absPath = confined.abs;
  const root = confined.root;

  let resolved;
  try {
    resolved = await resolveSecret({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      alias: params.alias,
    });
  } catch (err) {
    // resolve failure (5xx / malformed / transport). Surface a non-plaintext,
    // actionable hint. The underlying error carries only an HTTP status (the
    // resolve client deliberately drops response bodies), never a value.
    return makeError(
      `Could not resolve secret "${params.alias}". The key service is unavailable or the secret may need to be re-set. Ask the user to re-add the key, then retry. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  // not_found → guide the user to add the secret first. Echo only the alias the
  // user already typed (not sensitive).
  if (resolved.status === "not_found") {
    return makeError(
      `No stored secret matches "${params.alias}". Ask the user to add this key first (e.g. via the Octo secrets settings), then try again.`,
    );
  }

  // rate_limited → the resolve endpoint's per-IP limiter rejected the call.
  // Surface a transient, actionable hint. 🔴 No body is read on a 429, so this
  // message carries no server-controlled string — only a fixed back-off prompt.
  if (resolved.status === "rate_limited") {
    return makeError(
      `The key service is busy right now (rate limited). Wait a moment and retry write-secret for "${params.alias}".`,
    );
  }

  // ambiguous → hand back ONLY the labels so the LLM can ask the user which one.
  // 🔴 candidates carry display_name (+ secret_id) only, never the value.
  if (resolved.status === "ambiguous") {
    return makeSuccess({
      written: false,
      ambiguous: true,
      message: `Multiple stored secrets match "${params.alias}". Ask the user which one, then retry write-secret with the chosen display_name (or its secret_id).`,
      candidates: resolved.candidates,
    });
  }

  // resolved → substitute into template (or use raw value) and write to disk.
  // From here the plaintext lives only in local variables and the file. A
  // provided template without the placeholder was already rejected upstream, so
  // here `includes` only gates the "template omitted → write raw" case.
  const content =
    params.template && params.template.includes(SECRET_PLACEHOLDER)
      ? params.template.split(SECRET_PLACEHOLDER).join(resolved.value)
      : resolved.value;

  try {
    const dir = dirname(absPath);
    let openTarget = absPath;
    if (dir && dir !== "." && dir !== absPath) {
      await mkdir(dir, { recursive: true });
      // 🔴 TOCTOU close-out for INTERMEDIATE components. O_NOFOLLOW below only
      // protects the final basename — the kernel still follows any symlink on
      // the parent path. confineSecretPath() walked the path BEFORE mkdir, when
      // the parent dirs did not yet exist, so a symlink swapped onto a parent
      // AFTER mkdir creates it (and before open) would redirect the write out of
      // the jail. Re-canonicalize the parent now that it is on disk and re-check
      // containment, then open via the canonical parent + basename so every
      // component is proven to stay inside the root.
      const realDir = await realpath(dir);
      if (!isInsideRoot(root, realDir)) {
        return makeError(
          "Refusing to write the secret: the destination directory escaped the allowed root after creation.",
        );
      }
      openTarget = resolvePath(realDir, basename(absPath));
    }
    // 🔴 TOCTOU close-out for the LEAF: confineSecretPath() validated the path,
    // but between that check and the write an attacker with filesystem access
    // could swap the target for a symlink. We open the final component with
    // O_NOFOLLOW so the kernel refuses to follow a symlink AT the target — the
    // write either lands on the real in-jail file or fails (ELOOP), never on a
    // redirected target. O_CREAT applies the 0o600 mode atomically on creation.
    const flags =
      (params.mode === "append"
        ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND
        : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC) |
      fsConstants.O_NOFOLLOW;
    const handle = await open(openTarget, flags, SECRET_FILE_MODE);
    try {
      await handle.write(content, null, "utf8");
      // writeFile/open's `mode` only applies when CREATING the file; a
      // pre-existing target keeps its old perms. fchmod unconditionally so a
      // plaintext key is always owner-only (0o600), never world-readable.
      await handle.chmod(SECRET_FILE_MODE);
    } finally {
      await handle.close();
    }
  } catch (err) {
    // A write error message can include the path but never the content. Echo the
    // jail-relative path only — never the absolute path, which would leak the
    // operator's jail root into the LLM-visible transcript.
    return makeError(
      `Resolved the secret but failed to write it to "${relative(root, absPath)}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 🔴 Success payload is plaintext-free by construction (no value, no rendered
  // content, no byte length). The path is jail-relative so the absolute jail
  // root is never disclosed to the LLM / transcript.
  return makeSuccess({
    written: true,
    path: relative(root, absPath),
    mode: params.mode,
    ...(resolved.display_name ? { display_name: resolved.display_name } : {}),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccess(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function makeError(error: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    details: { error },
  };
}
