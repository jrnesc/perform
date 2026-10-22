"use client";

import {
  ChartColumnIncreasingIcon,
  CircleHelpIcon,
  EyeIcon,
  FileCheckIcon,
  GalleryThumbnailsIcon,
  GitBranchIcon,
  MessageSquareMoreIcon,
  RocketIcon,
  SquarePenIcon,
  UsersIcon,
} from "lucide-animated";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AnalysedResult } from "../../results/contracts";

export const setupStages = ["Audience", "Asset", "Question", "Variants", "Review"] as const;
export type SetupStage = (typeof setupStages)[number];

type AnimatedIconHandle = {
  startAnimation: () => void;
  stopAnimation: () => void;
};

const stageIcons = {
  Audience: UsersIcon,
  Asset: GalleryThumbnailsIcon,
  Question: CircleHelpIcon,
  Variants: GitBranchIcon,
  Review: FileCheckIcon,
} satisfies Record<SetupStage, typeof UsersIcon>;

export function StageIcon({ stage, decorative = false, animateOnAppear = false, continuous = false }: { stage: SetupStage; decorative?: boolean; animateOnAppear?: boolean; continuous?: boolean }) {
  const Icon = stageIcons[stage];
  const reducedMotion = useReducedMotion();
  const iconRef = useRef<AnimatedIconHandle>(null);

  useEffect(() => {
    if (continuous || !animateOnAppear || reducedMotion) return;
    const frame = window.requestAnimationFrame(() => iconRef.current?.startAnimation());
    return () => window.cancelAnimationFrame(frame);
  }, [animateOnAppear, continuous, reducedMotion, stage]);

  return (
    <div className="stage-icon" aria-hidden={decorative || undefined} aria-label={decorative ? undefined : stage} title={stage} data-animate-on-appear={animateOnAppear}>
      {continuous
        ? <LoopingIcon icon={Icon} size={18} intervalMs={3200 + setupStages.indexOf(stage) * 400} />
        : <Icon ref={iconRef} size={18} animateOnHover={!reducedMotion} />}
    </div>
  );
}

/** Icons for the review sections that follow the five setup steps. */
export function SectionIcon({ section }: { section: "preview" | "launch" }) {
  return (
    <div className="stage-icon" aria-hidden="true">
      <LoopingIcon icon={(section === "preview" ? MessageSquareMoreIcon : RocketIcon) as typeof UsersIcon} size={18} intervalMs={section === "preview" ? 3000 : 3600} />
    </div>
  );
}

export function isProgressCompact(scrollY: number, threshold = 160): boolean {
  return scrollY > threshold;
}

export function initialResultId(results: readonly AnalysedResult[]): string {
  return results[0]?.fixture.id ?? "";
}

export function resetResultsViewport(heading: HTMLHeadingElement | null): void {
  heading?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "auto" });
}

