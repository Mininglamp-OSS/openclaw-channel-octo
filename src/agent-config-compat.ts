/** The host moved per-agent configuration from list[] to entries in 2026.10. */
export type CompatibleAgentEntry = {
  id?: string;
  workspace?: string;
  reasoningDefault?: string;
};
export type CompatibleAgentsConfig = {
  entries?: Record<string, CompatibleAgentEntry>;
  list?: CompatibleAgentEntry[];
};

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "main";
  const lower = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return lower;
  return lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "main";
}

export function findAgentConfig(agents: unknown, agentId: string): CompatibleAgentEntry | undefined {
  if (!agents || typeof agents !== "object") return undefined;
  const config = agents as CompatibleAgentsConfig;
  const id = normalizeAgentId(agentId);
  if (config.entries) {
    return Object.entries(config.entries).find(([key]) => normalizeAgentId(key) === id)?.[1];
  }
  return config.list?.find(entry => entry.id != null && normalizeAgentId(entry.id) === id);
}
