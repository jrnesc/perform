"use client";

import { AuthProvider, useAuth, useEmbeddedAuth } from "@fanvue/builder-sdk/react";
import { Drama, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DEMO_EXPERIMENT_HISTORY } from "../../experiments/demo-experiment-history";
import type { ExperimentRecord } from "../../persistence/contracts";
import { analyseResult } from "../../results/analyse";
import {
  audienceSegments,
  isCurrentAudienceEvidence,
  relationshipLabel,
  type AudienceBreakdownDimension,
} from "../../results/audience-evidence";
import type { AnalysedResult, AudienceMemberEvidence } from "../../results/contracts";
import { DEMO_RESULT_FIXTURES } from "../../results/demo-results-v1";
import { experimentResultDetail, experimentResultSummary } from "../../results/experiment-results";
import type { LiveAudienceBreakdown } from "../../results/live-audience-evidence";
import { ResultHeadline, UncertaintyChart } from "./experiment-experience";
import styles from "./experiment-history.module.css";

/** An experiment from the creator's own database, with its launch and latest reconciliation when it has them. */
export type RealExperiment = ExperimentRecord & {
  launch: { scheduledAt: string; observationEndsAt: string; armCounts: { A: number; B: number } } | null;
  reconciliation: { capturedAt: string; windowEnd: string; isComplete: boolean; note: string } | null;
};

type DatabaseExperiment = RealExperiment & { workspace: "real" | "demo" };

/** The REAL Results read for one experiment: its per-member evidence, or why it is not available. */
export type LiveResults =
  | { status: "loading" }
  | { status: "available"; breakdown: LiveAudienceBreakdown; analysis: AnalysedResult | null }
  | { status: "unavailable"; message: string };

export type LifecycleOutcome = { ok: true; message: string } | { ok: false; reasons: readonly string[] };
export type LifecycleAction = (
  action: "reconcile" | "close" | "discard" | "abandon",
  experiment: DatabaseExperiment,
) => Promise<LifecycleOutcome>;

export const previewHistoryStorageKey = "perform:preview:experiments:v1";

function readSaved(): ExperimentRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(previewHistoryStorageKey) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function stateLabel(state: ExperimentRecord["state"]): string {
  return state.replaceAll("_", " ").toLowerCase();
}

const historyDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const historyDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatHistoryDate(value: string): string {
  return historyDateFormatter.format(new Date(value));
}

function formatHistoryDateTime(value: string): string {
  return `${historyDateTimeFormatter.format(new Date(value))} UTC`;
}

function audienceLabel(sourceAudienceUuid: string): string {
  return sourceAudienceUuid.includes("recent") ? "Recent buyers" : "Active subscribers";
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}
function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

const demoResults = DEMO_RESULT_FIXTURES.map(analyseResult);

function linkedResult(experiment: ExperimentRecord): AnalysedResult | null {
  return demoResults.find(({ fixture }) => fixture.experimentId === experiment.id) ?? null;
}

function resultSummaryLabel(experiment: ExperimentRecord): string {
  const result = linkedResult(experiment);
  const summary = experimentResultSummary(experiment, result);
  if (!summary) return "No evidence yet";
  if (!summary.isComplete) return summary.status === "PARTIAL_LAUNCH" ? "Launch blocked" : "Evidence incomplete";
  if (summary.status === "INVALID") return "Invalid comparison";
  // Only a dependable direction earns a winner; an observed lead inside the uncertainty is not one.
  if (result?.confidence.status !== "DEPENDABLE") return "No clear winner";
  return `Arm ${summary.observedDirection.outcome[0]} won`;
}

const absentRelationshipNote =
  "No never-subscribed or lapsed fans: the subscribers list holds current subscribers only.";

