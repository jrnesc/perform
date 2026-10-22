import { NextResponse } from "next/server";
import { discardExperiment } from "../../../../experiments/saved-experiment";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

/**
 * Discard an experiment that was saved but never launched. Nothing exists in Fanvue yet, so this
 * only marks it INVALID in Perform; the frozen split stays on record and the list hides it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { experimentId?: unknown; workspace?: unknown };
  const resolved = await experimentRequestContext(body);
  if ("error" in resolved) return resolved.error;
  const repository = new D1PerformRepository(
    resolved.db,
    resolved.session.userUuid,
    resolved.workspace === "real" ? "REAL" : "DEMO",
  );
  try {
    await discardExperiment({ repository, experimentId: resolved.experimentId, now: () => new Date().toISOString() });
    return NextResponse.json({ discarded: true });
  } catch (error) {
    return jsonError(
      409,
      "discard_failed",
      error instanceof Error ? error.message : "The experiment could not be discarded.",
    );
  }
}
