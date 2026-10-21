import {
  createConfig,
  createSessionExchangeHandler,
} from "@fanvue/builder-sdk/nextjs/embedded-app";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const required = [
  "OAUTH_CLIENT_ID",
  "OAUTH_CLIENT_SECRET",
  "OAUTH_REDIRECT_URI",
  "SESSION_SECRET",
] as const;

export async function POST(request: Request) {
  if (required.some((key) => !process.env[key])) {
    return NextResponse.json(
      { error: "fanvue_not_configured" },
      { status: 503 },
    );
  }

  return createSessionExchangeHandler(createConfig()).POST(request);
}
