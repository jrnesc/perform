import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { receiveCreatorCommerceWebhook } from "../../../../live/commerce-ingestion";
import type { SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

/**
 * Creator-commerce webhook receiver for the app-wide Fanvue destination. Disabled unless
 * PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED is exactly "true"; while disabled it answers 404 before
 * touching the body, secret or database. Each signed event is stored for the creator it names.
 */
export async function POST(request: Request) {
  const enabled = process.env.PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED === "true";
  if (!enabled) return NextResponse.json({ outcome: "DISABLED" }, { status: 404 });

  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) {
    return NextResponse.json({ outcome: "NOT_CONFIGURED" }, { status: 503 });
  }
  const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;
  const result = await receiveCreatorCommerceWebhook({
    rawBody: new Uint8Array(await request.arrayBuffer()),
    signature: request.headers.get("X-Fanvue-Signature"),
    nowMs: Date.now(),
    config: {
      enabled,
      signingSecret: process.env.FANVUE_WEBHOOK_SIGNING_SECRET,
    },
    repositoryFor: (creatorUuid) => new D1LiveEvidenceRepository(db, creatorUuid, "REAL"),
    newId: () => crypto.randomUUID(),
  });
  return NextResponse.json({ outcome: result.outcome }, { status: result.status });
}
