import { describe, it, expect } from "vitest";
import {
  OCTO_TOOL_AVAILABILITY_HINT,
  _buildToolAvailabilityHint,
} from "../../index.js";

/**
 * Issue #137: under a restrictive tools.profile (minimal/coding/messaging),
 * OpenClaw does not register plugin tools, so `octo_management` disappears and
 * the bot mis-attributes the gap ("Octo can't do this" → suggests another
 * platform / pasting a plaintext secret). We inject a self-diagnostic section
 * via before_prompt_build's prependSystemContext (which, unlike messageToolHints,
 * is NOT gated behind the `message` tool being available). The section must only
 * be injected for octo sessions (before_prompt_build is a global hook).
 */
describe("issue #137 — octo_management tool-availability diagnostic hint", () => {
  it("the hint explains the real cause and forbids the wrong fallbacks", () => {
    const h = OCTO_TOOL_AVAILABILITY_HINT;
    // names the tool
    expect(h).toContain("octo_management");
    // attributes to tool policy / profile, not a missing feature
    expect(h).toMatch(/tools\.profile|tool policy|alsoAllow/);
    // points at the explicit allow path
    expect(h).toContain("alsoAllow");
    // forbids the two wrong fallbacks seen in the wild
    expect(h.toLowerCase()).toContain("plaintext");
    expect(h.toLowerCase()).toMatch(/another platform|switching to/);
  });

  it("returns the hint when the message provider is octo", () => {
    expect(_buildToolAvailabilityHint("octo")).toBe(OCTO_TOOL_AVAILABILITY_HINT);
  });

  it("returns null for non-octo providers, and for a raw conversation id", () => {
    // Gate is on messageProvider (the provider name), not channelId — which in
    // this hook ctx is the per-conversation raw id. Other providers and any
    // stray group_no/uid value must NOT get the Octo-specific note.
    expect(_buildToolAvailabilityHint("telegram")).toBeNull();
    expect(_buildToolAvailabilityHint("webchat")).toBeNull();
    expect(_buildToolAvailabilityHint("g_123456")).toBeNull(); // looks like a group id
    expect(_buildToolAvailabilityHint(undefined)).toBeNull();
    expect(_buildToolAvailabilityHint("")).toBeNull();
  });
});
