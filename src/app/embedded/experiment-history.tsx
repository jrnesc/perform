"use client";

import { Drama, Plus } from "lucide-react";
import Link from "next/link";
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
import { ResultComparison } from "./experiment-experience";

export const previewHistoryStorageKey = "perform:preview:experiments:v1";

function readSaved(): ExperimentRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(previewHistoryStorageKey) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
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

function percentage(value: number): string { return `${Math.round(value * 100)}%`; }
function money(minor: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100); }

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
  return summary.observedDirection.outcome === "TIED" ? "No observed difference" : `Arm ${summary.observedDirection.outcome[0]} led`;
}

const absentRelationshipNote = "No never-subscribed or lapsed fans: the subscribers list holds current subscribers only.";

export function AudienceEvidencePanel({ evidence, caveat }: { evidence: readonly AudienceMemberEvidence[]; caveat?: string | null }) {
  const [dimension, setDimension] = useState<AudienceBreakdownDimension>("PRIOR_PURCHASER");
  if (!isCurrentAudienceEvidence(evidence)) return null;
  const live = evidence[0].provenance === "REAL";
  const all = audienceSegments(evidence, dimension);
  const segments = dimension === "RELATIONSHIP" ? all.filter((segment) => segment.members.length > 0) : all;
  const absent = dimension === "RELATIONSHIP" ? all.filter((segment) => segment.members.length === 0).map((segment) => segment.label.toLowerCase()) : [];
  return <section className="audience-breakdown" aria-labelledby="audience-breakdown-title">
    <header><div><p className="eyebrow">Descriptive audience evidence · <span className={live ? "provenance-live" : "fixture-label"}>{live ? "Live Fanvue evidence" : "Seeded demo · not live"}</span></p><h3 id="audience-breakdown-title">Who converted and reversed?</h3><p>New buyer means no settled purchase before assignment; returning buyer means at least one. Subscriber relationship is frozen before assignment from subscription history and renewal status. These cohorts describe this test and do not identify subgroup winners.</p></div><div className="breakdown-controls" aria-label="Audience breakdown"><button type="button" className={dimension === "PRIOR_PURCHASER" ? "active" : ""} aria-pressed={dimension === "PRIOR_PURCHASER"} onClick={() => setDimension("PRIOR_PURCHASER")}>Prior-purchaser status</button><button type="button" className={dimension === "RELATIONSHIP" ? "active" : ""} aria-pressed={dimension === "RELATIONSHIP"} onClick={() => setDimension("RELATIONSHIP")}>Subscriber relationship</button></div></header>
    <div className="segment-grid">{segments.map((segment) => <article key={segment.key}><h4>{segment.label}</h4><p>{segment.members.length} assigned · exact denominator</p>{segment.isSmall ? <div className="segment-suppressed">Breakdown suppressed below 5 assigned members.</div> : <table><thead><tr><th scope="col">Arm</th><th scope="col">Converted</th><th scope="col">Settled revenue</th><th scope="col">Reversals</th></tr></thead><tbody>{(["A", "B"] as const).map((arm) => { const value = segment.arms[arm]; return <tr key={arm}><th scope="row">{arm}</th><td>{value.converted} / {value.assigned}</td><td>{money(value.settledRevenueMinor)}</td><td>{value.reversedPurchases}</td></tr>; })}</tbody></table>}</article>)}</div>
    {absent.length > 0 && <p className="privacy-note">{absent.length === 2 && absent.includes("never subscribed") && absent.includes("lapsed") ? absentRelationshipNote : `No members in: ${absent.join(", ")}.`}</p>}
    {caveat && <p className="result-warning">{caveat}</p>}
    <div className="evidence-table-wrap"><table className="evidence-table"><caption>Privacy-conscious member audit · stable UUIDs and experiment evidence only</caption><thead><tr><th scope="col">Fan UUID</th><th scope="col">Arm</th><th scope="col">Buyer definition</th><th scope="col">Subscriber relationship</th><th scope="col">Outcome</th><th scope="col">Settled value</th><th scope="col">Reversal</th></tr></thead><tbody>{evidence.map((row) => <tr key={row.fanUuid}><th scope="row"><code>{row.fanUuid}</code></th><td>{row.arm}</td><td>{row.priorPurchaserStatus === "PRIOR_PURCHASER" ? `Returning · ${row.priorSettledPurchaseCount} prior` : "New · 0 prior"}</td><td>{relationshipLabel(row.subscriberRelationship)}{row.resubscribedAfterLapse ? " · resubscribed" : ""}</td><td>{row.converted ? "Converted" : "No purchase"}</td><td>{money(row.settledRevenueMinor)}</td><td>{row.disputed ? "Disputed" : row.fullyRefunded ? "Fully refunded" : "None"}</td></tr>)}</tbody></table></div>
    <p className="privacy-note">No display names, handles, email addresses or profile fields are stored or shown. Segment differences are descriptive, not individual-fan causal conclusions.</p>
  </section>;
}

