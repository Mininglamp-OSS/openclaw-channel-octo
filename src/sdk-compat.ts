/**
 * SDK Compatibility Layer
 *
 * Centralizes protocol-level constants that may shift across OpenClaw SDK versions.
 * Types import directly from versioned SDK subpaths (e.g. plugin-sdk/core,
 * plugin-sdk/channel-contract). The bare plugin-sdk aggregate is NOT stable —
 * it was dropped in 2026.8; openclaw-sdk-surface.test.ts pins every subpath we
 * import against the installed openclaw.
 */

/** The framework's default account identifier when none is explicitly specified. */
export const DEFAULT_ACCOUNT_ID = "default" as const;