export function AudienceEvidencePanel({
  evidence,
  caveat,
}: {
  evidence: readonly AudienceMemberEvidence[];
  caveat?: string | null;
}) {
  const [dimension, setDimension] = useState<AudienceBreakdownDimension>("PRIOR_PURCHASER");
  if (!isCurrentAudienceEvidence(evidence)) return null;
  const live = evidence[0].provenance === "REAL";
  const all = audienceSegments(evidence, dimension);
  const segments = dimension === "RELATIONSHIP" ? all.filter((segment) => segment.members.length > 0) : all;
  const absent =
    dimension === "RELATIONSHIP"
      ? all.filter((segment) => segment.members.length === 0).map((segment) => segment.label.toLowerCase())
      : [];
  return (
    <section className={styles.audienceBreakdown} aria-labelledby="audience-breakdown-title">
      <header>
        <div>
          <div className={styles.sectionHeading}>
            <h2 id="audience-breakdown-title" className="section-title">
              Who converted and reversed?
            </h2>
            <span className={live ? styles.provenanceLive : styles.fixtureLabel}>
              {live ? "Live Fanvue evidence" : "Seeded demo · not live"}
            </span>
          </div>
          <p>
            New buyer means no settled purchase before assignment; returning buyer means at least one. Subscriber
            relationship is frozen before assignment from subscription history and renewal status. These cohorts
            describe this test and do not identify subgroup winners.
          </p>
        </div>
        <div className={styles.breakdownControls} aria-label="Audience breakdown">
          <button
            type="button"
            className={dimension === "PRIOR_PURCHASER" ? "active" : ""}
            aria-pressed={dimension === "PRIOR_PURCHASER"}
            onClick={() => setDimension("PRIOR_PURCHASER")}
          >
            Prior-purchaser status
          </button>
          <button
            type="button"
            className={dimension === "RELATIONSHIP" ? "active" : ""}
            aria-pressed={dimension === "RELATIONSHIP"}
            onClick={() => setDimension("RELATIONSHIP")}
          >
            Subscriber relationship
          </button>
        </div>
      </header>
      <table className={styles.segmentTable}>
        <caption className="sr-only">Purchases by audience segment and arm</caption>
        <thead>
          <tr>
            <th scope="col">Segment</th>
            <th scope="col">
              <i className={styles.armA} aria-hidden="true" />
              Arm A
            </th>
            <th scope="col">
              <i className={styles.armB} aria-hidden="true" />
              Arm B
            </th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.key}>
              <th scope="row">
                {segment.label}
                <small>{segment.members.length} assigned</small>
              </th>
              {segment.isSmall ? (
                <td colSpan={2} className={styles.segmentSuppressed}>
                  Hidden: fewer than 5 assigned members
                </td>
              ) : (
                (["A", "B"] as const).map((arm) => {
                  const value = segment.arms[arm];
                  return (
                    <td key={arm}>
                      <strong>
                        {value.converted} of {value.assigned}
                      </strong>{" "}
                      bought
                      <small>
                        {money(value.settledRevenueMinor)} settled · {value.reversedPurchases} reversed
                      </small>
                    </td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {absent.length > 0 && (
        <p className={styles.privacyNote}>
          {absent.length === 2 && absent.includes("never subscribed") && absent.includes("lapsed")
            ? absentRelationshipNote
            : `No members in: ${absent.join(", ")}.`}
        </p>
      )}
      {caveat && <p className={styles.resultWarning}>{caveat}</p>}
      <details className={styles.memberAudit}>
        <summary>
          <span>Member audit</span>
          <small>
            {evidence.length} {evidence.length === 1 ? "fan" : "fans"} · privacy-conscious
          </small>
        </summary>
        <div className="evidence-table-wrap">
          <table className={`${styles.historyTable} evidence-table`}>
            <caption>Stable UUIDs and experiment evidence only</caption>
            <thead>
              <tr>
                <th scope="col">Fan UUID</th>
                <th scope="col">Arm</th>
                <th scope="col">Buyer definition</th>
                <th scope="col">Subscriber relationship</th>
                <th scope="col">Outcome</th>
                <th scope="col">Settled value</th>
                <th scope="col">Reversal</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((row) => (
                <tr key={row.fanUuid}>
                  <th scope="row">
                    <code>{row.fanUuid}</code>
                  </th>
                  <td>{row.arm}</td>
                  <td>
                    {row.priorPurchaserStatus === "PRIOR_PURCHASER"
                      ? `Returning · ${row.priorSettledPurchaseCount} prior`
                      : "New · 0 prior"}
                  </td>
                  <td>
                    {relationshipLabel(row.subscriberRelationship)}
                    {row.resubscribedAfterLapse ? " · resubscribed" : ""}
                  </td>
                  <td>{row.converted ? "Converted" : "No purchase"}</td>
                  <td>{money(row.settledRevenueMinor)}</td>
                  <td>{row.disputed ? "Disputed" : row.fullyRefunded ? "Fully refunded" : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className={styles.privacyNote}>
        No display names, handles, email addresses or profile fields are stored or shown. Segment differences are
        descriptive, not individual-fan causal conclusions.
      </p>
    </section>
  );
}

/** What each arm sent next to how it did, with the tested variable given the emphasis. */
function ArmCards({ result }: { result: AnalysedResult }) {
  const { variable, variants, comparison } = result.fixture;
  const direction = result.observedDirection;
  const winner = result.confidence.supportsLearning && direction.outcome !== "TIED" ? direction.outcome[0] : null;
  const shared =
    variable === "COPY"
      ? `Same price for both arms: ${money(variants[0].priceMinor)}.`
      : `Same message for both arms: “${variants[0].copy}”`;
  return (
    <section className="detail-section" aria-labelledby="arms-title">
      <h2 id="arms-title" className="section-title">
        What was tested
      </h2>
      <p className={styles.sectionNote}>{shared}</p>
      <div className={styles.armCards}>
        {variants.map((variant) => {
          const value = result.arms[variant.arm];
          return (
            <article key={variant.arm} className={`${styles.armCard} ${winner === variant.arm ? styles.winner : ""}`}>
              <header>
                <span className={styles.armName}>
                  <i className={variant.arm === "A" ? styles.armA : styles.armB} aria-hidden="true" />
                  Arm {variant.arm} <span>· {comparison[variant.arm === "A" ? "armALabel" : "armBLabel"]}</span>
                </span>
                {winner === variant.arm && <span className={styles.winnerPill}>Performed better</span>}
              </header>
              {variable === "COPY" ? (
                <p className={styles.armVariable}>“{variant.copy}”</p>
              ) : (
                <p className={`${styles.armVariable} ${styles.armPrice}`}>
                  {money(variant.priceMinor)} <span>price</span>
                </p>
              )}
              <div className={styles.armOutcome}>
                <strong>{variable === "COPY" ? percentage(value.primaryRate) : money(value.primaryRate)}</strong>
                <span>{variable === "COPY" ? "purchase rate" : "settled revenue per recipient"}</span>
              </div>
              <dl>
                <div>
                  <dt>Bought</dt>
                  <dd>
                    {value.settledPurchases} of {value.assignedRecipients}
                  </dd>
                </div>
                <div>
                  <dt>Settled revenue</dt>
                  <dd>{money(value.settledRevenueMinor)}</dd>
                </div>
                <div>
                  <dt>Refunded or disputed</dt>
                  <dd>{value.reversedPurchases}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      {result.warnings.map((warning) => (
        <p className={`${styles.sectionNote} ${styles.armWarning}`} key={warning}>
          {warning}
        </p>
      ))}
    </section>
  );
}

/**
 * Live results for a REAL experiment: the same verdict, uncertainty and evidence gates as the seeded
 * results, then per-arm totals counted from the per-member evidence the cohort panel uses.
 */
function LiveResultsSection({
  breakdown,
  analysis,
  closed,
}: {
  breakdown: LiveAudienceBreakdown;
  analysis: AnalysedResult | null;
  closed: boolean;
}) {
  const arms = (["A", "B"] as const).map((arm) => {
    const rows = breakdown.evidence.filter((row) => row.arm === arm);
    return {
      arm,
      assigned: rows.length,
      converted: rows.filter((row) => row.converted).length,
      settledRevenueMinor: rows.reduce((sum, row) => sum + row.settledRevenueMinor, 0),
      reversed: rows.filter((row) => row.fullyRefunded || row.disputed).length,
    };
  });
  const purchases = arms.reduce((sum, arm) => sum + arm.converted, 0);
  return (
    <div className={styles.detailFlow}>
      {analysis && <ResultHeadline result={analysis} />}
      <section className="detail-section" aria-labelledby="live-results-title">
        <div className={styles.sectionHeading}>
          <h2 id="live-results-title" className="section-title">
            {closed ? "Final result" : "Results so far"}
          </h2>
          <span className={styles.provenanceLive}>{closed ? "Live · frozen at close" : "Live Fanvue evidence"}</span>
        </div>
        <p className={styles.sectionNote}>
          {purchases === 0
            ? "No attributed purchases yet. Counts update as payment webhooks and reconciliations arrive."
            : "Counts of fans who bought after assignment, by the arm they were assigned to."}
        </p>
        <div className={styles.armCards}>
          {arms.map((value) => (
            <article key={value.arm} className={styles.armCard}>
              <header>
                <span className={styles.armName}>
                  <i className={value.arm === "A" ? styles.armA : styles.armB} aria-hidden="true" />
                  Arm {value.arm}
                </span>
              </header>
              <div className={styles.armOutcome}>
                <strong>{value.assigned ? percentage(value.converted / value.assigned) : "—"}</strong>
                <span>purchase rate</span>
              </div>
              <dl>
                <div>
                  <dt>Bought</dt>
                  <dd>
                    {value.converted} of {value.assigned}
                  </dd>
                </div>
                <div>
                  <dt>Settled revenue</dt>
                  <dd>{money(value.settledRevenueMinor)}</dd>
                </div>
                <div>
                  <dt>Refunded or disputed</dt>
                  <dd>{value.reversed}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        {breakdown.unmatchedPlausible > 0 && (
          <p className={`${styles.sectionNote} ${styles.armWarning}`}>
            {breakdown.unmatchedPlausible} plausible{" "}
            {breakdown.unmatchedPlausible === 1 ? "payment was" : "payments were"} not counted because no message ID
            matched.
          </p>
        )}
      </section>
      {analysis && <UncertaintyChart result={analysis} />}
      <AudienceEvidencePanel evidence={breakdown.evidence} caveat={breakdown.caveat} />
    </div>
  );
}

/** Audit detail a creator rarely needs: one chronological timeline, then where the data came from and the stable ID. */
function ExperimentRecord({
  experiment,
  provenance,
  launch,
  result,
}: {
  experiment: ExperimentRecord;
  provenance: string;
  launch: RealExperiment["launch"];
  result: AnalysedResult | null;
}) {
  const events = [
    { id: "created", at: experiment.createdAt, label: "Created", detail: null as string | null },
    ...(result?.fixture.evidence ?? []).map((event) => ({
      id: event.id,
      at: event.occurredAt,
      label: event.label,
      detail: event.detail,
    })),
    ...(launch
      ? [
          {
            id: "scheduled",
            at: launch.scheduledAt,
            label: "Both messages scheduled",
            detail: `${launch.armCounts.A} in arm A · ${launch.armCounts.B} in arm B`,
          },
          {
            id: "window",
            at: launch.observationEndsAt,
            label: experiment.state === "CLOSED" ? "Observation window closed" : "Observation window ends",
            detail: null,
          },
        ]
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <details className={styles.experimentRecord}>
      <summary>
        <span>Experiment record</span>
        <small>Timeline, data source and ID</small>
      </summary>
      <div className={styles.experimentRecordBody}>
        <ol className={styles.timeline}>
          {events.map((event) => (
            <li key={event.id}>
              <span className={styles.timelineDot} aria-hidden="true" />
              <div>
                <strong>{event.label}</strong>
                {event.detail && <p>{event.detail}</p>}
                <time dateTime={event.at}>{formatHistoryDateTime(event.at)}</time>
              </div>
            </li>
          ))}
        </ol>
        <dl className={styles.detailFacts}>
          <div>
            <dt>Data</dt>
            <dd>{provenance}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>
              <code>{experiment.id}</code>
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

/** Experiment detail, read top to bottom: the verdict, what was tested, how sure, who converted, then the record. */
function ExperimentDetail({
  experiment,
  base,
  live,
  database,
  lifecycle,
  liveResults,
}: {
  experiment: ExperimentRecord;
  base: string;
  live: boolean;
  database?: DatabaseExperiment;
  lifecycle?: LifecycleAction;
  liveResults?: LiveResults;
}) {
  const launch = database?.launch ?? null;
  const result = database ? null : experimentResultDetail(experiment, linkedResult(experiment)).result;
  const provenance = live
    ? "Live Fanvue data"
    : database
      ? "Seeded database · fixture gateway, no Fanvue requests"
      : "Seeded demo fixture · no live data";
  const audienceSize = launch ? launch.armCounts.A + launch.armCounts.B : experiment.snapshotCount;
  const meta = [
    `${experiment.variable === "COPY" ? "Copy" : "Price"} test`,
    audienceLabel(experiment.sourceAudienceUuid),
    audienceSize ? `${audienceSize} ${live ? "subscribers" : "fans"}` : null,
    launch
      ? `${experiment.state === "CLOSED" ? "ended" : "ends"} ${formatHistoryDate(launch.observationEndsAt)}`
      : `updated ${formatHistoryDate(experiment.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const emptyTitle =
    experiment.state === "RUNNING"
      ? "Awaiting purchases"
      : experiment.state === "CLOSED"
        ? "Closed"
        : "No evidence yet";
  const emptyBody = database
    ? experiment.state === "RUNNING"
      ? "Both messages are scheduled. Results appear here once purchases from the two arms have been observed and reconciled."
      : experiment.state === "CLOSED"
        ? "Observation ended and metrics are frozen at the final reconciliation."
        : "Results appear once this experiment has been launched and observed."
    : experiment.state === "RUNNING"
      ? "This experiment is running, but no complete result snapshot is available yet."
      : "This experiment has no result evidence. Perform will not attach another experiment’s scenario.";
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={base}>Experiments</Link>
        <span>/</span>
        <span>{experiment.name}</span>
      </nav>
      <header className="detail-hero">
        <div>
          <h1>{experiment.name}</h1>
          <p className={styles.detailMeta}>{meta}</p>
          <p className="lede">{experiment.hypothesis}</p>
        </div>
        <span className={styles.statusPill} data-state={experiment.state.toLowerCase()}>
          {stateLabel(experiment.state)}
        </span>
      </header>
      {database?.launch && lifecycle && (
        <ExperimentLifecycle key={experiment.id} experiment={database} lifecycle={lifecycle} />
      )}
      {database && !database.launch && experiment.state === "ALLOCATED" && lifecycle && (
        <SavedExperimentActions key={experiment.id} experiment={database} lifecycle={lifecycle} base={base} />
      )}
      {database && (experiment.state === "PROVISIONING" || experiment.state === "VERIFIED") && lifecycle && (
        <InterruptedLaunchActions key={experiment.id} experiment={database} lifecycle={lifecycle} base={base} />
      )}
      {result ? (
        <div className={styles.detailFlow}>
          <ResultHeadline result={result} />
          <ArmCards result={result} />
          <UncertaintyChart result={result} />
          <AudienceEvidencePanel evidence={result.fixture.audienceEvidence ?? []} />
        </div>
      ) : live && launch && liveResults?.status === "available" ? (
        <LiveResultsSection
          breakdown={liveResults.breakdown}
          analysis={liveResults.analysis}
          closed={experiment.state === "CLOSED"}
        />
      ) : live && launch && liveResults?.status === "loading" ? (
        <div className={styles.resultEmpty} role="status" aria-busy="true">
          <h2>Loading live results…</h2>
        </div>
      ) : (
        <div className={styles.resultEmpty}>
          <h2>{emptyTitle}</h2>
          <p>{emptyBody}</p>
          {live && launch && liveResults?.status === "unavailable" && (
            <p className={styles.resultWarning}>{liveResults.message}</p>
          )}
        </div>
      )}
      <ExperimentRecord experiment={experiment} provenance={provenance} launch={launch} result={result} />
    </>
  );
}

/** A saved experiment that was allocated but never launched: launch it later, or discard it. */
/** A launch that stopped before any message was scheduled: it cannot resume, so it can be abandoned. */
function InterruptedLaunchActions({
  experiment,
  lifecycle,
  base,
}: {
  experiment: DatabaseExperiment;
  lifecycle: LifecycleAction;
  base: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<readonly string[] | null>(null);
  const seeded = experiment.workspace === "demo";
  const abandon = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await lifecycle("abandon", experiment);
    setBusy(false);
    if (outcome.ok) router.push(base);
    else setProblem(outcome.reasons);
  };
  return (
    <section className="detail-panel lifecycle-panel" aria-labelledby="interrupted-title">
      <p className="eyebrow">
        Launch interrupted
        {seeded && (
          <>
            {" "}
            · <span className={styles.fixtureLabel}>Seeded · zero Fanvue requests</span>
          </>
        )}
      </p>
      <h2 id="interrupted-title">This launch stopped before sending</h2>
      <p className={styles.lifecycleNote}>
        Perform started setting up the two custom lists
        {experiment.launch ? `, for delivery at ${formatHistoryDateTime(experiment.launch.scheduledAt)},` : ""} but
        stopped before scheduling any message, so no fan received anything. A launch is tied to its delivery time, so
        this one cannot be resumed. Abandoning it deletes the lists it created{seeded ? "" : " in Fanvue"} and hides it
        from your list.
      </p>
      <div className={styles.lifecycleActions}>
        {confirming ? (
          <>
            <span className={styles.lifecycleConfirm}>Abandon this launch and delete its lists?</span>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button type="button" className={styles.danger} disabled={busy} aria-busy={busy} onClick={abandon}>
              {busy ? "Abandoning…" : "Abandon"}
            </button>
          </>
        ) : (
          <button type="button" className={styles.danger} onClick={() => setConfirming(true)}>
            Abandon launch
          </button>
        )}
      </div>
      {problem && (
        <div className={`${styles.lifecycleOutcome} ${styles.blocked}`} role="alert">
          <strong>Not abandoned</strong>
          <ul>
            {problem.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SavedExperimentActions({
  experiment,
  lifecycle,
  base,
}: {
  experiment: DatabaseExperiment;
  lifecycle: LifecycleAction;
  base: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<readonly string[] | null>(null);
  const discard = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await lifecycle("discard", experiment);
    setBusy(false);
    if (outcome.ok) router.push(base);
    else setProblem(outcome.reasons);
  };
  const resumeHref = `${base}/new?resume=${encodeURIComponent(experiment.id)}&workspace=${experiment.workspace}`;
  return (
    <section className="detail-panel lifecycle-panel" aria-labelledby="saved-title">
      <p className="eyebrow">
        Not launched
        {experiment.workspace === "demo" && (
          <>
            {" "}
            · <span className={styles.fixtureLabel}>Seeded · zero Fanvue requests</span>
          </>
        )}
      </p>
      <h2 id="saved-title">Ready to launch</h2>
      <p className={styles.lifecycleNote}>
        The audience is frozen and split into two arms, but nothing has been created or sent in Fanvue. Continue to
        choose a delivery time and schedule both arms, or discard it.
      </p>
      <div className={styles.lifecycleActions}>
        {confirming ? (
          <>
            <span className={styles.lifecycleConfirm}>Discard this experiment? It will be hidden from your list.</span>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button type="button" className={styles.danger} disabled={busy} aria-busy={busy} onClick={discard}>
              {busy ? "Discarding…" : "Discard"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="secondary" onClick={() => setConfirming(true)}>
              Discard
            </button>
            <Link className="primary button-link" href={resumeHref}>
              Continue to launch
            </Link>
          </>
        )}
      </div>
      {problem && (
        <div className={`${styles.lifecycleOutcome} ${styles.blocked}`} role="alert">
          <strong>Not discarded</strong>
          <ul>
            {problem.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Manual reconciliation and checked close for a launched database experiment (ADR 0020). */
function ExperimentLifecycle({
  experiment,
  lifecycle,
}: {
  experiment: DatabaseExperiment;
  lifecycle: LifecycleAction;
}) {
  const [busy, setBusy] = useState<"reconcile" | "close" | null>(null);
  const [outcome, setOutcome] = useState<LifecycleOutcome | null>(null);
  const run = async (action: "reconcile" | "close") => {
    setBusy(action);
    setOutcome(null);
    try {
      setOutcome(await lifecycle(action, experiment));
    } finally {
      setBusy(null);
    }
  };
  const launch = experiment.launch!;
  const reconciliation = experiment.reconciliation;
  const seeded = experiment.workspace === "demo";
  if (experiment.state === "CLOSED") {
    return (
      <section id="lifecycle" className="detail-panel lifecycle-panel">
        <p className="eyebrow">Lifecycle</p>
        <h2>Closed</h2>
        <p>
          Observation ended {formatHistoryDateTime(launch.observationEndsAt)}. Both custom lists were deleted
          {seeded ? " in the fixture gateway" : " in Fanvue"} and metrics are frozen.
        </p>
      </section>
    );
  }
  if (experiment.state !== "RUNNING") return null;
  return (
    <section id="lifecycle" className="detail-panel lifecycle-panel" aria-labelledby="lifecycle-title">
      <p className="eyebrow">
        Lifecycle
        {seeded && (
          <>
            {" "}
            · <span className={styles.fixtureLabel}>Seeded · zero Fanvue requests</span>
          </>
        )}
      </p>
      <h2 id="lifecycle-title">Observation and close</h2>
      <dl className={styles.detailFacts}>
        <div>
          <dt>Observation ends</dt>
          <dd>{formatHistoryDateTime(launch.observationEndsAt)}</dd>
        </div>
        <div>
          <dt>Latest reconciliation</dt>
          <dd>
            {reconciliation
              ? `${formatHistoryDateTime(reconciliation.capturedAt)} · ${reconciliation.isComplete ? "complete" : "incomplete"}`
              : "None yet"}
          </dd>
        </div>
      </dl>
      {reconciliation && <p className={styles.lifecycleNote}>{reconciliation.note}</p>}
      <p className={styles.lifecycleNote}>
        Closing needs the window to have ended and a clean reconciliation, including Fanvue’s per-message totals, that
        covers it. It then deletes both custom lists{seeded ? "" : " in Fanvue"} and freezes the metrics.
      </p>
      <div className={styles.lifecycleActions}>
        <button
          type="button"
          className="secondary"
          disabled={busy !== null}
          aria-busy={busy === "reconcile"}
          onClick={() => run("reconcile")}
        >
          {busy === "reconcile" ? "Reconciling…" : "Run reconciliation"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          aria-busy={busy === "close"}
          onClick={() => run("close")}
        >
          {busy === "close" ? "Checking…" : "Close experiment"}
        </button>
      </div>
      {outcome &&
        (outcome.ok ? (
          <p className={styles.lifecycleOutcome} role="status">
            {outcome.message}
          </p>
        ) : (
          <div className={`${styles.lifecycleOutcome} ${styles.blocked}`} role="alert">
            <strong>Not closed yet</strong>
            <ul>
              {outcome.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

export function ExperimentHistory({
  preview,
  selectedId,
  realExperiments = [],
  seededExperiments = [],
  realLoading = false,
  realError = false,
  onRetryReal,
  lifecycle,
  liveResults,
}: {
  preview: boolean;
  selectedId?: string;
  realExperiments?: readonly RealExperiment[];
  /** Seeded experiments saved in the demo database; they launch and close through the fixture gateway. */
  seededExperiments?: readonly RealExperiment[];
  realLoading?: boolean;
  lifecycle?: LifecycleAction;
  /** The live list could not be read; shown instead of the empty state, with a retry. */
  realError?: boolean;
  onRetryReal?: () => void;
  /** The REAL Results read for the selected experiment, when it is a launched live one. */
  liveResults?: LiveResults;
}) {
  const base = preview ? "/preview" : "/embedded";
  const [saved, setSaved] = useState<ExperimentRecord[]>([]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSaved(readSaved()));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const realById = useMemo(() => new Map(realExperiments.map((item) => [item.id, item])), [realExperiments]);
  const dbById = useMemo(
    () =>
      new Map<string, DatabaseExperiment>([
        ...seededExperiments.map((item) => [item.id, { ...item, workspace: "demo" as const }] as const),
        ...realExperiments.map((item) => [item.id, { ...item, workspace: "real" as const }] as const),
      ]),
    [realExperiments, seededExperiments],
  );
  const experiments = useMemo(
    () =>
      [...realExperiments, ...seededExperiments, ...saved, ...DEMO_EXPERIMENT_HISTORY]
        .filter((item, index, all) => all.findIndex(({ id }) => id === item.id) === index)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            b.createdAt.localeCompare(a.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    [saved, realExperiments, seededExperiments],
  );
  const [view, setView] = useState<"live" | "seeded">("live");
  const listed = preview ? experiments : experiments.filter((item) => realById.has(item.id) === (view === "live"));
  const selected = selectedId ? experiments.find(({ id }) => id === selectedId) : undefined;
  const liveReadFailed = !preview && realError && !realLoading;
  const liveReadError = (
    <section className={`empty-state ${styles.historyEmpty}`} role="alert">
      <h2>Your experiments could not be loaded</h2>
      <p>Perform could not read your live experiments just now. Nothing has changed in Fanvue.</p>
      {onRetryReal && (
        <button type="button" className="secondary" onClick={onRetryReal}>
          Try again
        </button>
      )}
    </section>
  );

  return (
    <main data-theme="light">
      <header className="masthead">
        <Link className="brand-lockup history-brand" href={base}>
          <span className="brand-mark" aria-hidden="true">
            <Drama size={19} />
          </span>
          <div>
            <strong>Perform</strong>
            <span>Offer experiments</span>
          </div>
        </Link>
        <span className="connection">
          <i />
          {preview ? "Fixture preview" : "Creator workspace"}
        </span>
      </header>
      <div className={`workspace-shell ${selectedId ? "history-shell" : "setup-shell"}`}>
        {selectedId ? (
          selected ? (
            <>
              <ExperimentDetail
                experiment={selected}
                base={base}
                live={realById.has(selected.id)}
                database={dbById.get(selected.id)}
                lifecycle={lifecycle}
                liveResults={liveResults}
              />
            </>
          ) : realLoading ? (
            <section className={`empty-state ${styles.historyEmpty}`} role="status" aria-busy="true">
              <h1>Loading experiment…</h1>
            </section>
          ) : liveReadFailed ? (
            liveReadError
          ) : (
            <section className={`empty-state ${styles.historyEmpty}`}>
              <p className="eyebrow">Not found</p>
              <h1>That experiment is not in this workspace.</h1>
              <p>Experiment detail fails closed when its creator or provenance-scoped record cannot be found.</p>
              <Link className="primary button-link" href={base}>
                Return to experiments
              </Link>
            </section>
          )
        ) : (
          <>
            <header className={styles.historyHero}>
              <div>
                <h1>Your experiments</h1>
                <p className="lede">
                  Find the message and price your fans respond to. Start a test, continue a draft, or review past
                  results.
                </p>
              </div>
              <div className={styles.historyActions}>
                {!preview && (
                  <div className="workspace-switch" role="group" aria-label="Data workspace">
                    <button
                      type="button"
                      aria-pressed={view === "live"}
                      className={view === "live" ? "active" : ""}
                      onClick={() => setView("live")}
                    >
                      Live
                    </button>
                    <button
                      type="button"
                      aria-pressed={view === "seeded"}
                      className={view === "seeded" ? "active" : ""}
                      onClick={() => setView("seeded")}
                    >
                      Demo
                    </button>
                  </div>
                )}
                <Link className="primary button-link" href={`${base}/new`}>
                  <Plus size={16} />
                  Create A/B test
                </Link>
              </div>
            </header>
            {view === "live" && liveReadFailed ? (
              liveReadError
            ) : listed.length === 0 ? (
              <section className={`empty-state ${styles.historyEmpty}`}>
                <h2>
                  {view === "live" && !preview
                    ? realLoading
                      ? "Loading your experiments…"
                      : "No live experiments yet"
                    : "No experiments yet"}
                </h2>
                <p>
                  {view === "live" && !preview
                    ? "Experiments you launch from Perform appear here. Switch to Demo to see example results."
                    : "Create your first named A/B test. It will appear here after it is saved."}
                </p>
              </section>
            ) : (
              <section className={styles.historyTableWrap} aria-label="Experiment history">
                <table className={styles.historyTable}>
                  <thead>
                    <tr>
                      <th scope="col">Experiment</th>
                      <th scope="col">Status</th>
                      <th scope="col">Result</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((experiment) => {
                      const launch = dbById.get(experiment.id)?.launch;
                      return (
                        <tr key={experiment.id}>
                          <th scope="row">
                            <Link href={`${base}/experiments/${encodeURIComponent(experiment.id)}`}>
                              {experiment.name}
                            </Link>
                            <span>
                              {experiment.variable === "COPY" ? "Copy" : "Price"} test ·{" "}
                              {audienceLabel(experiment.sourceAudienceUuid)}
                              {launch && (
                                <>
                                  {" "}
                                  · {launch.armCounts.A + launch.armCounts.B} recipients ·{" "}
                                  {realById.has(experiment.id) ? "live" : "seeded"}
                                </>
                              )}
                            </span>
                          </th>
                          <td data-label="Status">
                            <span className={styles.statusPill} data-state={experiment.state.toLowerCase()}>
                              {stateLabel(experiment.state)}
                            </span>
                            {launch && (
                              <small>
                                Ends{" "}
                                <time dateTime={launch.observationEndsAt}>
                                  {formatHistoryDate(launch.observationEndsAt)}
                                </time>
                              </small>
                            )}
                          </td>
                          <td data-label="Result" className={styles.historyResult}>
                            {dbById.has(experiment.id)
                              ? experiment.state === "RUNNING"
                                ? "Awaiting purchases"
                                : experiment.state === "CLOSED"
                                  ? "Closed"
                                  : "No evidence yet"
                              : resultSummaryLabel(experiment)}
                          </td>
                          <td data-label="Updated">
                            <time dateTime={experiment.updatedAt}>{formatHistoryDate(experiment.updatedAt)}</time>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(preview || view === "seeded") && (
                  <p className={styles.fixtureNote}>
                    <span className={styles.fixtureLabel}>Demo</span> Five fixtures cover a clear winner, a clear
                    no-difference, a running test and blocked launches. Newly saved preview tests appear here too.
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

type LifecycleBody = {
  discarded?: boolean;
  result?:
    | { status: "CLOSED" | "ABANDONED"; deletedLists: number }
    | { status: "OPEN" | "REFUSED"; reasons: readonly string[] };
  reconciliation?: { isComplete: boolean; note: string };
  error?: { message: string };
};

function RealHistory({ selectedId }: { selectedId?: string }) {
  const { status } = useEmbeddedAuth();
  const { authFetch } = useAuth();
  const [real, setReal] = useState<readonly RealExperiment[]>([]);
  const [seeded, setSeeded] = useState<readonly RealExperiment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [realError, setRealError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    const read = (url: string) =>
      authFetch(url).then(async (response) => {
        if (!response.ok)
          throw Object.assign(new Error(`Experiments read failed with ${response.status}`), {
            status: response.status,
          });
        const body = (await response.json()) as { experiments?: RealExperiment[] };
        return body.experiments ?? [];
      });
    // The live list must load or say it failed: an empty table would claim the creator has none.
    const live = read("/api/experiments")
      .then((experiments) => ({ ok: true as const, experiments }))
      .catch(() => ({ ok: false as const, experiments: [] as RealExperiment[] }));
    // The seeded list answers 403 for creators outside the demo allowlist, which reads as empty.
    const demo = read("/api/experiments?workspace=demo").catch(() => [] as RealExperiment[]);
    Promise.all([live, demo])
      .then(([liveRead, demoExperiments]) => {
        if (cancelled) return;
        setRealError(!liveRead.ok);
        if (liveRead.ok) setReal(liveRead.experiments);
        setSeeded(demoExperiments);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [status, authFetch, revision]);
  const retryRead = () => {
    setLoaded(false);
    setRealError(false);
    setRevision((value) => value + 1);
  };
  const selectedLive = real.find((item) => item.id === selectedId && item.launch);
  const [liveResults, setLiveResults] = useState<{ id: string; value: LiveResults } | null>(null);
  useEffect(() => {
    if (status !== "authenticated" || !selectedLive) return;
    let cancelled = false;
    const id = selectedLive.id;
    authFetch(`/api/experiments/results/live?experimentId=${encodeURIComponent(id)}`)
      .then(async (response): Promise<LiveResults> => {
        const body = (await response.json().catch(() => ({}))) as {
          breakdown?: LiveAudienceBreakdown;
          analysis?: AnalysedResult | null;
          error?: { code?: string };
        };
        if (response.ok && body.breakdown)
          return { status: "available", breakdown: body.breakdown, analysis: body.analysis ?? null };
        return {
          status: "unavailable",
          message:
            body.error?.code === "capability_not_active"
              ? "Live results need every read capability verified and active for this creator."
              : "Live results could not be read right now.",
        };
      })
      .catch((): LiveResults => ({ status: "unavailable", message: "Perform could not be reached for live results." }))
      .then((value) => {
        if (!cancelled) setLiveResults({ id, value });
      });
    return () => {
      cancelled = true;
    };
  }, [status, authFetch, selectedLive, revision]);
  const currentLiveResults: LiveResults | undefined = selectedLive
    ? liveResults?.id === selectedLive.id
      ? liveResults.value
      : { status: "loading" }
    : undefined;
  const lifecycle: LifecycleAction = async (action, experiment) => {
    try {
      const response = await authFetch(`/api/experiments/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experimentId: experiment.id, workspace: experiment.workspace }),
      });
      const body = (await response.json().catch(() => ({}))) as LifecycleBody;
      if (body.result?.status === "OPEN" || body.result?.status === "REFUSED")
        return { ok: false, reasons: body.result.reasons };
      if (!response.ok || body.error) return { ok: false, reasons: [body.error?.message ?? "The request failed."] };
      setRevision((value) => value + 1);
      if (body.discarded) return { ok: true, message: "Experiment discarded." };
      if (body.result?.status === "ABANDONED") return { ok: true, message: "Launch abandoned and its lists deleted." };
      if (body.result?.status === "CLOSED")
        return { ok: true, message: "Experiment closed. Both custom lists are deleted and metrics are frozen." };
      return { ok: true, message: body.reconciliation?.note ?? "Reconciliation recorded." };
    } catch {
      return { ok: false, reasons: ["Perform could not be reached. Try again."] };
    }
  };
  return (
    <ExperimentHistory
      preview={false}
      selectedId={selectedId}
      realExperiments={real}
      seededExperiments={seeded}
      lifecycle={lifecycle}
      liveResults={currentLiveResults}
      realLoading={!(loaded || status === "idle" || status === "error")}
      realError={realError}
      onRetryReal={retryRead}
    />
  );
}

/** Experiments home and detail inside Fanvue: exchanges the launcher token, then lists the creator's real experiments. */
export function EmbeddedExperimentHistory({ selectedId }: { selectedId?: string }) {
  return (
    <AuthProvider>
      <RealHistory selectedId={selectedId} />
    </AuthProvider>
  );
}
