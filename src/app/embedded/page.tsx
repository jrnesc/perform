"use client";

import { AuthProvider, useAuth, useEmbeddedAuth } from "@fanvue/builder-sdk/react";
import { Drama } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExperimentVariable, VariantDefinition } from "../../domain/experiment-state";
import {
  defaultObservationDays,
  maxObservationDays,
  minObservationDays,
  observationEndFor,
  observationWindowProblem,
} from "../../domain/observation-window";
import type { AudienceSnapshot, DryRunPlan, ExperimentReview } from "../../experiments/contracts";
import type { MediaAsset, MediaPage, WorkspaceKind } from "../../workspace/contracts";
import { ProgressStrip, SectionIcon, StageIcon, WatchfulEyeIcon, WritingPenIcon } from "./experiment-experience";
import { EmbeddedExperimentHistory, ExperimentHistory, previewHistoryStorageKey } from "./experiment-history";

type WorkspaceResponse = {
  workspace: WorkspaceKind;
  creator: { uuid: string; displayName: string };
  capabilities: { demoAvailable: boolean };
  page: MediaPage;
};
type AudienceResponse = {
  workspace: "demo";
  capabilities: { demoAvailable: boolean };
  audiences: AudienceSnapshot[];
};
type PersistedDryRunResponse = {
  review: ExperimentReview;
  plan: DryRunPlan;
  persistence: { database: "demo" | "preview"; state: "ALLOCATED"; saved: true };
};
type LaunchResponse = {
  provenance: "DEMO" | "REAL";
  externalRequests?: number;
  result: { status: "RUNNING" | "OPERATOR_REVIEW" | "RETRYABLE" | "INVALID"; scheduledAt: string; reason?: string };
};
type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; code: string; message: string; demoAvailable: boolean };

const steps = ["Audience", "Asset", "Question", "Variants", "Review"] as const;

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

function AssetMark({ type }: { type: MediaAsset["mediaType"] }) {
  return <span className="asset-mark" aria-hidden="true">{type.slice(0, 1).toUpperCase()}</span>;
}

function BroadcastPreview({ variant, asset, recipients }: { variant: VariantDefinition; asset: MediaAsset; recipients: number }) {
  return <article className="broadcast-preview">
    <header><div><span className="broadcast-avatar" aria-hidden="true">P</span><div><strong>Perform broadcast</strong><small>Mass message preview</small></div></div></header>
    <div className="broadcast-media" style={asset.thumbnailUrl ? { backgroundImage: `url(${asset.thumbnailUrl})` } : undefined}>{!asset.thumbnailUrl && <AssetMark type={asset.mediaType} />}</div>
    <div className="broadcast-body"><p>{variant.copy}</p><span className="broadcast-unlock">Unlock for {money(variant.priceMinor)}</span><small>{recipients} assigned recipients</small></div>
  </article>;
}

async function responseBody<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & {
    error?: { code: string; message: string };
    capabilities?: { demoAvailable: boolean };
  };
  if (!response.ok || body.error) {
    throw Object.assign(new Error(body.error?.message ?? "This workspace is unavailable."), {
      code: body.error?.code ?? "unavailable",
      demoAvailable: body.capabilities?.demoAvailable ?? false,
      status: response.status,
    });
  }
  return body;
}

