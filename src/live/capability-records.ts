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

/** Read-only by design: owner-written Phase X evidence has no application write method. */
export class D1CapabilityRecordReader {
  constructor(
    private readonly db: SqlDatabase,
    private readonly creatorUuid: string,
  ) {}

  async snapshot(): Promise<CapabilityRecordSnapshot> {
    const [verificationRows, activationRows] = await Promise.all([
      this.db.prepare(
        `SELECT v.capability, v.outcome AS value FROM capability_verifications v
         WHERE v.creator_uuid = ? AND v.id = (
           SELECT latest.id FROM capability_verifications latest
           WHERE latest.creator_uuid = v.creator_uuid AND latest.capability = v.capability
           ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
         )`,
      ).bind(this.creatorUuid).all<LatestRow>(),
      this.db.prepare(
        `SELECT a.capability,
           CASE WHEN a.action = 'ACTIVATE' AND v.outcome = 'PASS' AND v.id = (
             SELECT latest_verification.id FROM capability_verifications latest_verification
             WHERE latest_verification.creator_uuid = a.creator_uuid
               AND latest_verification.capability = a.capability
             ORDER BY latest_verification.recorded_at DESC, latest_verification.id DESC LIMIT 1
           ) THEN 'ACTIVATE' ELSE 'DEACTIVATE' END AS value
         FROM capability_activations a
         JOIN capability_verifications v ON v.id = a.verification_id
           AND v.creator_uuid = a.creator_uuid AND v.capability = a.capability
         WHERE a.creator_uuid = ? AND a.id = (
           SELECT latest.id FROM capability_activations latest
           WHERE latest.creator_uuid = a.creator_uuid AND latest.capability = a.capability
           ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
         )`,
      ).bind(this.creatorUuid).all<LatestRow>(),
    ]);
    return {
      verified: (verificationRows.results ?? [])
        .filter((row) => row.value === "PASS" && isCapability(row.capability))
        .map((row) => row.capability as LiveCapabilityId),
      activated: (activationRows.results ?? [])
        .filter((row) => row.value === "ACTIVATE" && isCapability(row.capability))
        .map((row) => row.capability as LiveCapabilityId),
    };
  }
}
