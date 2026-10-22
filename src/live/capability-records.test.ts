import { describe, expect, it } from "vitest";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { D1CapabilityRecordReader } from "./capability-records";

describe("capability records", () => {
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

  it("applies a verification to every creator and activates it unless that creator is switched off", async () => {
    const { sqlite, db } = createMigratedDatabase();
    const verify = (id: string, outcome: string, at: string) => sqlite.prepare(
      `INSERT INTO capability_verifications
       (id, creator_uuid, capability, outcome, contract_reference, evidence_note, recorded_at)
       VALUES (?, 'owner', 'send', ?, 'phase-x:5', 'Owner observed the live contract', ?)`,
    ).run(id, outcome, at);
    verify("verify-send", "PASS", "2026-10-22T10:00:00.000Z");
    expect(await new D1CapabilityRecordReader(db, "new-creator").snapshot()).toEqual({
      verified: ["send"], activated: ["send"],
    });

    sqlite.prepare(
      `INSERT INTO capability_activations
       (id, creator_uuid, capability, action, verification_id, decision_note, recorded_at)
       VALUES ('switch-off', 'new-creator', 'send', 'DEACTIVATE', NULL, 'Owner switched this creator off', '2026-10-22T11:00:00.000Z')`,
    ).run();
    expect(await new D1CapabilityRecordReader(db, "new-creator").snapshot()).toEqual({ verified: ["send"], activated: [] });
    expect(await new D1CapabilityRecordReader(db, "other-creator").snapshot()).toEqual({ verified: ["send"], activated: ["send"] });

    verify("verify-send-fail", "FAIL", "2026-10-22T12:00:00.000Z");
    expect(await new D1CapabilityRecordReader(db, "other-creator").snapshot()).toEqual({ verified: [], activated: [] });
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