function ExperimentLinkedResult({ experiment }: { experiment: ExperimentRecord }) {
  const detail = experimentResultDetail(experiment, linkedResult(experiment));
  if (!detail.result) return <div className="result-empty"><h2>No evidence yet</h2><p>{experiment.state === "RUNNING" ? "This experiment is running, but no complete result snapshot is available yet." : "This experiment has no result evidence. Perform will not attach another experiment’s scenario."}</p></div>;
  const result = detail.result;
  const metric = result.fixture.variable === "COPY" ? "Purchases / assigned recipient" : "Revenue / assigned recipient";
  return <div className="linked-result">
    <div className={`result-banner ${result.confidence.supportsLearning ? "ready" : "blocked"}`}><div><p className="eyebrow">Observed result · {result.status === "LEARNING_READY" ? "evidence gate passed" : result.status.replaceAll("_", " ")}</p><h3>{result.observedDirection.statement}</h3></div></div>
    <aside className="uncertainty-note"><div><p className="eyebrow">Confidence and generalisation</p><strong>{result.confidence.label}</strong><p>{result.confidence.statement}</p>{result.confidence.nextStep && <p><strong>Next step:</strong> {result.confidence.nextStep}</p>}</div>{result.estimate && <span>{Math.round(result.estimate.probabilityArmBBetter * 100)}% estimated chance Arm B is better · {result.estimate.draws.toLocaleString()} fixed-seed draws</span>}</aside>
    <ResultComparison result={result} />
    <p className="metric-label">Primary metric · {metric}</p>
    <div className="arm-results">{(["A", "B"] as const).map((arm) => { const value = result.arms[arm]; return <article key={arm}><p className="eyebrow">Arm {arm} · {result.fixture.comparison[arm === "A" ? "armALabel" : "armBLabel"]}</p><h3>{result.fixture.variable === "COPY" ? percentage(value.primaryRate) : money(value.primaryRate)}</h3><p>{value.settledPurchases} settled purchases / {value.assignedRecipients} assigned</p><dl><div><dt>Gross revenue</dt><dd>{money(value.grossRevenueMinor)}</dd></div><div><dt>Settled revenue</dt><dd>{money(value.settledRevenueMinor)}</dd></div><div><dt>Full reversals</dt><dd>{value.reversedPurchases}</dd></div></dl></article>; })}</div>
    <AudienceEvidencePanel evidence={result.fixture.audienceEvidence ?? []} />
    <div className="result-columns"><section><h3>Evidence timeline</h3><p className="timeline-legend"><strong>Fixture provenance:</strong> Dry run is the frozen plan; Demo is versioned fictional evidence, not live data.</p><ol className="timeline">{result.fixture.evidence.map((event) => <li key={event.id}><span className={`timeline-dot ${event.source.toLowerCase()}`} aria-hidden="true" /><div><strong>{event.label}</strong><p>{event.detail}</p><time dateTime={event.occurredAt}>{formatHistoryDateTime(event.occurredAt)}</time></div></li>)}</ol></section><section><h3>Learning history</h3>{result.learning ? <ul className="learning-list"><li><p>{result.learning.statement}</p><small>{result.learning.audienceScope} · {result.learning.variable.toLowerCase()} test</small></li></ul> : <p>No learning passed the evidence and confidence gates.</p>}</section></div>
    {result.warnings.map((warning) => <p className="result-warning" key={warning}>{warning}</p>)}
  </div>;
}

