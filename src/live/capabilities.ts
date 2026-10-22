/**
 * Capability ladder for live data. Each rung needs the one before it, and no rung is inferred
 * from code existing: a capability stays "fixture_backed" until configuration, a real grant,
 * Phase X verification and an explicit activation all agree.
 */
export const liveCapabilityIds = [
  "audience_discovery",
  "subscriber_state",
  "purchase_enrichment",
  "commerce_webhook",
  "earnings_reconciliation",
  "mass_message_totals",
  "send",
] as const;

export type LiveCapabilityId = (typeof liveCapabilityIds)[number];

export type CapabilityState = "fixture_backed" | "configured" | "connected" | "verified" | "active";

export const requiredScopes: Readonly<Record<LiveCapabilityId, readonly string[]>> = {
  audience_discovery: ["read:chat", "read:fan"],
  subscriber_state: ["read:fan"],
  purchase_enrichment: ["read:fan", "read:insights"],
  commerce_webhook: ["read:creator"],
  earnings_reconciliation: ["read:insights"],
  /** Per-arm check against Fanvue's own mass-message totals (ADR 0015). */
  mass_message_totals: ["read:chat"],
  /** Creating recipient lists and scheduling paid messages, with fan reads for verification. */
  send: ["write:chat", "read:fan"],
};

export type CapabilityReport = {
  state: CapabilityState;
  requiredScopes: readonly string[];
  missingConfiguredScopes: readonly string[];
};

export type CapabilityEnvironment = Readonly<Record<string, string | undefined>>;

function words(value: string | undefined, separator: RegExp): Set<string> {
  return new Set(
    (value ?? "")
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * `grantedScopes` must come from a verified session grant, `verified` from a recorded Phase X
 * result and `activated` from the creator's activation state (self-service unless switched off,
 * ADR 0022). The health route passes none of them.
 */
export function deriveCapabilityStates(input: {
  env: CapabilityEnvironment;
  grantedScopes?: readonly string[];
  verified?: readonly LiveCapabilityId[];
  activated?: readonly LiveCapabilityId[];
}): Readonly<Record<LiveCapabilityId, CapabilityReport>> {
  const enabled = words(input.env.PERFORM_LIVE_CAPABILITIES, /[,\s]+/);
  const configuredScopes = words(input.env.OAUTH_SCOPES, /\s+/);
  const granted = new Set(input.grantedScopes ?? []);
  const verified = new Set(input.verified ?? []);
  const activated = new Set(input.activated ?? []);

  const report = {} as Record<LiveCapabilityId, CapabilityReport>;
  for (const id of liveCapabilityIds) {
    const scopes = requiredScopes[id];
    const missingConfiguredScopes = scopes.filter((scope) => !configuredScopes.has(scope));
    const webhookReady = id !== "commerce_webhook" || Boolean(input.env.FANVUE_WEBHOOK_SIGNING_SECRET);
    let state: CapabilityState = "fixture_backed";
    if (enabled.has(id) && missingConfiguredScopes.length === 0 && webhookReady) {
      state = "configured";
      if (scopes.every((scope) => granted.has(scope))) {
        state = "connected";
        if (verified.has(id)) {
          state = "verified";
          if (activated.has(id)) state = "active";
        }
      }
    }
    report[id] = { state, requiredScopes: scopes, missingConfiguredScopes };
  }
  return report;
}
