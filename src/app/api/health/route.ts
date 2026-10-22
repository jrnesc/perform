import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { D1CapabilityRecordReader, type CapabilityRecordSnapshot } from "../../../live/capability-records";
import { deriveCapabilityStates } from "../../../live/capabilities";
import type { SqlDatabase } from "../../../persistence/d1-perform-repository";

export const runtime = "nodejs";

export async function GET() {
  const session = process.env.SESSION_SECRET ? await getSession(process.env.SESSION_SECRET) : null;
  let records: CapabilityRecordSnapshot = { verified: [], activated: [] };
  if (session?.isCreator) {
    try {
      const { env } = await getCloudflareContext({ async: true });
      if (env.PERFORM_REAL_DB) {
        records = await new D1CapabilityRecordReader(
          env.PERFORM_REAL_DB as unknown as SqlDatabase,
          session.userUuid,
        ).snapshot();
      }
    } catch {
      // Health stays available before migrations are applied; no records means no activation.
    }
  }
  const capabilities = deriveCapabilityStates({
    env: process.env,
    grantedScopes: (session?.scope ?? "").split(/\s+/).filter(Boolean),
    verified: records.verified,
    activated: records.activated,
  });
  return NextResponse.json({
    status: "ok",
    mode: process.env.PERFORM_WRITE_MODE === "enabled" ? "sending-enabled" : "sending-disabled",
    liveCapabilities: Object.fromEntries(Object.entries(capabilities).map(([id, report]) => [id, report.state])),
  });
}
