export type WorkspaceKind = "real" | "demo";

export type AssetProvenance =
  | { kind: "FANVUE"; label: "Live Fanvue Vault" }
  | { kind: "DEMO_SEEDED"; label: "Seeded demo data"; fixtureVersion: string };

export type MediaAsset = {
  id: string;
  name: string;
  mediaType: "image" | "video" | "audio" | "document" | "unknown";
  status: "ready" | "processing" | "unavailable";
  createdAt: string | null;
  thumbnailUrl: string | null;
  provenance: AssetProvenance;
};

export type MediaPage = {
  items: MediaAsset[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number | null;
  provenance: AssetProvenance;
};

export type ListMediaInput = { page: number; pageSize: number };

export interface MediaReadGateway {
  listMedia(input: ListMediaInput): Promise<MediaPage>;
  getMedia(id: string): Promise<MediaAsset | null>;
}

export type MediaReadErrorCode =
  | "RECONNECT_REQUIRED"
  | "PERMISSION_REQUIRED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INVALID_IDENTIFIER";

export class MediaReadError extends Error {
  constructor(
    readonly code: MediaReadErrorCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "MediaReadError";
  }
}

export function isDemoIdentifier(id: string): boolean {
  return id.startsWith("demo:");
}
