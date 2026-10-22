import type { DatabaseSync } from "node:sqlite";
import type { FanvueReadTransport } from "../integrations/fanvue/live-read-contracts";

export const creatorUuid = "creator-live";
export const sourceAudienceUuid = "subscribers";
export const capturedAt = "2026-10-21T09:59:00.000Z";
export const assignmentCutoff = "2026-10-21T10:00:00.000Z";

export type FanKind = "never" | "renewing" | "stopping" | "lapsed" | "resubscriber" | "trialing";
export type FanFixture = { uuid: string; kind: FanKind; purchases?: number };

export const sixFans: readonly FanFixture[] = [
  { uuid: "fan-1", kind: "renewing", purchases: 2 },
  { uuid: "fan-2", kind: "renewing" },
  { uuid: "fan-3", kind: "renewing", purchases: 1 },
  { uuid: "fan-4", kind: "renewing" },
  { uuid: "fan-5", kind: "stopping" },
  { uuid: "fan-6", kind: "stopping", purchases: 3 },
];

const statusFor: Record<FanKind, string> = {
  never: "follower",
  renewing: "subscriber",
  stopping: "subscriber",
  lapsed: "expired",
  resubscriber: "subscriber",
  trialing: "subscriber",
};

export function period(overrides: Record<string, unknown> = {}) {
  return {
    source: "profile",
    checkoutLinkUuid: null,
    type: "subscribe",
    paidAt: "2026-01-01T00:00:00Z",
    periodStart: "2026-01-01T00:00:00Z",
    periodEnd: "2026-02-01T00:00:00Z",
    amountPaid: 999,
    intervalMonths: 1,
    followsLapse: false,
    refunded: false,
    chargedBack: false,
    ...overrides,
  };
}

/** Newest first, as the endpoint returns it. */
function historyBody(fan: FanFixture) {
  const first = period();
  const renew = period({
    type: "renew",
    paidAt: "2026-02-01T00:00:00Z",
    periodStart: "2026-02-01T00:00:00Z",
    periodEnd: "2026-03-01T00:00:00Z",
  });
  const events: Record<FanKind, unknown[]> = {
    never: [],
    renewing: [renew, first],
    stopping: [first],
    lapsed: [first],
    resubscriber: [
      period({
        paidAt: "2026-06-01T00:00:00Z",
        periodStart: "2026-06-01T00:00:00Z",
        periodEnd: "2026-07-01T00:00:00Z",
        followsLapse: true,
      }),
      first,
    ],
    trialing: [period({ type: "trial", amountPaid: 0, intervalMonths: null })],
  };
  return { data: events[fan.kind], nextCursor: null };
}

function insightBody(fan: FanFixture) {
  const count = fan.purchases ?? 0;
  const subscribed = statusFor[fan.kind] === "subscriber";
  return {
    status: statusFor[fan.kind],
    spending: { sources: { message: { netCount: count, netTotal: count * 1000 } } },
    subscription: {
      createdAt: subscribed ? "2026-01-01T00:00:00Z" : null,
      renewsAt: subscribed ? "2026-11-01T00:00:00Z" : null,
      autoRenewalEnabled: fan.kind === "renewing" || fan.kind === "resubscriber",
    },
  };
}

/** Mocked Fanvue reads for one smart list. Override a path prefix to inject a failure. */
export function fanvueTransport(
  fans: readonly FanFixture[],
  overrides: Record<string, () => Response | Promise<Response>> = {},
): FanvueReadTransport {
  return async (path, init) => {
    for (const [prefix, respond] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return await respond();
    }
    if (path.startsWith("/v1/chats/lists/smart/")) {
      return new Response(
        JSON.stringify({
          data: fans.map((fan) => ({ uuid: fan.uuid, isCreator: false, displayName: "x", handle: "x" })),
          nextCursor: null,
          total: null,
        }),
      );
    }
    if (path === "/v1/insights/fans/batch") {
      const requested = (JSON.parse(String(init?.body)) as { userUuids: string[] }).userUuids;
      return new Response(
        JSON.stringify(
          Object.fromEntries(
            requested.map((uuid) => {
              const fan = fans.find((candidate) => candidate.uuid === uuid);
              return [uuid, fan ? insightBody(fan) : { error: "not_found" }];
            }),
          ),
        ),
      );
    }
    const history = /^\/v1\/subscribers\/([^/?]+)\/history/.exec(path);
    if (history) {
      const fan = fans.find((candidate) => candidate.uuid === decodeURIComponent(history[1]));
      return fan ? new Response(JSON.stringify(historyBody(fan))) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  };
}

export function seedExperiment(
  sqlite: DatabaseSync,
  options: { id?: string; provenance?: "REAL" | "DEMO"; source?: string } = {},
): string {
  const id = options.id ?? "experiment-live";
  sqlite
    .prepare(
      `INSERT INTO experiments (
       id, name, creator_uuid, data_provenance, state, variable, hypothesis, source_audience_uuid,
       created_at, updated_at
     ) VALUES (?, 'Live copy test', ?, ?, 'SNAPSHOTTING', 'COPY', 'Shorter copy sells more', ?, ?, ?)`,
    )
    .run(id, creatorUuid, options.provenance ?? "REAL", options.source ?? sourceAudienceUuid, capturedAt, capturedAt);
  for (const arm of ["A", "B"]) {
    sqlite
      .prepare(
        `INSERT INTO variants (experiment_id, arm, copy_text, price_minor, currency, media_uuid)
       VALUES (?, ?, ?, 1200, 'USD', 'media-1')`,
      )
      .run(id, arm, `Copy ${arm}`);
  }
  return id;
}

/** Marks both arms as sent, which is what lets payments route to the experiment. */
export function confirmSends(sqlite: DatabaseSync, experimentId: string): void {
  for (const [arm, message] of [
    ["A", "message-a"],
    ["B", "message-b"],
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO send_intents (
         id, creator_uuid, experiment_id, arm, idempotency_key, payload_json, payload_hash,
         status, external_message_uuid, confirmed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '{}', 'hash', 'CONFIRMED', ?, ?, ?, ?)`,
      )
      .run(`intent-${arm}`, creatorUuid, experimentId, arm, `key-${arm}`, message, capturedAt, capturedAt, capturedAt);
  }
}

export async function allocatedExperiment() {
  const { createMigratedDatabase } = await import("../test/sqlite-d1");
  const { D1PerformRepository } = await import("../persistence/d1-perform-repository");
  const { D1LiveEvidenceRepository } = await import("../persistence/live-evidence");
  const { captureLiveAudience, persistLiveAudienceSnapshot } = await import("./audience-capture");
  const { sqlite, db } = createMigratedDatabase();
  const experimentId = seedExperiment(sqlite);
  const repository = new D1PerformRepository(db, creatorUuid, "REAL");
  const store = new D1LiveEvidenceRepository(db, creatorUuid, "REAL");
  const source = { kind: "SMART", uuid: sourceAudienceUuid } as const;
  const capture = await captureLiveAudience({
    experimentId,
    source,
    capturedAt,
    assignmentCutoff,
    transport: fanvueTransport(sixFans),
  });
  if (capture.status !== "READY") throw new Error("capture failed");
  await persistLiveAudienceSnapshot({
    repository,
    evidenceRepository: store,
    experimentId,
    source,
    capture,
    commandId: "allocate",
  });
  confirmSends(sqlite, experimentId);
  return {
    sqlite,
    db,
    store,
    experimentId,
    armOf: (fan: string) => capture.assignments.find((a) => a.fanUuid === fan)!.arm,
  };
}
