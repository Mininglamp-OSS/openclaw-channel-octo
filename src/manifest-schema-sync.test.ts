import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OctoConfigJsonSchema } from "./config-schema.js";

// Regression guard for OpenClaw v2026.5.x channel manifest requirement:
// openclaw.plugin.json#channelConfigs.octo.schema must stay in sync
// with OctoConfigJsonSchema, otherwise the Control UI / config validator
// and the runtime zod pipeline disagree.

describe("openclaw.plugin.json channelConfigs", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "..", "openclaw.plugin.json"), "utf-8"),
  );

  it("declares channelConfigs.octo.schema", () => {
    expect(manifest.channelConfigs?.octo?.schema).toBeDefined();
  });

  it("manifest schema properties match OctoConfigJsonSchema properties", () => {
    const manifestProps = manifest.channelConfigs.octo.schema.properties;
    const tsProps = OctoConfigJsonSchema.schema.properties;
    // Key-level compare — catches additions/removals on either side
    expect(Object.keys(manifestProps).sort()).toEqual(Object.keys(tsProps).sort());
  });

  it("manifest accounts schema matches OctoConfigJsonSchema accounts", () => {
    const manifestAccountProps =
      manifest.channelConfigs.octo.schema.properties.accounts.additionalProperties.properties;
    const tsAccountProps =
      (OctoConfigJsonSchema.schema.properties.accounts as any).additionalProperties.properties;
    expect(Object.keys(manifestAccountProps).sort()).toEqual(
      Object.keys(tsAccountProps).sort(),
    );
  });

  // Description drift guard: secretsFileRoot carries operator-facing semantics
  // (the write-secret jail default + fail-closed behavior). A stale manifest
  // description here is what Jerry-Xin flagged on PR#92, so pin both copies to
  // the single source of truth in OctoConfigJsonSchema.
  it("secretsFileRoot description matches between manifest and OctoConfigJsonSchema", () => {
    const tsDesc = (OctoConfigJsonSchema.schema.properties.secretsFileRoot as any)
      .description as string;
    expect(tsDesc).toBeDefined();
    // Top-level copy.
    expect(
      manifest.channelConfigs.octo.schema.properties.secretsFileRoot.description,
    ).toBe(tsDesc);
    // Per-account copy.
    expect(
      manifest.channelConfigs.octo.schema.properties.accounts.additionalProperties
        .properties.secretsFileRoot.description,
    ).toBe(tsDesc);
    // The new semantics must be reflected (not the old "process working
    // directory" default).
    expect(tsDesc).toMatch(/fail-closed/i);
    expect(tsDesc).toMatch(/workspace/i);
    expect(tsDesc).not.toMatch(/defaults to the plugin process working directory/i);
  });
});
