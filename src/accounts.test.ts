import { describe, expect, it } from "vitest";
import { resolveOctoAccount } from "./accounts.js";

describe("resolveOctoAccount reasoning card template mode", () => {
  it("uses the account override before the channel default", () => {
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

    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a1" }).config.reasoningCardTemplateMode)
      .toBe("experimental");
    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a2" }).config.reasoningCardTemplateMode)
      .toBe("shadow");
  });
});
