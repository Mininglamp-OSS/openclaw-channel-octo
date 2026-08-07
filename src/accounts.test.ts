import { describe, expect, it } from "vitest";
import { resolveOctoAccount } from "./accounts.js";

describe("resolveOctoAccount server-owned card policy", () => {
  it("ignores legacy local card policy fields", () => {
    const cfg = {
      channels: {
        octo: {
          botToken: "root-token",
          reasoningCardTemplateMode: "shadow",
          accounts: {
            a1: { botToken: "a1-token", reasoningCardTemplateMode: "experimental" },
            a2: { botToken: "a2-token" },
          },
        },
      },
    };

    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a1" }).config)
      .not.toHaveProperty("reasoningCardTemplateMode");
    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a2" }).config)
      .not.toHaveProperty("reasoningCardTemplateMode");
  });
});
