import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { D1PerformRepository, type SqlDatabase } from "../../../persistence/d1-perform-repository";

export const runtime = "nodejs";

type LaunchRow = { experiment_id: string; scheduled_at: string };
type CountRow = { experiment_id: string; arm: "A" | "B"; n: number };

/** The signed-in creator's real experiments, newest first, with launch time and recipients per arm. */
export async function GET() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "not_configured", message: "Perform is not configured." } }, { status: 503 });
  const session = await getSession(secret);
  if (!session?.isCreator || !session.userUuid.trim()) {
    return NextResponse.json({ error: { code: "not_a_verified_creator", message: "Open Perform from Fanvue to reconnect." } }, { status: 401 });
  }
  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) return NextResponse.json({ experiments: [] });
  const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;

  const experiments = await new D1PerformRepository(db, session.userUuid, "REAL").listExperiments();
  const [launches, counts] = await Promise.all([
    db.prepare("SELECT experiment_id, scheduled_at FROM launch_confirmations WHERE creator_uuid = ?")
      .bind(session.userUuid).all<LaunchRow>(),
    db.prepare(
      `SELECT a.experiment_id, a.arm, COUNT(*) AS n FROM assignments a
       JOIN experiments e ON e.id = a.experiment_id
       WHERE e.creator_uuid = ? AND e.data_provenance = 'REAL' GROUP BY a.experiment_id, a.arm`,
    ).bind(session.userUuid).all<CountRow>(),
  ]);
  const scheduled = new Map((launches.results ?? []).map((row) => [row.experiment_id, row.scheduled_at]));
  const armCounts = new Map<string, { A: number; B: number }>();
  for (const row of counts.results ?? []) {
    const entry = armCounts.get(row.experiment_id) ?? { A: 0, B: 0 };
    entry[row.arm] = row.n;
    armCounts.set(row.experiment_id, entry);
  }
  return NextResponse.json({
    experiments: experiments.map((experiment) => ({
      ...experiment,
      launch: scheduled.has(experiment.id)
        ? { scheduledAt: scheduled.get(experiment.id)!, armCounts: armCounts.get(experiment.id) ?? { A: 0, B: 0 } }
        : null,
    })),
  });
}
