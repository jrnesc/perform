import { describe, expect, it } from "vitest";
import { allocateAudience } from "../domain/allocation";
import { D1PerformRepository, assignmentChunkLimit, type SqlDatabase } from "./d1-perform-repository";

class FakeStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly database: FakeDatabase,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    return this;
  }

  async first<Row>(): Promise<Row | null> {
    return (this.database.firstRows.shift() as Row | undefined) ?? null;
  }

  async run<Row>(): Promise<{ results: Row[]; success: boolean; meta: { changes: number } }> {
    return { results: [], success: true, meta: { changes: this.database.runChanges } };
  }

  async all<Row>(): Promise<{ results: Row[]; success: boolean; meta: { changes: number } }> {
    return { results: [], success: true, meta: { changes: 0 } };
  }
}

class FakeDatabase implements SqlDatabase {
  readonly prepared: FakeStatement[] = [];
  readonly batches: FakeStatement[][] = [];
  firstRows: unknown[] = [];
  batchChanges: number[] = [];
  runChanges = 1;

  prepare(query: string): FakeStatement {
    const statement = new FakeStatement(query, this);
    this.prepared.push(statement);
    return statement;
  }

  async batch<Row>(statements: readonly FakeStatement[]) {
    this.batches.push([...statements]);
    return statements.map((_, index) => ({
      results: [] as Row[],
      success: true,
      meta: { changes: this.batchChanges[index] ?? 1 },
    }));
  }
}

const experimentRow = {
  id: "experiment-1",
  name: "October copy test",
  creator_uuid: "creator-1",
  data_provenance: "REAL",
  state: "SNAPSHOTTING",
  variable: "COPY",
  hypothesis: "Specific copy converts better",
  source_audience_uuid: "audience-1",
  snapshot_hash: null,
  snapshot_count: null,
  allocation_algorithm: null,
  snapshot_at: null,
  launched_at: null,
  observation_started_at: null,
  observation_ended_at: null,
  created_at: "2026-10-20T10:00:00.000Z",
  updated_at: "2026-10-20T10:00:00.000Z",
};

describe("D1PerformRepository", () => {
  it("creates the experiment and exactly two variants in one database batch", async () => {
    const database = new FakeDatabase();
    const repository = new D1PerformRepository(database, "creator-1", "REAL");

    await repository.createExperiment({
      id: "experiment-1",
      name: "October copy test",
      variable: "COPY",
      hypothesis: "Specific copy converts better",
      sourceAudienceUuid: "audience-1",
      createdAt: "2026-10-20T10:00:00.000Z",
      variants: [
        { arm: "A", copy: "Preview", priceMinor: 1000, currency: "USD", mediaUuid: "media-1" },
        { arm: "B", copy: "Specific preview", priceMinor: 1000, currency: "USD", mediaUuid: "media-1" },
      ],
    });

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(3);
  });

  it("bounds assignment chunks so each committed chunk can be retried", async () => {
    const database = new FakeDatabase();
    const repository = new D1PerformRepository(database, "creator-1", "REAL");
    const assignments = allocateAudience(
      "experiment-1",
      Array.from({ length: assignmentChunkLimit + 1 }, (_, index) => ({ fanUuid: `fan-${index}` })),
    );

    await expect(
      repository.saveAssignmentChunk("experiment-1", assignments, "2026-10-20T10:01:00.000Z"),
    ).rejects.toThrow(/at most 40/);
    expect(database.batches).toHaveLength(0);
  });

  it("refuses to finalize when persisted assignment evidence does not match", async () => {
    const database = new FakeDatabase();
    database.firstRows.push(experimentRow);
    database.batchChanges = [0, 0];
    const repository = new D1PerformRepository(database, "creator-1", "REAL");

    await expect(
      repository.finalizeAllocation({
        commandId: "command-1",
        experimentId: "experiment-1",
        snapshotHash: "a".repeat(64),
        snapshotCount: 10,
        armCounts: { A: 5, B: 5 },
        algorithmVersion: "fnv1a-stratified-alternating-v2",
        snapshotAt: "2026-10-20T10:02:00.000Z",
      }),
    ).rejects.toThrow(/did not match persisted assignments/);
  });

  it("recognises an identical webhook retry without writing it twice", async () => {
    const database = new FakeDatabase();
    database.firstRows.push(experimentRow, {
      event_type: "creator.payment.succeeded",
      payload_hash: "payload-hash",
      processed_at: "2026-10-20T10:03:00.000Z",
    });
    const repository = new D1PerformRepository(database, "creator-1", "REAL");

    await expect(
      repository.recordPurchaseEvent({
        source: "FANVUE",
        eventId: "event-1",
        eventType: "creator.payment.succeeded",
        payloadHash: "payload-hash",
        experimentId: "experiment-1",
        arm: "A",
        purchaserUuid: "fan-1",
        externalMessageUuid: "message-1",
        grossMinor: 1000,
        currency: "USD",
        occurredAt: "2026-10-20T10:03:00.000Z",
        receivedAt: "2026-10-20T10:03:01.000Z",
      }),
    ).resolves.toBe("DUPLICATE");
    expect(database.batches).toHaveLength(0);
  });

  it("scopes an experiment result read by experiment, creator and provenance", async () => {
    const database = new FakeDatabase();
    database.firstRows.push(experimentRow);
    const repository = new D1PerformRepository(database, "creator-1", "REAL");

    await expect(repository.getExperimentResult("experiment-1")).resolves.toBeNull();
    const statement = database.prepared.at(-1)!;
    expect(statement.query).toContain("experiment_id = ? AND creator_uuid = ? AND data_provenance = ?");
    expect(statement.values).toEqual(["experiment-1", "creator-1", "REAL"]);
  });

  it("normalizes and deduplicates purchase reversal evidence", async () => {
    const database = new FakeDatabase();
    const repository = new D1PerformRepository(database, "creator-1", "REAL");
    await expect(repository.recordPurchaseReversal({
      source: "FANVUE", eventId: "refund-1", eventType: "creator.refund.created", payloadHash: "hash",
      purchaseSource: "FANVUE", purchaseEventId: "payment-1", kind: "REFUND", amountMinor: 1200,
      occurredAt: "2026-10-20T11:00:00.000Z", receivedAt: "2026-10-20T11:00:01.000Z",
    })).resolves.toBe("RECORDED");
    expect(database.batches.at(-1)![1].query).toContain("INSERT INTO purchase_reversals");
  });
});