export function PerformWorkspace({ preview = false }: { preview?: boolean }) {
  const router = useRouter();
  const embeddedAuth = useEmbeddedAuth();
  const { authFetch: fanvueAuthFetch, clearJwt } = useAuth();
  const status = preview ? "authenticated" as const : embeddedAuth.status;
  const error = embeddedAuth.error;
  const theme = embeddedAuth.theme;
  const authFetch = useCallback((url: string, init?: RequestInit) => {
    if (!preview) return fanvueAuthFetch(url, init);
    const resource = url.startsWith("/api/workspace/media")
      ? "media"
      : url.startsWith("/api/workspace/audiences")
        ? "audiences"
        : url.startsWith("/api/experiments/dry-run")
          ? "dry-run"
          : "dry-run";
    return fetch(`/api/preview/${resource}`, init);
  }, [fanvueAuthFetch, preview]);
  const [workspace, setWorkspace] = useState<WorkspaceKind>(preview ? "demo" : "real");
  const [experimentId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [media, setMedia] = useState<LoadState<WorkspaceResponse>>({ kind: "loading" });
  const [audiences, setAudiences] = useState<LoadState<AudienceResponse>>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [step, setStep] = useState(0);
  const [audienceId, setAudienceId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [variable, setVariable] = useState<ExperimentVariable>("COPY");
  const [hypothesis, setHypothesis] = useState("Specific preview copy will increase purchases.");
  const [copyA, setCopyA] = useState("A new set is ready for you.");
  const [copyB, setCopyB] = useState("See 12 new afterglow portraits from this week’s shoot.");
  const [priceA, setPriceA] = useState(1200);
  const [priceB, setPriceB] = useState(1500);
  const [review, setReview] = useState<ExperimentReview | null>(null);
  const [plan, setPlan] = useState<DryRunPlan | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [validation, setValidation] = useState("");
  const [advancing, setAdvancing] = useState(false);
  const [launchConfirmed, setLaunchConfirmed] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(() => {
    // datetime-local expects the user's local wall-clock time, not UTC.
    const date = new Date(Date.now() + 10 * 60_000);
    date.setSeconds(0, 0);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });
  const [observationDays, setObservationDays] = useState(String(defaultObservationDays));
  const [launch, setLaunch] = useState<LaunchResponse | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    const heading = stepHeading.current;
    heading?.focus({ preventScroll: true });
    if (step > 0) {
      const stage = heading?.closest<HTMLElement>(".flow-stage");
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      stage?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    }
  }, [status, step]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;

    const recoverOrSet = <T,>(caught: unknown, setter: (value: LoadState<T>) => void) => {
      if (cancelled) return;
      const issue = caught as Error & { code?: string; demoAvailable?: boolean; status?: number };
      const launchToken = new URL(window.location.href).searchParams.get("token");
      const recoveryKey = "perform:last-stale-session-token";
      if (issue.status === 401 && launchToken && sessionStorage.getItem(recoveryKey) !== launchToken) {
        sessionStorage.setItem(recoveryKey, launchToken);
        clearJwt();
        window.location.reload();
        return;
      }
      setter({
        kind: "error",
        code: issue.code ?? "network_error",
        message: issue.message || "Perform could not reach its server.",
        demoAvailable: issue.demoAvailable ?? false,
      });
    };

    authFetch(`/api/workspace/media?workspace=${workspace}&page=1`)
      .then((response) => responseBody<WorkspaceResponse>(response))
      .then((data) => { if (!cancelled) setMedia({ kind: "ready", data }); })
      .catch((caught) => recoverOrSet(caught, setMedia));
    authFetch(`/api/workspace/audiences?workspace=${workspace}`)
      .then((response) => responseBody<AudienceResponse>(response))
      .then((data) => { if (!cancelled) setAudiences({ kind: "ready", data }); })
      .catch((caught) => recoverOrSet(caught, setAudiences));
    return () => { cancelled = true; };
  }, [authFetch, clearJwt, reload, status, workspace]);

  const demoAvailable = media.kind === "ready"
    ? media.data.capabilities.demoAvailable
    : media.kind === "error" && media.demoAvailable;
  const selectedAudience = audiences.kind === "ready"
    ? audiences.data.audiences.find((item) => item.id === audienceId) ?? null
    : null;
  const selectedAsset = media.kind === "ready"
    ? media.data.page.items.find((item) => item.id === assetId) ?? null
    : null;
  const variants = useMemo<readonly VariantDefinition[]>(() => {
    const mediaUuid = selectedAsset?.id ?? "";
    if (variable === "COPY") {
      return [
        { arm: "A", copy: copyA, priceMinor: priceA, currency: "USD", mediaUuid },
        { arm: "B", copy: copyB, priceMinor: priceA, currency: "USD", mediaUuid },
      ];
    }
    return [
      { arm: "A", copy: copyA, priceMinor: priceA, currency: "USD", mediaUuid },
      { arm: "B", copy: copyA, priceMinor: priceB, currency: "USD", mediaUuid },
    ];
  }, [copyA, copyB, priceA, priceB, selectedAsset, variable]);

  const chooseWorkspace = (next: WorkspaceKind) => {
    setMedia({ kind: "loading" });
    setAudiences({ kind: "loading" });
    setWorkspace(next);
    setStep(0);
    setAudienceId("");
    setAssetId("");
    setReview(null);
    setPlan(null);
    setPersisted(false);
    setValidation("");
    setLaunch(null);
  };

  const retry = () => {
    setMedia({ kind: "loading" });
    setAudiences({ kind: "loading" });
    setReload((value) => value + 1);
  };

  const observationEndLabel = useMemo(() => {
    const deliveryMs = new Date(scheduledAt).getTime();
    if (!Number.isFinite(deliveryMs)) return null;
    const deliveryAt = new Date(deliveryMs).toISOString();
    const endsAt = observationEndFor(deliveryAt, Number(observationDays));
    if (observationWindowProblem(deliveryAt, endsAt)) return null;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(endsAt));
  }, [scheduledAt, observationDays]);

  const canContinue = Boolean(name.trim()) &&
    (step !== 0 || Boolean(selectedAudience)) &&
    (step !== 1 || Boolean(selectedAsset)) &&
    (step !== 2 || Boolean(hypothesis.trim())) &&
    (step !== 4 || preview || launchConfirmed);

  const continueSetup = async () => {
    setValidation("");
    if (step === 0 && !name.trim()) return setValidation("Name this experiment before choosing its audience.");
    if (step === 0 && !selectedAudience) return setValidation("Choose one source audience to continue.");
    if (step === 1 && !selectedAsset) return setValidation("Choose one ready Vault asset to continue.");
    if (step === 2 && !hypothesis.trim()) return setValidation("Write a hypothesis before defining variants.");
    if (step === 3) {
      if (!selectedAudience || !selectedAsset) return setValidation("Audience and asset are required.");
      try {
        setAdvancing(true);
        const response = await authFetch(workspace === "real" && !preview ? "/api/experiments/prepare" : "/api/experiments/dry-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: experimentId,
            name,
            audienceId: selectedAudience.id,
            assetId: selectedAsset.id,
            variable,
            hypothesis,
            variants,
          }),
        });
        const body = await response.json() as PersistedDryRunResponse & { error?: { message: string } };
        if (!response.ok || body.error) throw new Error(body.error?.message ?? "The review could not be saved.");
        setReview(body.review);
        setPlan(body.plan);
        setPersisted(body.persistence.saved);
        if (preview) {
          const now = new Date().toISOString();
          const record = {
            id: body.review.experimentId,
            name: body.review.draft.name.trim(),
            creatorUuid: "preview:creator",
            dataProvenance: "DEMO",
            state: "ALLOCATED",
            variable: body.review.draft.variable,
            hypothesis: body.review.draft.hypothesis,
            sourceAudienceUuid: body.review.draft.audience.id,
            snapshotHash: body.review.snapshotHash,
            snapshotCount: body.review.eligibleCount,
            allocationAlgorithm: body.review.assignments[0]?.algorithmVersion,
            snapshotAt: body.review.draft.audience.capturedAt,
            createdAt: now,
            updatedAt: now,
          };
          const saved = JSON.parse(localStorage.getItem(previewHistoryStorageKey) ?? "[]") as typeof record[];
          localStorage.setItem(previewHistoryStorageKey, JSON.stringify([record, ...saved.filter(({ id }) => id !== record.id)]));
        }
      } catch (caught) {
        return setValidation(caught instanceof Error ? caught.message : "The variants could not be saved.");
      } finally {
        setAdvancing(false);
      }
    }
    if (step === 4) {
      if (!review || !plan || !persisted) return setValidation("The experiment review is still being prepared.");
      if (preview) {
        router.push(`/preview/experiments/${encodeURIComponent(review.experimentId)}`);
        return;
      }
      if (!launchConfirmed) return setValidation("Confirm that both paid messages and their exact effects are correct.");
      const deliveryMs = new Date(scheduledAt).getTime();
      if (!Number.isFinite(deliveryMs) || deliveryMs < Date.now() + 3 * 60_000) {
        return setValidation("Choose a delivery time at least 3 minutes from now so both arms can be set up first.");
      }
      const deliveryAt = new Date(deliveryMs).toISOString();
      const observationEndsAt = observationEndFor(deliveryAt, Number(observationDays));
      const windowProblem = observationWindowProblem(deliveryAt, observationEndsAt);
      if (windowProblem) return setValidation(`${windowProblem}.`);
      try {
        setAdvancing(true);
        const response = await authFetch("/api/experiments/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            experimentId: review.experimentId,
            workspace,
            scheduledAt: deliveryAt,
            observationEndsAt,
            confirmed: true,
          }),
        });
        const body = await responseBody<LaunchResponse>(response);
        setLaunch(body);
      } catch (caught) {
        setValidation(caught instanceof Error ? caught.message : "The launch could not continue.");
      } finally {
        setAdvancing(false);
      }
      return;
    }
    setStep((value) => Math.min(value + 1, steps.length - 1));
  };

  return (
    <main data-theme={theme ?? "light"}>
      <header className="masthead">
        <Link className="brand-lockup history-brand" href={preview ? "/preview" : "/embedded"}><span className="brand-mark" aria-hidden="true"><Drama size={19} strokeWidth={2.2} /></span><div><strong>Perform</strong><span>Offer experiments</span></div></Link>
        {status === "authenticated" && <span className="connection"><i /> {preview ? "Local preview" : "Connected to Fanvue"}</span>}
      </header>

      {status === "idle" && <section className="center-state"><p className="eyebrow">Creator connection</p><h1>Open Perform from Fanvue.</h1><p>This workspace verifies your creator session before it reads any account data.</p></section>}
      {status === "exchanging" && <section className="center-state" aria-live="polite"><span className="spinner" /><h1>Connecting your workspace…</h1><p>Verifying the one-time Fanvue session securely.</p></section>}
      {status === "error" && <section className="center-state error-state"><p className="eyebrow">Connection needed</p><h1>We couldn’t connect to Fanvue.</h1><p>{error === "consent_required" ? "Approve Perform in Fanvue, then reopen the app." : "Reopen Perform from Fanvue to receive a fresh session."}</p></section>}

      {status === "authenticated" && <div className="workspace-shell setup-shell">
        <section className="hero compact-hero">
          <div><nav className="breadcrumbs" aria-label="Breadcrumb"><Link href={preview ? "/preview" : "/embedded"}>Experiments</Link><span>/</span><span>New experiment</span></nav><h1 className="title-edit"><label className="sr-only" htmlFor="experiment-name">Experiment name</label><input id="experiment-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Name your experiment" autoComplete="off" /><WritingPenIcon /></h1><p className={`title-hint ${name.trim() ? "done" : ""}`}>{name.trim() ? "Click the title any time to rename." : "Click the title to name this experiment — required to continue."}</p><p className="lede">Build a fair A/B test, review every effect, then deliberately schedule both arms together.</p></div>
          {demoAvailable && !preview && <div className="workspace-switch" role="group" aria-label="Data workspace"><button aria-pressed={workspace === "real"} className={workspace === "real" ? "active" : ""} onClick={() => chooseWorkspace("real")}>Live</button><button aria-pressed={workspace === "demo"} className={workspace === "demo" ? "active" : ""} onClick={() => chooseWorkspace("demo")}>Seeded demo</button></div>}
        </section>

        <ProgressStrip current={step} />

        <section className="setup-flow">
          {step >= 0 && <section className="flow-stage" aria-labelledby="stage-audience">
            <div className="flow-stage-heading"><div><StageIcon stage="Audience" decorative continuous /><h2 id="stage-audience" ref={step === 0 ? stepHeading : undefined} tabIndex={-1}>Audience</h2></div></div>
            {audiences.kind === "loading" && <div className="loading-lines" role="status" aria-busy="true"><span className="sr-only">Loading audience options</span><i /><i /><i /></div>}
            {audiences.kind === "error" && <div className="empty-state compact-empty"><h3>{audiences.code === "live_audience_deferred" ? "Live audience setup is deliberately unavailable" : "Audience data is unavailable"}</h3><p>{audiences.message}</p>{audiences.demoAvailable && workspace === "real" && <button className="primary" onClick={() => chooseWorkspace("demo")}>Use seeded demo audience</button>}{workspace === "demo" && <button className="secondary" onClick={retry}>Try again</button>}</div>}
            {audiences.kind === "ready" && audiences.data.audiences.length === 0 && <div className="empty-state compact-empty"><h3>No eligible audiences</h3><p>There is nothing safe to allocate in this workspace.</p></div>}
            {audiences.kind === "ready" && <div className="choice-grid">{audiences.data.audiences.map((audience) => {
              const excluded = audience.exclusions.reduce((total, item) => total + item.count, 0);
              return <button aria-pressed={audienceId === audience.id} className={`choice-card ${audienceId === audience.id ? "selected" : ""}`} key={audience.id} onClick={() => setAudienceId(audience.id)}><span className="choice-check" aria-hidden="true">{audienceId === audience.id ? "✓" : ""}</span><strong>{audience.name}</strong><p>{audience.description}</p><small>{audience.provenance.kind === "FANVUE" ? "Members frozen at review" : `${audience.members.length} eligible · ${excluded} excluded`} ·{audience.provenance.kind === "DEMO_SEEDED" ? audience.provenance.fixtureVersion : audience.provenance.label}</small></button>;
            })}</div>}
          </section>}

          {step >= 1 && <section className="flow-stage" aria-labelledby="stage-asset">
            <div className="flow-stage-heading"><div><StageIcon stage="Asset" decorative continuous /><h2 id="stage-asset" ref={step === 1 ? stepHeading : undefined} tabIndex={-1}>Asset</h2></div></div>
            {media.kind === "loading" && <div className="asset-grid" role="status" aria-busy="true"><span className="sr-only">Loading Vault assets</span>{Array.from({ length: 3 }, (_, index) => <div className="asset-card skeleton" aria-hidden="true" key={index} />)}</div>}
            {media.kind === "error" && <div className="empty-state compact-empty"><h3>Vault assets are unavailable</h3><p>{media.message}</p><button className="secondary" onClick={retry}>Try again</button></div>}
            {media.kind === "ready" && media.data.page.items.length === 0 && <div className="empty-state compact-empty"><AssetMark type="image" /><h3>No ready Vault assets</h3><p>Upload media in Fanvue, or use the authorised demo workspace.</p>{media.data.capabilities.demoAvailable && <button className="primary" onClick={() => chooseWorkspace("demo")}>Use seeded demo assets</button>}</div>}
            {media.kind === "ready" && <div className="asset-grid">{media.data.page.items.map((asset) => <button aria-pressed={assetId === asset.id} className={`asset-card selectable ${assetId === asset.id ? "selected" : ""}`} key={asset.id} onClick={() => setAssetId(asset.id)}><div className="asset-preview" style={asset.thumbnailUrl ? { backgroundImage: `url(${asset.thumbnailUrl})` } : undefined}>{!asset.thumbnailUrl && <AssetMark type={asset.mediaType} />}<span>{asset.status}</span></div><div className="asset-copy"><p>{asset.mediaType}</p><h3>{asset.name}</h3></div></button>)}</div>}
          </section>}

          {step >= 2 && <section className="flow-stage" aria-labelledby="stage-question">
            <div className="flow-stage-heading"><div><StageIcon stage="Question" decorative continuous /><h2 id="stage-question" ref={step === 2 ? stepHeading : undefined} tabIndex={-1}>Question</h2></div></div>
            <div className="form-stack">
              <fieldset><legend>What should change?</legend><label className="radio-card"><input type="radio" checked={variable === "COPY"} onChange={() => setVariable("COPY")} /><span><strong>Copy only</strong><small>Primary metric: purchases per assigned recipient</small></span></label><label className="radio-card"><input type="radio" checked={variable === "PRICE"} onChange={() => setVariable("PRICE")} /><span><strong>Price only</strong><small>Primary metric: revenue per assigned recipient</small></span></label></fieldset>
              <label className="field"><span>Hypothesis</span><textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} maxLength={280} /><small>Describe what you expect and why. This does not affect allocation.</small></label>
            </div>
          </section>}

          {step >= 3 && <section className="flow-stage" aria-labelledby="stage-variants">
            <div className="flow-stage-heading"><div><StageIcon stage="Variants" decorative continuous /><h2 id="stage-variants" ref={step === 3 ? stepHeading : undefined} tabIndex={-1}>Variants</h2></div></div>
            <div className="variant-grid">
              <article className="variant-card"><p className="eyebrow">Arm A · Control</p><label className="field"><span>Message copy</span><textarea value={copyA} onChange={(event) => setCopyA(event.target.value)} maxLength={5000} /></label><label className="field"><span>Price</span><span className="price-field"><span aria-hidden="true">$</span><input aria-label="Arm A price in US dollars" type="number" min={3} step="0.01" value={priceA / 100} onChange={(event) => setPriceA(Math.round(Number(event.target.value) * 100))} /></span></label></article>
              <article className="variant-card"><p className="eyebrow">Arm B · Variant</p><label className="field"><span>Message copy</span><textarea value={variable === "PRICE" ? copyA : copyB} onChange={(event) => setCopyB(event.target.value)} maxLength={5000} disabled={variable === "PRICE"} /></label><label className="field"><span>Price</span><span className="price-field"><span aria-hidden="true">$</span><input aria-label="Arm B price in US dollars" type="number" min={3} step="0.01" value={(variable === "COPY" ? priceA : priceB) / 100} onChange={(event) => setPriceB(Math.round(Number(event.target.value) * 100))} disabled={variable === "COPY"} /></span></label></article>
            </div>
          </section>}

          {step >= 4 && review && plan && <section className="flow-stage" aria-labelledby="stage-review">
            <div className="flow-stage-heading"><div><StageIcon stage="Review" decorative continuous /><h2 id="stage-review" ref={step === 4 ? stepHeading : undefined} tabIndex={-1}>Review</h2></div></div>
            <div className="review-grid">
              <article className="signature-diff"><p className="eyebrow">Exact difference · one field</p><h3>{review.exactDifference.label}</h3><div><span>A</span><p>{review.exactDifference.armA}</p></div><div><span>B</span><p>{review.exactDifference.armB}</p></div></article>
              <div className="stat-grid"><article><strong>{review.armCounts.A}</strong><span>Arm A</span></article><article><strong>{review.armCounts.B}</strong><span>Arm B</span></article><article><strong>{review.overlapCount}</strong><span>Overlap</span></article><article><strong>{review.excludedCount}</strong><span>Excluded</span></article></div>
              <dl className="review-list"><div><dt>Audience</dt><dd>{review.draft.audience.name}</dd></div><div><dt>Asset</dt><dd>{review.draft.asset.name}</dd></div><div><dt>Price</dt><dd>{review.draft.variants.map((variant) => `Arm ${variant.arm} ${money(variant.priceMinor)}`).join(" · ")}</dd></div><div><dt>Metric</dt><dd>{variable === "COPY" ? "Purchases / assigned recipient" : "Revenue / assigned recipient"}</dd></div><div><dt>Snapshot</dt><dd><code>{review.snapshotHash.slice(0, 20)}…</code></dd></div><div><dt>Allocator</dt><dd>{review.assignments[0]?.algorithmVersion}</dd></div><div><dt>Persistence</dt><dd>{persisted ? preview ? "Preview memory only" : "Saved · isolated demo D1" : "Preparing…"}</dd></div></dl>
            </div>
            <section className="broadcast-review" aria-labelledby="broadcast-review-title">
              <div className="section-head"><div className="flow-stage-heading"><div><SectionIcon section="preview" /><h2 id="broadcast-review-title">What each audience will receive</h2></div></div><p>Compare the two mass messages exactly as recipients would see them.</p></div>
              <div className="broadcast-grid">{(["A", "B"] as const).map((arm) => {
                const variant = review.draft.variants.find((item) => item.arm === arm);
                return variant ? <figure className="broadcast-arm" key={arm}><figcaption>Arm {arm}</figcaption><BroadcastPreview variant={variant} asset={review.draft.asset} recipients={review.armCounts[arm]} /></figure> : null;
              })}</div>
            </section>
            {!preview && <section className="launch-confirmation" aria-labelledby="launch-confirmation-title">
              <div className="section-head"><div className="flow-stage-heading"><div><SectionIcon section="launch" /><h2 id="launch-confirmation-title">Schedule both arms together</h2></div></div><p>Perform will create one frozen custom list per arm, add members in batches of up to 100, verify exact membership, then schedule both paid mass messages.</p></div>
              <label className="field schedule-field"><span>Scheduled delivery</span><small>Both messages are delivered at this time, in your local time zone. You can cancel until then.</small><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label>
              <label className="field schedule-field"><span>Observation window</span><small>Days after delivery that purchases count. You can close the experiment once it ends{observationEndLabel ? `: ${observationEndLabel}` : ""}.</small><input type="number" inputMode="numeric" min={minObservationDays} max={maxObservationDays} step={1} value={observationDays} disabled={Boolean(launch)} onChange={(event) => setObservationDays(event.target.value)} /></label>
              <dl className="launch-effects"><div><dt>Lists</dt><dd>2 custom lists · {review.armCounts.A} in A · {review.armCounts.B} in B</dd></div><div><dt>Member batches</dt><dd>{plan.summary.memberBatches}, each no larger than 100</dd></div><div><dt>Messages</dt><dd>2 scheduled paid mass messages · same delivery time</dd></div><div><dt>Observation</dt><dd>{observationDays} {observationDays === "1" ? "day" : "days"} after delivery{observationEndLabel ? ` · ends ${observationEndLabel}` : ""}</dd></div><div><dt>Media</dt><dd>{review.draft.asset.name}</dd></div></dl>
              <p className="charge-warning"><WatchfulEyeIcon />Fans who unlock either message will be charged the displayed price.</p>
              {launch && <div className={`launch-outcome ${launch.result.status === "RUNNING" ? "success" : "warning"}`} role="status"><strong>{launch.result.status === "RUNNING" ? "Both messages are scheduled." : "Launch needs attention."}</strong><p>{launch.provenance === "DEMO" ? "Seeded demo: the full flow was recorded with zero Fanvue calls." : `REAL launch · ${launch.result.status.toLowerCase().replaceAll("_", " ")}`}{launch.result.reason ? ` ${launch.result.reason}` : ""}</p>{launch.result.status === "RUNNING" && <button type="button" className="secondary" onClick={async () => {
                try {
                  setAdvancing(true);
                  await responseBody(await authFetch("/api/experiments/launch", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experimentId: review.experimentId, workspace }) }));
                  setLaunch(null);
                  setValidation("Scheduled delivery cancelled and custom lists removed.");
                } catch (caught) { setValidation(caught instanceof Error ? caught.message : "Cancellation failed."); }
                finally { setAdvancing(false); }
              }}>Cancel before delivery</button>}</div>}
            </section>}
          </section>}

          <footer className="setup-actions">
            <div className="action-notice" aria-live="polite">
              {step === 4 && !preview && <label className={`confirm-box-field ${launchConfirmed ? "checked" : ""}`}><input type="checkbox" checked={launchConfirmed} disabled={Boolean(launch)} onChange={(event) => setLaunchConfirmed(event.target.checked)} /><span className="confirm-check" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-6.5" /></svg></span><span>I confirm the recipients, copy, media, prices and scheduled time shown above.</span></label>}
              {validation
                ? <p className="validation" role="alert">{validation}</p>
                : null}
            </div>
            <button className="primary" disabled={advancing || Boolean(launch) || !canContinue} aria-busy={advancing} onClick={continueSetup}>{advancing ? "Working…" : step === 4 ? preview ? "Open experiment" : "Confirm and schedule" : "Continue"}</button>
          </footer>
        </section>
      </div>}
    </main>
  );
}

let staleSessionChecked = false;

/**
 * A fresh `?token=` from the Fanvue launcher must win over a session stored by an earlier visit.
 * Only the first render of a page load may look: during client-side navigation the address bar
 * still shows the previous URL, and discarding then would wipe the session just created.
 */
function discardStaleSession() {
  if (typeof window === "undefined" || staleSessionChecked) return true;
  staleSessionChecked = true;
  try {
    if (new URL(window.location.href).searchParams.get("token")) window.sessionStorage.removeItem("fanvue:jwt");
  } catch { /* storage unavailable: nothing to discard */ }
  return true;
}

export default function EmbeddedPage({ preview = false, screen = "history" }: { preview?: boolean; screen?: "history" | "setup" }) {
  useState(discardStaleSession);
  if (screen === "history") return preview ? <ExperimentHistory preview /> : <EmbeddedExperimentHistory />;
  return <AuthProvider><PerformWorkspace preview={preview} /></AuthProvider>;
}
