import { describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { D1CapabilityRecordReader } from "./capability-records";

describe("owner-written capability records", () => {
  it("uses only the latest append-only verification and activation decisions", async () => {
    const { sqlite, db } = createMigratedDatabase();
    sqlite.prepare(
      `INSERT INTO capability_verifications
       (id, creator_uuid, capability, outcome, contract_reference, evidence_note, recorded_at)
       VALUES (?, 'creator', 'audience_discovery', ?, 'phase-x:3', 'Owner observed the live contract', ?)`,
    ).run("verify-pass", "PASS", "2026-10-21T10:00:00.000Z");
    sqlite.prepare(
      `INSERT INTO capability_activations
       (id, creator_uuid, capability, action, verification_id, decision_note, recorded_at)
       VALUES ('activate', 'creator', 'audience_discovery', 'ACTIVATE', 'verify-pass', 'Owner approved activation', '2026-10-21T10:01:00.000Z')`,
    ).run();
    expect(await new D1CapabilityRecordReader(db, "creator").snapshot()).toEqual({
      verified: ["audience_discovery"], activated: ["audience_discovery"],
    });

    sqlite.prepare(
      `INSERT INTO capability_verifications
       (id, creator_uuid, capability, outcome, contract_reference, evidence_note, recorded_at)
       VALUES ('verify-fail', 'creator', 'audience_discovery', 'FAIL', 'phase-x:3', 'Later verification failed', '2026-10-21T11:00:00.000Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO capability_activations
       (id, creator_uuid, capability, action, verification_id, decision_note, recorded_at)
       VALUES ('deactivate', 'creator', 'audience_discovery', 'DEACTIVATE', 'verify-fail', 'Owner disabled capability', '2026-10-21T11:01:00.000Z')`,
    ).run();
    expect(await new D1CapabilityRecordReader(db, "creator").snapshot()).toEqual({ verified: [], activated: [] });
  });

  it("rejects application-style mutation of the append-only ledger", () => {
    const { sqlite } = createMigratedDatabase();
    sqlite.prepare(
      `INSERT INTO capability_verifications
       (id, creator_uuid, capability, outcome, contract_reference, evidence_note, recorded_at)
       VALUES ('verify', 'creator', 'subscriber_state', 'PASS', 'phase-x:2', 'Owner evidence', '2026-10-21T10:00:00.000Z')`,
    ).run();
    expect(() => sqlite.prepare("UPDATE capability_verifications SET outcome = 'FAIL'").run())
      .toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM capability_verifications").run())
      .toThrow(/append-only/);
  });
});
