import type { FanvueReadTransport } from "./live-read-contracts";

/**
 * Seeded experiments reconcile against this in-memory ledger and never reach Fanvue: no earnings
 * rows and zero-purchase totals for the given mass messages, which agree with no webhook events.
 */
export function fixtureReconciliationReadTransport(
  messageUuids: readonly string[],
): FanvueReadTransport & { requests: readonly string[] } {
  const requests: string[] = [];
  const respond = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const transport = async (path: string) => {
    requests.push(path);
    if (path.startsWith("/v1/insights/earnings")) return respond({ data: [], nextCursor: null });
    if (path.startsWith("/v1/chats/mass-messages")) {
      return respond({
        data: messageUuids.map((uuid) => ({
          uuid, status: "SENT", recipientCount: 0, viewCount: 0, purchaseCount: 0, totalRevenue: 0,
        })),
        nextCursor: null,
      });
    }
    return new Response(null, { status: 404 });
  };
  return Object.assign(transport, { requests });
}
