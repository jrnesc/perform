import type { ApiError, FanvueClient, VaultMediaItem } from "@fanvue/builder-sdk";
import {
  isDemoIdentifier,
  MediaReadError,
  type ListMediaInput,
  type MediaAsset,
  type MediaPage,
  type MediaReadGateway,
} from "../../workspace/contracts";

type VaultClient = Pick<FanvueClient["vault"], "getMedia" | "listMedia">;

const provenance = { kind: "FANVUE", label: "Live Fanvue Vault" } as const;

const previewVariants = ["thumbnail", "thumbnail_gallery", "main"] as const;

/** Prefers the smallest image rendition Fanvue generated; `blurred` is never shown as a preview. */
function thumbnail(item: VaultMediaItem): string | null {
  for (const type of previewVariants) {
    const url = item.variants?.find((variant) => variant.variantType === type)?.url;
    if (url) return url;
  }
  return null;
}

function mapItem(item: VaultMediaItem): MediaAsset {
  return {
    id: item.uuid,
    name: item.name?.trim() || "Untitled Vault asset",
    mediaType: item.mediaType ?? "unknown",
    status: item.status === "ready" ? "ready" : item.status === "error" ? "unavailable" : "processing",
    createdAt: item.createdAt,
    thumbnailUrl: thumbnail(item),
    provenance,
  };
}

function mappedError(error: ApiError): MediaReadError {
  if (error.code === "API_ERROR_RESPONSE") {
    if (error.statusCode === 401) {
      return new MediaReadError("RECONNECT_REQUIRED", "Reconnect from Fanvue to refresh access.");
    }
    if (error.statusCode === 403) {
      return new MediaReadError(
        "PERMISSION_REQUIRED",
        "Vault access needs the read:media permission or completed age verification.",
      );
    }
    if (error.statusCode === 429) {
      return new MediaReadError(
        "RATE_LIMITED",
        "Fanvue is limiting Vault reads. Try again after the wait shown.",
        error.retryAfterSeconds ?? 1,
      );
    }
  }
  return new MediaReadError("UNAVAILABLE", "The Fanvue Vault is temporarily unavailable.");
}

export class FanvueMediaGateway implements MediaReadGateway {
  constructor(private readonly vault: VaultClient) {}

  async listMedia({ page, pageSize }: ListMediaInput): Promise<MediaPage> {
    const result = await this.vault.listMedia({
      page,
      size: pageSize,
      status: ["ready"],
      variants: [...previewVariants],
    });
    if (result.isErr()) throw mappedError(result.error);

    return {
      items: result.value.data.map(mapItem),
      page: result.value.pagination.page,
      pageSize,
      hasMore: result.value.pagination.hasMore,
      total: result.value.total,
      provenance,
    };
  }

  async getMedia(id: string): Promise<MediaAsset | null> {
    if (isDemoIdentifier(id)) {
      throw new MediaReadError("INVALID_IDENTIFIER", "Seeded demo identifiers cannot be sent to Fanvue.");
    }
    const result = await this.vault.getMedia(id, { variants: [...previewVariants] });
    if (result.isErr()) {
      if (result.error.code === "API_ERROR_RESPONSE" && result.error.statusCode === 404) return null;
      throw mappedError(result.error);
    }
    return mapItem(result.value);
  }
}
