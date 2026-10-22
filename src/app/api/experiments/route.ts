import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { D1PerformRepository, type SqlDatabase } from "../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../persistence/live-evidence";
import { canUseDemoWorkspace } from "../../../workspace/authorization";

export const runtime = "nodejs";

type LaunchRow = { experiment_id: string; scheduled_at: string; observation_ends_at: string };
type CountRow = { experiment_id: string; arm: "A" | "B"; n: number };

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * The signed-in creator's database experiments, newest first, with launch details, recipients per
 * arm and the latest reconciliation. `?workspace=demo` reads the seeded database instead.
 */
export async function GET(request: Request) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(secret);
  if (!session?.isCreator || !session.userUuid.trim()) {
    return jsonError(401, "not_a_verified_creator", "Open Perform from Fanvue to reconnect.");
  }
  const demo = new URL(request.url).searchParams.get("workspace") === "demo";
  if (demo && !canUseDemoWorkspace(
    session.userUuid, process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle, process.env.PERFORM_DEMO_CREATOR_HANDLES,
  )) return jsonError(403, "demo_forbidden", "This creator is not authorised for the seeded workspace.");
  const provenance = demo ? "DEMO" as const : "REAL" as const;
  const { env } = await getCloudflareContext({ async: true });
  const binding = demo ? env.PERFORM_DEMO_DB : env.PERFORM_REAL_DB;
  if (!binding) return NextResponse.json({ experiments: [] });
  const db = binding as unknown as SqlDatabase;

  const experiments = await new D1PerformRepository(db, session.userUuid, provenance).listExperiments();
  const [launches, counts, reconciliations] = await Promise.all([
    db.prepare(
      `SELECT l.experiment_id, l.scheduled_at, l.observation_ends_at FROM launch_confirmations l
       JOIN experiments e ON e.id = l.experiment_id
       WHERE l.creator_uuid = ? AND e.data_provenance = ?`,
    ).bind(session.userUuid, provenance).all<LaunchRow>(),
    db.prepare(
      `SELECT a.experiment_id, a.arm, COUNT(*) AS n FROM assignments a
       JOIN experiments e ON e.id = a.experiment_id
       WHERE e.creator_uuid = ? AND e.data_provenance = ? GROUP BY a.experiment_id, a.arm`,
    ).bind(session.userUuid, provenance).all<CountRow>(),
    new D1LiveEvidenceRepository(db, session.userUuid, provenance).latestReconciliations(),
  ]);
  const launchById = new Map((launches.results ?? []).map((row) => [row.experiment_id, row]));
  const reconciliationById = new Map(reconciliations.map((record) => [record.experimentId, record]));
  const armCounts = new Map<string, { A: number; B: number }>();
  for (const row of counts.results ?? []) {
    const entry = armCounts.get(row.experiment_id) ?? { A: 0, B: 0 };
    entry[row.arm] = row.n;
    armCounts.set(row.experiment_id, entry);
  }
  return NextResponse.json({
    experiments: experiments.map((experiment) => {
      const launch = launchById.get(experiment.id);
      const reconciliation = reconciliationById.get(experiment.id);
      return {
        ...experiment,
        launch: launch ? {
          scheduledAt: launch.scheduled_at,
          observationEndsAt: launch.observation_ends_at,
          armCounts: armCounts.get(experiment.id) ?? { A: 0, B: 0 },
        } : null,
        reconciliation: reconciliation ? {
          capturedAt: reconciliation.capturedAt, windowEnd: reconciliation.windowEnd,
          isComplete: reconciliation.isComplete, note: reconciliation.note,
        } : null,
      };
    }),
  });
}
