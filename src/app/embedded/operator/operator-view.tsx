"use client";

import { AuthProvider, useAuth, useEmbeddedAuth } from "@fanvue/builder-sdk/react";
import { Drama } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { OperatorEvidenceView } from "../../../live/operator-view";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; view: OperatorEvidenceView }
  | { kind: "error"; status: number; message: string };

const arms = (value: { A: number; B: number } | null) => (value ? `A ${value.A} · B ${value.B}` : "Not checked");
const yesNo = (value: boolean | null) => (value === null ? "Not checked" : value ? "Yes" : "No");
const reasonLabel = (reason: string) => reason.toLowerCase().replaceAll("_", " ");

/** Identifiers and counts only; this component receives no amounts or fan profile fields. */
export function OperatorEvidenceTables({ view }: { view: OperatorEvidenceView }) {
  const reasons = Object.entries(view.deadLetters.byReason);
  return (
    <>
      <section className="detail-panel" aria-labelledby="operator-dead-letters">
        <p className="eyebrow">Dead letters · {view.deadLetters.total} total</p>
        <h2 id="operator-dead-letters">Verified deliveries that could not be used</h2>
        <p>
          {reasons.length
            ? reasons.map(([reason, count]) => `${count} ${reasonLabel(reason)}`).join(" · ")
            : "None recorded."}
        </p>
        {view.deadLetters.recent.length > 0 && (
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <caption>Most recent {view.deadLetters.recent.length}</caption>
              <thead>
                <tr>
                  <th scope="col">Event ID</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Received</th>
                </tr>
              </thead>
              <tbody>
                {view.deadLetters.recent.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <code>{row.eventId ?? "unreadable"}</code>
                    </th>
                    <td>{reasonLabel(row.reason)}</td>
                    <td>
                      <time dateTime={row.receivedAt}>{row.receivedAt}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="detail-panel" aria-labelledby="operator-pending-reversals">
        <p className="eyebrow">Pending reversals · {view.pendingReversals.total} total</p>
        <h2 id="operator-pending-reversals">Refunds and disputes waiting for their payment</h2>
        {view.pendingReversals.oldest.length > 0 ? (
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <caption>Oldest {view.pendingReversals.oldest.length}</caption>
              <thead>
                <tr>
                  <th scope="col">Payment ID</th>
                  <th scope="col">Reversal ID</th>
                  <th scope="col">Type</th>
                  <th scope="col">Received</th>
                </tr>
              </thead>
              <tbody>
                {view.pendingReversals.oldest.map((row) => (
                  <tr key={row.eventId}>
                    <th scope="row">
                      <code>{row.paymentId}</code>
                    </th>
                    <td>
                      <code>{row.reversalId}</code>
                    </td>
                    <td>{row.reversalType.toLowerCase()}</td>
                    <td>
                      <time dateTime={row.receivedAt}>{row.receivedAt}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>None pending.</p>
        )}
      </section>
      <section className="detail-panel" aria-labelledby="operator-reconciliation">
        <p className="eyebrow">Reconciliation · latest snapshot per experiment</p>
        <h2 id="operator-reconciliation">Webhook evidence against the earnings ledger</h2>
        {view.reconciliation.length > 0 ? (
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th scope="col">Experiment</th>
                  <th scope="col">Captured</th>
                  <th scope="col">Complete</th>
                  <th scope="col">Drift</th>
                  <th scope="col">Reanalyse</th>
                  <th scope="col">Webhook settled</th>
                  <th scope="col">Ledger settled</th>
                  <th scope="col">Fanvue message totals</th>
                  <th scope="col">Totals differ</th>
                  <th scope="col">Missing assignment</th>
                  <th scope="col">Orphan reversals</th>
                  <th scope="col">Unreadable rows</th>
                  <th scope="col">Placed by window only</th>
                  <th scope="col">Unmatched plausible</th>
                </tr>
              </thead>
              <tbody>
                {view.reconciliation.map((row) => (
                  <tr key={row.snapshotId}>
                    <th scope="row">
                      <code>{row.experimentId}</code>
                    </th>
                    <td>
                      <time dateTime={row.capturedAt}>{row.capturedAt}</time>
                    </td>
                    <td>{yesNo(row.isComplete)}</td>
                    <td>{yesNo(row.discrepancy)}</td>
                    <td>{yesNo(row.needsReanalysis)}</td>
                    <td>{arms(row.webhookSettledPurchases)}</td>
                    <td>{arms(row.reconciledSettledPurchases)}</td>
                    <td>{arms(row.fanvuePurchases)}</td>
                    <td>{yesNo(row.massMessageMismatch)}</td>
                    <td>{row.missingAssignmentCount}</td>
                    <td>{row.orphanReversalCount}</td>
                    <td>{row.ignoredRowCount}</td>
                    <td>{row.assignmentWindowOnlyCount}</td>
                    <td>{row.unmatchedPlausibleCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No reconciliation snapshot has been recorded.</p>
        )}
      </section>
      <section className="detail-panel" aria-labelledby="operator-attribution">
        <p className="eyebrow">Attribution</p>
        <h2 id="operator-attribution">How stored payments were placed</h2>
        {view.attribution.length > 0 ? (
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th scope="col">Experiment</th>
                  <th scope="col">Message UUID matched</th>
                  <th scope="col">Assignment and window only</th>
                  <th scope="col">Unmatched plausible</th>
                </tr>
              </thead>
              <tbody>
                {view.attribution.map((row) => (
                  <tr key={row.experimentId}>
                    <th scope="row">
                      <code>{row.experimentId}</code>
                    </th>
                    <td>{row.messageMatched}</td>
                    <td>{row.assignmentWindowOnly}</td>
                    <td>{row.unmatchedPlausible}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No payment has been attributed.</p>
        )}
        <p>
          A high &ldquo;assignment and window only&rdquo; count with no message matches suggests payments carry
          per-recipient message IDs.
        </p>
      </section>
    </>
  );
}

function OperatorScreen() {
  const embedded = useEmbeddedAuth();
  const { authFetch } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    if (embedded.status !== "authenticated") return;
    let cancelled = false;
    authFetch("/api/operator/live-evidence")
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        if (cancelled) return;
        setState(
          response.ok
            ? { kind: "ready", view: body as unknown as OperatorEvidenceView }
            : {
                kind: "error",
                status: response.status,
                message: body?.error?.message ?? "Live evidence is unavailable.",
              },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", status: 0, message: "Perform could not reach its server." });
      });
    return () => {
      cancelled = true;
    };
  }, [authFetch, embedded.status]);

  return (
    <main data-theme="light">
      <header className="masthead">
        <Link className="brand-lockup history-brand" href="/embedded">
          <span className="brand-mark" aria-hidden="true">
            <Drama size={19} />
          </span>
          <div>
            <strong>Perform</strong>
            <span>Live evidence operations</span>
          </div>
        </Link>
        <span className="connection">
          <i />
          Read-only
        </span>
      </header>
      <div className="workspace-shell history-shell">
        <header className="detail-hero">
          <div>
            <p className="eyebrow">Operator view</p>
            <h1>Live evidence health</h1>
            <p className="lede">
              Dead letters, pending reversals and reconciliation state from the real database. Identifiers and counts
              only; nothing here changes evidence or calls Fanvue.
            </p>
          </div>
        </header>
        {state.kind === "loading" && (
          <section className="detail-panel">
            <p>Loading live evidence…</p>
          </section>
        )}
        {state.kind === "error" && (
          <section className="detail-panel" role="alert">
            <h2>{state.status === 404 ? "No live operator is configured" : "Live evidence is unavailable"}</h2>
            <p>{state.message}</p>
          </section>
        )}
        {state.kind === "ready" && <OperatorEvidenceTables view={state.view} />}
      </div>
    </main>
  );
}

export function OperatorView() {
  return (
    <AuthProvider>
      <OperatorScreen />
    </AuthProvider>
  );
}
