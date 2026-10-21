import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { NextResponse } from "next/server";
import { DEMO_AUDIENCES } from "../../../../experiments/demo-audiences-v1";
import { canUseDemoWorkspace } from "../../../../workspace/authorization";

export const runtime = "nodejs";

function error(status: number, code: string, message: string, demoAvailable = false) {
  return NextResponse.json({ error: { code, message }, capabilities: { demoAvailable } }, { status });
}

export async function GET(request: Request) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return error(503, "not_configured", "Perform is not configured.");
  const session = await getSession(secret);
  if (!session?.isCreator) return error(401, "disconnected", "Open Perform from Fanvue to reconnect.");

  const demoAvailable = canUseDemoWorkspace(
    session.userUuid,
    process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle,
    process.env.PERFORM_DEMO_CREATOR_HANDLES,
  );
  const workspace = new URL(request.url).searchParams.get("workspace") === "demo" ? "demo" : "real";
  if (workspace === "real") {
    return error(
      409,
      "live_audience_deferred",
      "Live audience reads are not enabled in Phase 3. They require read:chat and read:fan consent; use the labelled demo workspace for setup.",
      demoAvailable,
    );
  }
  if (!demoAvailable) {
    return error(403, "demo_forbidden", "This verified creator is not authorised for the seeded demo workspace.");
  }

  return NextResponse.json({
    workspace: "demo",
    creator: { uuid: session.userUuid, displayName: session.displayName },
    capabilities: { demoAvailable },
    audiences: DEMO_AUDIENCES,
  });
}
