import { describe, it, expect } from "vitest";
import { stripAllChannelPrefixes } from "./constants.js";

describe("stripAllChannelPrefixes", () => {
  it("strips octo: prefix", () => {
    expect(stripAllChannelPrefixes("octo:grp1")).toBe("grp1");
  });

  it("strips channel: prefix", () => {
    expect(stripAllChannelPrefixes("channel:grp1")).toBe("grp1");
  });

  it("strips group: prefix", () => {
    expect(stripAllChannelPrefixes("group:grp1")).toBe("grp1");
  });

  it("strips prefix from thread channelId (groupNo____shortId)", () => {
    expect(stripAllChannelPrefixes("octo:grp1____topicA")).toBe("grp1____topicA");
    expect(stripAllChannelPrefixes("channel:grp1____topicA")).toBe("grp1____topicA");
    expect(stripAllChannelPrefixes("group:grp1____topicA")).toBe("grp1____topicA");
  });

  it("returns input unchanged when no known prefix is present", () => {
    expect(stripAllChannelPrefixes("grp1")).toBe("grp1");
    expect(stripAllChannelPrefixes("grp1____topicA")).toBe("grp1____topicA");
    expect(stripAllChannelPrefixes("")).toBe("");
  });

  it("strips only the leading prefix, not embedded substrings", () => {
    // The function must not nuke `octo:` / `channel:` / `group:` from the middle
    // of a string — e.g. an inline mention suffix or a comment-shaped id.
    expect(stripAllChannelPrefixes("grp1@octo:should-survive")).toBe("grp1@octo:should-survive");
    expect(stripAllChannelPrefixes("grp1____group:not-a-prefix")).toBe("grp1____group:not-a-prefix");
  });

  it("strips stacked prefixes recursively (intentionally broader than the old chained replace)", () => {
    // The previous threadId-parsing site at src/actions.ts did:
    //   stripChannelPrefix(...).replace(/^group:/, "").replace(/^channel:/, "")
    // That chain collapsed SOME stacked forms (e.g. "octo:group:topicA" → "topicA")
    // but NOT all (e.g. "channel:octo:grp1" → "octo:grp1" — only the final
    // channel: replace stripped the outer layer and the chain never re-ran
    // octo: against the now-exposed inner prefix). The recursive helper is
    // intentionally broader: it canonicalizes any order of stacked runtime
    // prefixes. Safer for downstream comparisons, and matches the helper's
    // "all channel prefixes" name.
    expect(stripAllChannelPrefixes("octo:group:grp1")).toBe("grp1");
    expect(stripAllChannelPrefixes("channel:octo:grp1")).toBe("grp1");
    expect(stripAllChannelPrefixes("octo:channel:group:grp1____topicA")).toBe("grp1____topicA");
  });

  it("is fully idempotent — calling twice yields the same result as once", () => {
    for (const id of ["grp1", "octo:grp1", "channel:grp1____topicA", "octo:group:grp1"]) {
      expect(stripAllChannelPrefixes(stripAllChannelPrefixes(id))).toBe(stripAllChannelPrefixes(id));
    }
  });
});
