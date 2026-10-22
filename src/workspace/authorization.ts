import type { MediaPage, MediaReadGateway, WorkspaceKind } from "./contracts";

export function demoCreatorAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function demoCreatorHandleAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}

export function canUseDemoWorkspace(
  creatorUuid: string,
  rawUuidAllowlist: string | undefined,
  creatorHandle?: string,
  rawHandleAllowlist?: string,
): boolean {
  if (demoCreatorAllowlist(rawUuidAllowlist).has(creatorUuid)) return true;
  if (!creatorHandle) return false;
  return demoCreatorHandleAllowlist(rawHandleAllowlist).has(creatorHandle.trim().replace(/^@/, "").toLowerCase());
}

export class DemoCapabilityDeniedError extends Error {
  constructor() {
    super("This verified creator is not authorised for the seeded demo workspace.");
    this.name = "DemoCapabilityDeniedError";
  }
}

export async function readWorkspaceMedia(input: {
  creatorUuid: string;
  workspace: WorkspaceKind;
  page: number;
  pageSize: number;
  demoAllowlist: string | undefined;
  creatorHandle?: string;
  demoHandleAllowlist?: string;
  realGateway: () => MediaReadGateway;
  demoGateway: () => MediaReadGateway;
}): Promise<{ page: MediaPage; demoAvailable: boolean }> {
  const demoAvailable = canUseDemoWorkspace(
    input.creatorUuid,
    input.demoAllowlist,
    input.creatorHandle,
    input.demoHandleAllowlist,
  );
  if (input.workspace === "demo" && !demoAvailable) throw new DemoCapabilityDeniedError();

  const gateway = input.workspace === "demo" ? input.demoGateway() : input.realGateway();
  return {
    page: await gateway.listMedia({ page: input.page, pageSize: input.pageSize }),
    demoAvailable,
  };
}
