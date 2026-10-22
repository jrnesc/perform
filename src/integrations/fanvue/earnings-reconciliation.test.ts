import { describe, expect, it, vi } from "vitest";
import { reconcileExperimentEarnings } from "./earnings-reconciliation";

const earning = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-10-21T11:00:00.000Z",
  gross: 1200,
  net: 1000,
  total: 1200,
  currency: "USD",
  source: "message",
  transactionOrderId: "payment-a",
  transactionOrderStatus: "availableForPayout",
  messageUuid: "message-a",
  messageType: "BROADCAST",
  user: { uuid: "fan-a" },
  ...overrides,
});

describe("Fanvue earnings reconciliation contract", () => {
  it("pages, deduplicates, applies reversals and attributes known assignments", async () => {
    const paymentA = earning();
    const paymentB = earning({
      transactionOrderId: "payment-b",
      messageUuid: "message-b",
      user: { uuid: "fan-b" },
      gross: 1500,
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [paymentA, paymentB], nextCursor: "next" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              paymentA,
              earning({
                source: "refund",
                transactionOrderId: "refund-b",
                reversedTransactionOrderId: "payment-b",
                messageUuid: null,
                gross: -1500,
                user: { uuid: "fan-b" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      );
    const result = await reconcileExperimentEarnings({
      startAt: "2026-10-21T10:00:00.000Z",
      endAt: "2026-10-22T10:00:00.000Z",
      messages: { "message-a": "A", "message-b": "B" },
      assignments: { "fan-a": "A", "fan-b": "B" },
      transport,
    });
    expect(result).toMatchObject({
      settledPurchases: { A: 1, B: 0 },
      settledMinor: { A: 1200, B: 0 },
      duplicateTransactions: 1,
      missingAssignments: [],
      orphanReversals: [],
      pagesRead: 2,
    });
  });

  it("skips reward, app-store and deduction rows without treating them as unreadable", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            earning(),
            earning({ source: "referral", transactionOrderId: "reward-1", user: null, messageUuid: undefined }),
            earning({ source: "giveaway", transactionOrderId: "reward-2", user: null, messageUuid: undefined }),
            earning({ source: "appStore", transactionOrderId: "app-1", user: null, messageUuid: undefined }),
            earning({
              source: "earningsDeduction",
              transactionOrderId: "deduct-1",
              gross: 0,
              reversedTransactionOrderId: "payment-a",
              messageUuid: undefined,
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    const result = await reconcileExperimentEarnings({
      startAt: "2026-10-21T10:00:00.000Z",
      endAt: "2026-10-22T10:00:00.000Z",
      messages: { "message-a": "A" },
      assignments: { "fan-a": "A" },
      transport,
    });
    expect(result).toMatchObject({ ignoredRows: 0, settledPurchases: { A: 1, B: 0 }, orphanReversals: [] });
  });

  it("fails closed on assignment drift and exposes an out-of-window reversal", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            earning({ user: { uuid: "fan-wrong" } }),
            earning({
              source: "chargeback",
              transactionOrderId: "chargeback-x",
              reversedTransactionOrderId: "missing-payment",
              messageUuid: null,
              gross: -1200,
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    const result = await reconcileExperimentEarnings({
      startAt: "2026-10-21T10:00:00.000Z",
      endAt: "2026-10-22T10:00:00.000Z",
      messages: { "message-a": "A" },
      assignments: { "fan-a": "A" },
      transport,
    });
    expect(result.settledPurchases).toEqual({ A: 0, B: 0 });
    expect(result.missingAssignments).toEqual(["fan-wrong"]);
    expect(result.orphanReversals).toEqual(["chargeback-x"]);
  });

  it("rejects a transaction ID reused with different content", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [earning()], nextCursor: "next" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [earning({ gross: 999 })], nextCursor: null })));
    await expect(
      reconcileExperimentEarnings({
        startAt: "2026-10-21T10:00:00.000Z",
        endAt: "2026-10-22T10:00:00.000Z",
        messages: { "message-a": "A" },
        assignments: { "fan-a": "A" },
        transport,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
