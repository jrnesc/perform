import { describe, expect, it } from "vitest";
import { deriveCapabilityStates, liveCapabilityIds } from "./capabilities";

const states = (input: Parameters<typeof deriveCapabilityStates>[0]) =>
  Object.fromEntries(Object.entries(deriveCapabilityStates(input)).map(([id, r]) => [id, r.state]));

describe("live capability states", () => {
  it("reports every capability as fixture-backed by default", () => {
    expect(Object.values(states({ env: {} }))).toEqual(liveCapabilityIds.map(() => "fixture_backed"));
    expect(states({ env: { OAUTH_SCOPES: "read:self read:media" } }).commerce_webhook).toBe("fixture_backed");
  });

  it("does not treat a flag as enough: required scopes must be configured", () => {
    const report = deriveCapabilityStates({
      env: { PERFORM_LIVE_CAPABILITIES: "audience_discovery", OAUTH_SCOPES: "read:chat" },
    });
    expect(report.audience_discovery).toMatchObject({ state: "fixture_backed", missingConfiguredScopes: ["read:fan"] });
  });

  it("needs the webhook signing secret for the commerce webhook", () => {
    const env = { PERFORM_LIVE_CAPABILITIES: "commerce_webhook", OAUTH_SCOPES: "read:creator" };
    expect(states({ env }).commerce_webhook).toBe("fixture_backed");
    expect(states({ env: { ...env, FANVUE_WEBHOOK_SIGNING_SECRET: "s" } }).commerce_webhook).toBe("configured");
  });

  it("climbs the ladder one explicit rung at a time", () => {
    const env = { PERFORM_LIVE_CAPABILITIES: "earnings_reconciliation", OAUTH_SCOPES: "read:insights" };
    const at = (extra: Partial<Parameters<typeof deriveCapabilityStates>[0]>) =>
      states({ env, ...extra }).earnings_reconciliation;
    expect(at({})).toBe("configured");
    expect(at({ grantedScopes: ["read:insights"] })).toBe("connected");
    expect(at({ verified: ["earnings_reconciliation"] })).toBe("configured");
    expect(at({ grantedScopes: ["read:insights"], verified: ["earnings_reconciliation"] })).toBe("verified");
    expect(at({ grantedScopes: ["read:insights"], activated: ["earnings_reconciliation"] })).toBe("connected");
    expect(
      at({
        grantedScopes: ["read:insights"],
        verified: ["earnings_reconciliation"],
        activated: ["earnings_reconciliation"],
      }),
    ).toBe("active");
  });
});
