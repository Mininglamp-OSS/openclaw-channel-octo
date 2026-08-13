import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOC_TASKS_DESCRIPTION, DOCS_API_URL_DESCRIPTION, OctoConfigJsonSchema } from "./config-schema.js";

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

  it("does not advertise the deprecated local card policy fields", () => {
    const manifestProps = manifest.channelConfigs.octo.schema.properties;
    const manifestAccountProps = manifestProps.accounts.additionalProperties.properties;
    const tsProps = OctoConfigJsonSchema.schema.properties as Record<string, any>;
    const tsAccountProps = (tsProps.accounts as any).additionalProperties.properties;
    for (const key of ["cardProgress", "reasoningCardTemplateMode", "cardDisplay", "cardInteraction"]) {
      expect(tsProps[key]).toBeUndefined();
      expect(tsAccountProps[key]).toBeUndefined();
      expect(manifestProps[key]).toBeUndefined();
      expect(manifestAccountProps[key]).toBeUndefined();
    }
  });

  // §1.4 收口:本 PR 新增的两个 key 自己没有描述钉子,而它们的描述在 config-schema.ts 和
  // openclaw.plugin.json 里各存了一份 —— 通用的那条只断言 key 存在、不比描述文本,所以两份
  // 会悄悄漂移。这里按 key 把两侧描述钉到 config-schema 的单一来源上。
  it.each([
    ["docTasks", DOC_TASKS_DESCRIPTION],
    ["docsApiUrl", DOCS_API_URL_DESCRIPTION],
  ])("%s description matches at top-level and per-account", (key, expected) => {
    const manifestProps = manifest.channelConfigs.octo.schema.properties;
    const manifestAccountProps = manifestProps.accounts.additionalProperties.properties;
    const tsProps = OctoConfigJsonSchema.schema.properties as Record<string, any>;
    const tsAccountProps = (tsProps.accounts as any).additionalProperties.properties;

    expect(tsProps[key]?.description).toBe(expected);
    expect(tsAccountProps[key]?.description).toBe(expected);
    expect(manifestProps[key]?.description).toBe(expected);
    expect(manifestAccountProps[key]?.description).toBe(expected);
  });

  // Description drift guard: secretsFileRoot carries operator-facing semantics
  // (the write-secret jail default + fail-closed behavior). A stale manifest
  // description here drifts from the schema, so pin both copies to
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
