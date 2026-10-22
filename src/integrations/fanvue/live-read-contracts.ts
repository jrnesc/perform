export type FanvueReadTransport = (path: string, init?: RequestInit) => Promise<Response>;

export type LiveReadErrorCode =
  | "INVALID_RESPONSE"
  | "PAGINATION_LOOP"
  | "PERMISSION_REQUIRED"
  | "RATE_LIMITED"
  | "RECONNECT_REQUIRED"
  | "API_VERSION_UNSUPPORTED"
  | "UNAVAILABLE";

export class LiveReadError extends Error {
  constructor(
    readonly code: LiveReadErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function readError(response: Response): LiveReadError {
  if (response.status === 401) {
    return new LiveReadError("RECONNECT_REQUIRED", "Reconnect to Fanvue before reading live data.");
  }
  if (response.status === 403) {
    return new LiveReadError(
      "PERMISSION_REQUIRED",
      "The connected creator has not granted the required read permission.",
    );
  }
  if (response.status === 410) {
    // Sunset API version: retrying cannot help; the pinned X-Fanvue-API-Version must change.
    return new LiveReadError("API_VERSION_UNSUPPORTED", "The pinned Fanvue API version is no longer supported.");
  }
  if (response.status === 429) {
    const raw = response.headers.get("retry-after");
    const retryAfter = raw === null ? undefined : Number(raw);
    return new LiveReadError(
      "RATE_LIMITED",
      "Fanvue is rate limiting this read. Retry only after the declared delay.",
      Number.isFinite(retryAfter) && retryAfter! >= 0 ? retryAfter : undefined,
    );
  }
  return new LiveReadError("UNAVAILABLE", "Fanvue live data is temporarily unavailable.");
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw readError(response);
  try {
    return await response.json();
  } catch {
    throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned malformed JSON.");
  }
}
