import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import type { SqlDatabase } from "../../../persistence/d1-perform-repository";
import { canUseDemoWorkspace } from "../../../workspace/authorization";

export function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

/** Verified creator, chosen workspace and its database for one experiment request. */
export async function experimentRequestContext(body: { experimentId?: unknown; workspace?: unknown }) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return { error: jsonError(503, "not_configured", "Perform is not configured.") };
  const session = await getSession(sessionSecret);
  if (!session?.isCreator || !session.userUuid.trim()) {
    return { error: jsonError(401, "not_a_verified_creator", "Open Perform from Fanvue to reconnect.") };
  }
  if (typeof body.experimentId !== "string" || !body.experimentId.trim()) {
    return { error: jsonError(400, "experiment_required", "An experiment ID is required.") };
  }
  const workspace = body.workspace === "real" ? "real" as const : body.workspace === "demo" ? "demo" as const : null;
  if (!workspace) return { error: jsonError(400, "workspace_required", "Choose the real or seeded workspace.") };
  if (workspace === "demo" && !canUseDemoWorkspace(
    session.userUuid, process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle, process.env.PERFORM_DEMO_CREATOR_HANDLES,
  )) return { error: jsonError(403, "demo_forbidden", "This creator is not authorised for the seeded workspace.") };
  const { env } = await getCloudflareContext({ async: true });
  const binding = workspace === "real" ? env.PERFORM_REAL_DB : env.PERFORM_DEMO_DB;
  if (!binding) return { error: jsonError(503, "database_not_configured", "The selected database is not configured.") };
  const db = binding as unknown as SqlDatabase;
  return { session, workspace, db, experimentId: body.experimentId };
}
