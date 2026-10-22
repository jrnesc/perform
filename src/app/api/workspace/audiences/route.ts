import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { DEMO_AUDIENCES } from "../../../../experiments/demo-audiences-v1";
import { deriveCapabilityStates } from "../../../../live/capabilities";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { captureCapabilities } from "../../../../live/capture-entry";
import type { SqlDatabase } from "../../../../persistence/d1-perform-repository";
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
    const { env } = await getCloudflareContext({ async: true });
    const deferred = () =>
      error(
        409,
        "live_audience_deferred",
        "Live audience capture is not active for this creator yet. It needs read:chat and read:fan consent plus a verified, activated read path; use the labelled demo workspace meanwhile.",
        demoAvailable,
      );
    if (!env.PERFORM_REAL_DB) return deferred();
    const records = await new D1CapabilityRecordReader(
      env.PERFORM_REAL_DB as unknown as SqlDatabase,
      session.userUuid,
    ).snapshot();
    const capabilities = deriveCapabilityStates({
      env: process.env,
      grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
      verified: records.verified,
      activated: records.activated,
    });
    if (captureCapabilities.some((id) => capabilities[id].state !== "active")) return deferred();
    // The members are read and frozen when the experiment is prepared, not on page load.
    return NextResponse.json({
      workspace: "real",
      creator: { uuid: session.userUuid, displayName: session.displayName },
      capabilities: { demoAvailable },
      audiences: [
        {
          id: "subscribers",
          name: "Active subscribers",
          description: "Every contactable subscriber is read from Fanvue and frozen when you review the experiment.",
          sourceKind: "FANVUE_SMART_LIST",
          capturedAt: new Date().toISOString(),
          members: [],
          sourceCount: 0,
          exclusions: [],
          provenance: { kind: "FANVUE", label: "Live Fanvue audience" },
        },
      ],
    });
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
