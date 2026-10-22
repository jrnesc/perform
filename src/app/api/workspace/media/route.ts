import { createFanvueClient } from "@fanvue/builder-sdk";
import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { NextResponse } from "next/server";
import { FanvueMediaGateway } from "../../../../integrations/fanvue/fanvue-media-gateway";
import { DemoMediaGateway } from "../../../../workspace/demo-media-gateway";
import {
  DemoCapabilityDeniedError,
  canUseDemoWorkspace,
  readWorkspaceMedia,
} from "../../../../workspace/authorization";
import { MediaReadError, type WorkspaceKind } from "../../../../workspace/contracts";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string, demoAvailable = false) {
  return NextResponse.json({ error: { code, message }, capabilities: { demoAvailable } }, { status });
}

export async function GET(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");

  const session = await getSession(sessionSecret);
  if (!session || !session.isCreator) {
    return jsonError(401, "disconnected", "Open Perform from Fanvue to reconnect.");
  }

  const url = new URL(request.url);
  const workspace: WorkspaceKind = url.searchParams.get("workspace") === "demo" ? "demo" : "real";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = 12;
  const demoAvailable = canUseDemoWorkspace(
    session.userUuid,
    process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle,
    process.env.PERFORM_DEMO_CREATOR_HANDLES,
  );

  try {
    let realGateway: FanvueMediaGateway | null = null;
    if (workspace === "real") {
      const client = createFanvueClient(session.accessToken, null, {
        apiVersion: process.env.FANVUE_API_VERSION ?? "2025-06-26",
      });
      realGateway = new FanvueMediaGateway(client.vault);
    }

    const result = await readWorkspaceMedia({
      creatorUuid: session.userUuid,
      creatorHandle: session.handle,
      workspace,
      page,
      pageSize,
      demoAllowlist: process.env.PERFORM_DEMO_CREATOR_UUIDS,
      demoHandleAllowlist: process.env.PERFORM_DEMO_CREATOR_HANDLES,
      realGateway: () => {
        if (!realGateway) throw new Error("The live gateway was not initialised");
        return realGateway;
      },
      demoGateway: () => new DemoMediaGateway(),
    });
    const response = NextResponse.json({
      workspace,
      creator: { uuid: session.userUuid, displayName: session.displayName },
      capabilities: { demoAvailable: result.demoAvailable },
      page: result.page,
    });
    return response;
  } catch (error) {
    if (error instanceof DemoCapabilityDeniedError) {
      return jsonError(403, "demo_forbidden", error.message, false);
    }
    if (error instanceof MediaReadError) {
      const status =
        error.code === "RECONNECT_REQUIRED"
          ? 401
          : error.code === "PERMISSION_REQUIRED"
            ? 403
            : error.code === "RATE_LIMITED"
              ? 429
              : 502;
      const response = jsonError(status, error.code.toLowerCase(), error.message, demoAvailable);
      if (error.retryAfterSeconds) {
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
      }
      return response;
    }
    console.error("workspace.media_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(500, "internal_error", "Perform could not load this workspace.", demoAvailable);
  }
}