export function ProgressStrip({ current }: { current: number }) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const update = () => setCompact(isProgressCompact(window.scrollY));
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <div className="progress-slot">
      <nav className={`progress-strip ${compact ? "compact" : ""}`} aria-label="Experiment setup progress" data-compact={compact}>
        <ol>
          {setupStages.map((label, index) => {
            const state = index === current ? "current" : index < current ? "completed" : "unavailable";
            return (
              <li key={label} className={state === "current" ? "active" : state === "completed" ? "complete" : "unavailable"} aria-label={`${label}, ${state}`} aria-current={state === "current" ? "step" : undefined} title={`${label} — ${state}`}>
                <StageIcon stage={label} decorative animateOnAppear={state === "current"} />
                <span className="progress-label">{label}</span>
                <i aria-hidden="true" />
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

type MetricKey = "primary" | "settledRevenue" | "settledPurchases" | "reversals";

const metricLabels: Record<MetricKey, string> = {
  primary: "Primary outcome",
  settledRevenue: "Settled revenue",
  settledPurchases: "Settled purchases",
  reversals: "Reversals",
};

function metricValue(result: AnalysedResult, arm: "A" | "B", metric: MetricKey): number {
  const value = result.arms[arm];
  if (metric === "settledRevenue") return value.settledRevenueMinor;
  if (metric === "settledPurchases") return value.settledPurchases;
  if (metric === "reversals") return value.reversedPurchases;
  return value.primaryRate;
}

function metricUnit(result: AnalysedResult, metric: MetricKey): string {
  if (metric === "settledRevenue") return "USD";
  if (metric === "settledPurchases" || metric === "reversals") return "events";
  return result.fixture.variable === "PRICE" ? "USD per assigned recipient" : "purchases per assigned recipient";
}

function formatMetric(result: AnalysedResult, metric: MetricKey, value: number): string {
  if (metric === "settledRevenue" || (metric === "primary" && result.fixture.variable === "PRICE")) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  }
  if (metric === "primary") return value.toFixed(3);
  return String(value);
}

export function ResultComparison({ result }: { result: AnalysedResult }) {
  const [metric, setMetric] = useState<MetricKey>("primary");
  const values = (["A", "B"] as const).map((arm) => metricValue(result, arm, metric));
  const maximum = Math.max(...values, 1);
  const chartHeight = 150;
  const baseline = 210;
  const chartLabel = `${metricLabels[metric]} for Arm A and Arm B. Aggregate-only grouped bar chart. Arm A: ${formatMetric(result, metric, values[0])}. Arm B: ${formatMetric(result, metric, values[1])}.`;

  return (
    <section className="comparison-panel" aria-labelledby="comparison-title">
      <header><div><p className="eyebrow">Aggregate comparison</p><h3 id="comparison-title">Arm A and Arm B together</h3><p>No temporal buckets exist in this evidence, so these bars compare honest experiment totals.</p></div><div className="chart-legend" aria-label="Chart legend"><span><i className="arm-a" />Arm A</span><span><i className="arm-b" />Arm B</span></div></header>
      <div className="metric-switcher" role="radiogroup" aria-label="Comparison metric">
        {(Object.keys(metricLabels) as MetricKey[]).map((key) => <button type="button" role="radio" aria-checked={metric === key} className={metric === key ? "active" : ""} key={key} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}
      </div>
      <p className="chart-unit">Unit · {metricUnit(result, metric)}</p>
      <svg className="comparison-chart" viewBox="0 0 640 250" role="img" aria-label={chartLabel}>
        {[0, 0.25, 0.5, 0.75, 1].map((portion) => {
          const y = baseline - chartHeight * portion;
          return <g key={portion}><line x1="72" x2="610" y1={y} y2={y} className="chart-grid" /><text x="62" y={y + 4} textAnchor="end">{formatMetric(result, metric, maximum * portion)}</text></g>;
        })}
        {values.map((value, index) => {
          const height = value === 0 ? 2 : (value / maximum) * chartHeight;
          const x = index === 0 ? 205 : 385;
          return <g key={index}><rect x={x} y={baseline - height} width="70" height={height} rx="5" className={index === 0 ? "bar-a" : "bar-b"} /><text x={x + 35} y={baseline - height - 10} textAnchor="middle" className="bar-value">{formatMetric(result, metric, value)}</text><text x={x + 35} y="235" textAnchor="middle" className="bar-label">Arm {index === 0 ? "A" : "B"}</text></g>;
        })}
      </svg>
      <div className="comparison-table-wrap"><table><caption>Exact aggregate values and assigned-recipient denominators</caption><thead><tr><th>Arm</th><th>{metricLabels[metric]}</th><th>Assigned recipients</th></tr></thead><tbody>{(["A", "B"] as const).map((arm) => <tr key={arm}><th>Arm {arm}</th><td>{formatMetric(result, metric, metricValue(result, arm, metric))} <span>{metricUnit(result, metric)}</span></td><td>{result.arms[arm].assignedRecipients}</td></tr>)}</tbody></table></div>
    </section>
  );
}

/** Restarts an icon's one-shot animation on a short interval so it keeps moving. */
function LoopingIcon({ icon: Icon, size, intervalMs }: { icon: typeof UsersIcon; size: number; intervalMs: number }) {
  const reducedMotion = useReducedMotion();
  const iconRef = useRef<AnimatedIconHandle>(null);
  useEffect(() => {
    if (reducedMotion) return;
    let frame = 0;
    const play = () => {
      iconRef.current?.stopAnimation();
      frame = window.requestAnimationFrame(() => iconRef.current?.startAnimation());
    };
    play();
    const timer = window.setInterval(play, intervalMs);
    return () => { window.clearInterval(timer); window.cancelAnimationFrame(frame); };
  }, [reducedMotion, intervalMs]);
  return <Icon ref={iconRef} size={size} animateOnHover={false} aria-hidden="true" />;
}

export function WritingPenIcon({ size = 26 }: { size?: number }) {
  return <LoopingIcon icon={SquarePenIcon as typeof UsersIcon} size={size} intervalMs={1600} />;
}

export function WatchfulEyeIcon({ size = 20 }: { size?: number }) {
  return <LoopingIcon icon={EyeIcon as typeof UsersIcon} size={size} intervalMs={2400} />;
}

export function ScenarioIcon() {
  const reducedMotion = useReducedMotion();
  return <ChartColumnIncreasingIcon size={15} animateOnHover={!reducedMotion} aria-hidden="true" />;
}

export function ScenarioHeading() {
  return <div className="eyebrow sidebar-heading"><ScenarioIcon /><span>Scenarios</span></div>;
}
