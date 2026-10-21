import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { receiveCreatorCommerceWebhook } from "../../../../live/commerce-ingestion";
import type { SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

/**
 * Creator-commerce webhook receiver. Disabled unless PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED is
 * exactly "true"; while disabled it answers 404 before touching the body, secret or database.
 * No destination, subscription or secret exists, so no Fanvue event can reach this route.
 */
export async function POST(request: Request) {
  const enabled = process.env.PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED === "true";
  if (!enabled) return NextResponse.json({ outcome: "DISABLED" }, { status: 404 });

  const creatorUuid = process.env.PERFORM_LIVE_CREATOR_UUID;
  const { env } = await getCloudflareContext({ async: true });
  if (!creatorUuid || !env.PERFORM_REAL_DB) {
    return NextResponse.json({ outcome: "NOT_CONFIGURED" }, { status: 503 });
  }
  const repository = new D1LiveEvidenceRepository(
    env.PERFORM_REAL_DB as unknown as SqlDatabase,
    creatorUuid,
    "REAL",
  );
  const result = await receiveCreatorCommerceWebhook({
    rawBody: new Uint8Array(await request.arrayBuffer()),
    signature: request.headers.get("X-Fanvue-Signature"),
    nowMs: Date.now(),
    config: {
      enabled,
      signingSecret: process.env.FANVUE_WEBHOOK_SIGNING_SECRET,
      creatorUuid,
    },
    repository,
    newId: () => crypto.randomUUID(),
  });
  return NextResponse.json({ outcome: result.outcome }, { status: result.status });
}
