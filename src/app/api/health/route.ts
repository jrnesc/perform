import { NextResponse } from "next/server";
import { deriveCapabilityStates } from "../../../live/capabilities";

export function GET() {
  // States only: no scope grants, verification or activation exist yet, so nothing can exceed
  // "configured" here. Secrets and identifiers are never reported.
  const capabilities = deriveCapabilityStates({ env: process.env });
  return NextResponse.json({
    status: "ok",
    mode: "dry-run",
    liveCapabilities: Object.fromEntries(
      Object.entries(capabilities).map(([id, report]) => [id, report.state]),
    ),
  });
}
