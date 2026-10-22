import type { SqlDatabase } from "../persistence/d1-perform-repository";
import { liveCapabilityIds, type LiveCapabilityId } from "./capabilities";

export type CapabilityRecordSnapshot = {
  verified: readonly LiveCapabilityId[];
  activated: readonly LiveCapabilityId[];
};

type LatestRow = { capability: string; value: string };

function isCapability(value: string): value is LiveCapabilityId {
  return (liveCapabilityIds as readonly string[]).includes(value);
}

/**
 * Read-only by design: owner-written Phase X evidence has no application write method.
 *
 * Verification is a fact about Fanvue's contract, so the latest verification of a capability for
 * any creator applies to every creator, and a later FAIL switches it off for all of them. Activation
 * is self-service (ADR 0022): a verified capability is active for a creator unless that creator's
 * latest activation decision is DEACTIVATE.
 */
export class D1CapabilityRecordReader {
  constructor(
    private readonly db: SqlDatabase,
    private readonly creatorUuid: string,
  ) {}

  async snapshot(): Promise<CapabilityRecordSnapshot> {
    const [verificationRows, deactivationRows] = await Promise.all([
      this.db.prepare(
        `SELECT v.capability, v.outcome AS value FROM capability_verifications v
         WHERE v.id = (
           SELECT latest.id FROM capability_verifications latest
           WHERE latest.capability = v.capability
           ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
         )`,
      ).all<LatestRow>(),
      this.db.prepare(
        `SELECT a.capability, a.action AS value FROM capability_activations a
         WHERE a.creator_uuid = ? AND a.id = (
           SELECT latest.id FROM capability_activations latest
           WHERE latest.creator_uuid = a.creator_uuid AND latest.capability = a.capability
           ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
         )`,
      ).bind(this.creatorUuid).all<LatestRow>(),
    ]);
    const verified = (verificationRows.results ?? [])
      .filter((row) => row.value === "PASS" && isCapability(row.capability))
      .map((row) => row.capability as LiveCapabilityId);
    const deactivated = new Set((deactivationRows.results ?? [])
      .filter((row) => row.value === "DEACTIVATE")
      .map((row) => row.capability));
    return { verified, activated: verified.filter((capability) => !deactivated.has(capability)) };
  }
}