export function ExperimentHistory({ preview, selectedId }: { preview: boolean; selectedId?: string }) {
  const base = preview ? "/preview" : "/embedded";
  const [saved, setSaved] = useState<ExperimentRecord[]>([]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSaved(readSaved()));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const experiments = useMemo(() => [...saved, ...DEMO_EXPERIMENT_HISTORY]
    .filter((item, index, all) => all.findIndex(({ id }) => id === item.id) === index)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), [saved]);
  const selected = selectedId ? experiments.find(({ id }) => id === selectedId) : undefined;

  return <main data-theme="light">
    <header className="masthead"><Link className="brand-lockup history-brand" href={base}><span className="brand-mark" aria-hidden="true"><Drama size={19} /></span><div><strong>Perform</strong><span>Offer experiments</span></div></Link><span className="connection"><i />{preview ? "Fixture preview" : "Creator workspace"}</span></header>
    <div className={`workspace-shell ${selectedId ? "history-shell" : "setup-shell"}`}>
      {selectedId ? selected ? <>
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href={base}>Experiments</Link><span>/</span><span>{selected.name}</span></nav>
        <header className="detail-hero"><div><p className="eyebrow">Experiment detail</p><h1>{selected.name}</h1><p className="lede">{selected.hypothesis}</p></div><span className={`status-pill state-${selected.state.toLowerCase()}`}>{stateLabel(selected.state)}</span></header>
        <nav className="detail-tabs" aria-label="Experiment sections"><a href="#overview">Overview</a><a href="#results">Results</a><a href="#audience">Audience</a></nav>
        <section id="overview" className="detail-panel"><div><p className="eyebrow">Overview</p><h2>Saved experiment definition</h2></div><dl className="detail-facts"><div><dt>Stable ID</dt><dd><code>{selected.id}</code></dd></div><div><dt>Variable</dt><dd>{selected.variable === "COPY" ? "Copy only" : "Price only"}</dd></div><div><dt>Source audience</dt><dd>{audienceLabel(selected.sourceAudienceUuid)}</dd></div><div><dt>Created</dt><dd>{formatHistoryDateTime(selected.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatHistoryDateTime(selected.updatedAt)}</dd></div><div><dt>Provenance</dt><dd>Seeded demo fixture · no live data</dd></div></dl>{linkedResult(selected) && <div className="frozen-variants"><h3>Frozen variants</h3>{linkedResult(selected)?.fixture.variants.map((variant) => <article key={variant.arm}><strong>Arm {variant.arm}</strong><p>{variant.copy}</p><span>{money(variant.priceMinor)}</span></article>)}</div>}</section>
        <section id="results" className="detail-panel result-detail-panel"><p className="eyebrow">Results</p><ExperimentLinkedResult experiment={selected} /></section>
        <section id="audience" className="detail-panel"><p className="eyebrow">Audience</p><h2>Frozen source context</h2><p>{selected.snapshotCount ? `${selected.snapshotCount} eligible fixture members were recorded for the snapshot.` : "This draft has no frozen audience snapshot yet."} Audience-level evidence remains descriptive and fixture-backed.</p></section>
      </> : <section className="empty-state history-empty"><p className="eyebrow">Not found</p><h1>That experiment is not in this workspace.</h1><p>Experiment detail fails closed when its creator or provenance-scoped record cannot be found.</p><Link className="primary button-link" href={base}>Return to experiments</Link></section> : <>
        <header className="history-hero"><div><p className="eyebrow">Experiment workspace</p><h1>Your experiments</h1><p className="lede">Create, resume and inspect named tests. Every record below is clearly fixture-backed and no Fanvue write is enabled.</p></div><Link className="primary button-link" href={`${base}/new`}><Plus size={16} />Create A/B test</Link></header>
        {experiments.length === 0 ? <section className="empty-state history-empty"><h2>No experiments yet</h2><p>Create your first named A/B test. It will appear here after it is saved.</p></section> : <section className="history-table-wrap" aria-label="Experiment history"><table className="history-table"><thead><tr><th scope="col">Experiment</th><th scope="col">Status</th><th scope="col">Result</th><th scope="col">Variable</th><th scope="col">Audience</th><th scope="col">Updated</th></tr></thead><tbody>{experiments.map((experiment) => <tr key={experiment.id}><th scope="row"><Link href={`${base}/experiments/${encodeURIComponent(experiment.id)}`}>{experiment.name}</Link><span>{experiment.hypothesis}</span></th><td><span className={`status-pill state-${experiment.state.toLowerCase()}`}>{stateLabel(experiment.state)}</span></td><td>{resultSummaryLabel(experiment)}</td><td>{experiment.variable === "COPY" ? "Copy" : "Price"}</td><td>{audienceLabel(experiment.sourceAudienceUuid)}</td><td><time dateTime={experiment.updatedAt}>{formatHistoryDate(experiment.updatedAt)}</time></td></tr>)}</tbody></table><p className="fixture-note"><span className="fixture-label">Seeded demo</span> Four fixtures cover ready, running and blocked outcomes. Newly saved preview tests appear here too.</p></section>}
      </>}
    </div>
  </main>;
}
