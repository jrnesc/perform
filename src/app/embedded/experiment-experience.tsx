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
import styles from "./experiment-experience.module.css";

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

export function StageIcon({
  stage,
  decorative = false,
  animateOnAppear = false,
  continuous = false,
}: {
  stage: SetupStage;
  decorative?: boolean;
  animateOnAppear?: boolean;
  continuous?: boolean;
}) {
  const Icon = stageIcons[stage];
  const reducedMotion = useReducedMotion();
  const iconRef = useRef<AnimatedIconHandle>(null);

  useEffect(() => {
    if (continuous || !animateOnAppear || reducedMotion) return;
    const frame = window.requestAnimationFrame(() => iconRef.current?.startAnimation());
    return () => window.cancelAnimationFrame(frame);
  }, [animateOnAppear, continuous, reducedMotion, stage]);

  return (
    <div
      className={styles.stageIcon}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : stage}
      title={stage}
      data-animate-on-appear={animateOnAppear}
    >
      {continuous ? (
        <LoopingIcon icon={Icon} size={18} intervalMs={3200 + setupStages.indexOf(stage) * 400} />
      ) : (
        <Icon ref={iconRef} size={18} animateOnHover={!reducedMotion} />
      )}
    </div>
  );
}

/** Icons for the review sections that follow the five setup steps. */
export function SectionIcon({ section }: { section: "preview" | "launch" }) {
  return (
    <div className={styles.stageIcon} aria-hidden="true">
      <LoopingIcon
        icon={(section === "preview" ? MessageSquareMoreIcon : RocketIcon) as typeof UsersIcon}
        size={18}
        intervalMs={section === "preview" ? 3000 : 3600}
      />
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
    <div className={styles.progressSlot}>
      <nav
        className={`${styles.progressStrip} ${compact ? styles.compact : ""}`}
        aria-label="Experiment setup progress"
        data-compact={compact}
      >
        <ol>
          {setupStages.map((label, index) => {
            const state = index === current ? "current" : index < current ? "completed" : "unavailable";
            return (
              <li
                key={label}
                className={
                  state === "current" ? "active" : state === "completed" ? styles.complete : styles.unavailable
                }
                aria-label={`${label}, ${state}`}
                aria-current={state === "current" ? "step" : undefined}
                title={`${label} — ${state}`}
              >
                <StageIcon stage={label} decorative animateOnAppear={state === "current"} />
                <span className={styles.progressLabel}>{label}</span>
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
    <section className={styles.comparisonPanel} aria-labelledby="comparison-title">
      <header>
        <div>
          <p className="eyebrow">Aggregate comparison</p>
          <h3 id="comparison-title">Arm A and Arm B together</h3>
          <p>No temporal buckets exist in this evidence, so these bars compare honest experiment totals.</p>
        </div>
        <div className={styles.chartLegend} aria-label="Chart legend">
          <span>
            <i className={styles.armA} />
            Arm A
          </span>
          <span>
            <i className={styles.armB} />
            Arm B
          </span>
        </div>
      </header>
      <div className={styles.metricSwitcher} role="radiogroup" aria-label="Comparison metric">
        {(Object.keys(metricLabels) as MetricKey[]).map((key) => (
          <button
            type="button"
            role="radio"
            aria-checked={metric === key}
            className={metric === key ? "active" : ""}
            key={key}
            onClick={() => setMetric(key)}
          >
            {metricLabels[key]}
          </button>
        ))}
      </div>
      <p className={styles.chartUnit}>Unit · {metricUnit(result, metric)}</p>
      <svg className={styles.comparisonChart} viewBox="0 0 640 250" role="img" aria-label={chartLabel}>
        {[0, 0.25, 0.5, 0.75, 1].map((portion) => {
          const y = baseline - chartHeight * portion;
          return (
            <g key={portion}>
              <line x1="72" x2="610" y1={y} y2={y} className={styles.chartGrid} />
              <text x="62" y={y + 4} textAnchor="end">
                {formatMetric(result, metric, maximum * portion)}
              </text>
            </g>
          );
        })}
        {values.map((value, index) => {
          const height = value === 0 ? 2 : (value / maximum) * chartHeight;
          const x = index === 0 ? 205 : 385;
          return (
            <g key={index}>
              <rect
                x={x}
                y={baseline - height}
                width="70"
                height={height}
                rx="5"
                className={index === 0 ? styles.barA : styles.barB}
              />
              <text x={x + 35} y={baseline - height - 10} textAnchor="middle" className={styles.barValue}>
                {formatMetric(result, metric, value)}
              </text>
              <text x={x + 35} y="235" textAnchor="middle" className={styles.barLabel}>
                Arm {index === 0 ? "A" : "B"}
              </text>
            </g>
          );
        })}
      </svg>
      <div className={styles.comparisonTableWrap}>
        <table>
          <caption>Exact aggregate values and assigned-recipient denominators</caption>
          <thead>
            <tr>
              <th>Arm</th>
              <th>{metricLabels[metric]}</th>
              <th>Assigned recipients</th>
            </tr>
          </thead>
          <tbody>
            {(["A", "B"] as const).map((arm) => (
              <tr key={arm}>
                <th>Arm {arm}</th>
                <td>
                  {formatMetric(result, metric, metricValue(result, arm, metric))}{" "}
                  <span>{metricUnit(result, metric)}</span>
                </td>
                <td>{result.arms[arm].assignedRecipients}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Restarts an icon's one-shot animation on a short interval so it keeps moving. */
/** Primary outcome as a creator reads it: dollars per recipient for price tests, a purchase rate for copy tests. */
function formatPrimary(result: AnalysedResult, value: number): string {
  if (result.fixture.variable === "PRICE")
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  return `${Math.round(value * 100)}%`;
}

/** A gap between arms: dollars for price tests, percentage points (not percent) for copy tests. */
function formatGap(result: AnalysedResult, value: number): string {
  if (result.fixture.variable === "PRICE") return formatPrimary(result, value);
  const points = value * 100;
  return `${Math.abs(points) < 1 && points !== 0 ? points.toFixed(1) : Math.round(points)} pts`;
}

function niceDomain(low: number, high: number): { ticks: number[]; min: number; max: number } {
  const raw = (high - low || Math.abs(high) || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw)!;
  const min = Math.floor(low / step) * step;
  const max = Math.max(Math.ceil(high / step) * step, min + step * 4);
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) ticks.push(Math.round(tick / step) * step);
  return { ticks, min, max };
}

/** The result as one number first, with the sentence that qualifies it underneath. */
export function ResultHeadline({ result }: { result: AnalysedResult }) {
  const { observedDirection: direction, estimate, fixture } = result;
  const leader = direction.outcome === "A_LED" ? "A" : "B";
  const leaderChance =
    estimate && (leader === "B" ? estimate.probabilityArmBBetter : 1 - estimate.probabilityArmBBetter);
  const metric = fixture.variable === "PRICE" ? "settled revenue per recipient" : "purchase rate";
  const status =
    result.status === "LEARNING_READY" ? "evidence gate passed" : result.status.replaceAll("_", " ").toLowerCase();
  return (
    <div
      className={`${styles.resultBanner} ${styles.resultHeadline} ${result.confidence.supportsLearning ? styles.ready : styles.blocked}`}
    >
      <p className="eyebrow">Observed result · {status}</p>
      <div className={styles.headlineFigures}>
        <div className={styles.headlineFigure}>
          <strong>
            {direction.outcome === "TIED"
              ? "No difference"
              : formatGap(result, Math.abs(direction.differenceArmBMinusArmA))}
          </strong>
          <span>
            {direction.outcome === "TIED"
              ? `Both arms at ${formatPrimary(result, direction.armAValue)} ${metric}`
              : `Arm ${leader} ahead on ${metric} · A ${formatPrimary(result, direction.armAValue)} → B ${formatPrimary(result, direction.armBValue)}`}
          </span>
        </div>
        {leaderChance !== undefined && direction.outcome !== "TIED" && (
          <div className={`${styles.headlineFigure} ${styles.headlineChance}`}>
            <strong>{Math.round(leaderChance * 100)}%</strong>
            <span>chance Arm {leader} is genuinely better</span>
          </div>
        )}
      </div>
      <h3>{direction.statement}</h3>
      {result.learning && (
        <p className={styles.headlineLearning}>
          Saved as a learning for {result.learning.audienceScope.replace(/^Fictional /, "").toLowerCase()}.
        </p>
      )}
    </div>
  );
}

/**
 * Each arm's likely range and the gap between them on one shared axis, so a range that crosses zero reads as
 * "not settled" at a glance. Without an estimate (evidence gate not passed) it plots observed values only.
 */
export function UncertaintyChart({ result }: { result: AnalysedResult }) {
  const { estimate, observedDirection: direction, confidence } = result;
  const rows = [
    { key: "A", label: "Arm A", value: direction.armAValue, range: estimate?.armAInterval, mark: "arm-a" },
    { key: "B", label: "Arm B", value: direction.armBValue, range: estimate?.armBInterval, mark: "arm-b" },
    ...(estimate
      ? [
          {
            key: "gap",
            label: "B − A",
            value: direction.differenceArmBMinusArmA,
            range: estimate.differenceInterval,
            mark: "gap",
          },
        ]
      : []),
  ];
  const extremes = rows.flatMap((row) => [row.value, ...(row.range ?? [])]);
  const { ticks, min, max } = niceDomain(Math.min(0, ...extremes), Math.max(...extremes));
  // Rounded so the server and client serialise identical inline styles.
  const percent = (value: number) => Math.round(((value - min) / (max - min || 1)) * 10000) / 100;
  const position = (value: number) => `${percent(value)}%`;
  const crossesZero = estimate && estimate.differenceInterval[0] < 0 && estimate.differenceInterval[1] > 0;
  return (
    <section className={styles.uncertaintyPanel} aria-labelledby="uncertainty-title">
      <header>
        <h2 id="uncertainty-title" className="section-title">
          How sure is this?
        </h2>
        <p className={styles.uncertaintyVerdict}>
          <strong>{confidence.label}.</strong> {confidence.statement}
        </p>
        {confidence.nextStep && (
          <p className={styles.uncertaintyNext}>
            <strong>Next step:</strong> {confidence.nextStep}
          </p>
        )}
      </header>
      <div className={styles.rangeChart}>
        {rows.map((row) => (
          <div className={`${styles.rangeRow} ${row.key === "gap" ? styles.rangeGap : ""}`} key={row.key}>
            <span className={styles.rangeLabel}>
              {row.mark !== "gap" && <i data-mark={row.mark} aria-hidden="true" />}
              {row.label}
            </span>
            <div className={styles.rangeTrack} aria-hidden="true">
              <span className={styles.rangeZero} style={{ left: position(0) }} />
              {row.range && (
                <span
                  className={styles.rangeInterval}
                  data-mark={row.mark}
                  style={{
                    left: position(row.range[0]),
                    width: `${Math.round((percent(row.range[1]) - percent(row.range[0])) * 100) / 100}%`,
                  }}
                />
              )}
              <span className={styles.rangeDot} data-mark={row.mark} style={{ left: position(row.value) }} />
            </div>
            <span className={styles.rangeValue}>
              <strong>
                {row.key === "gap"
                  ? `${row.value >= 0 ? "+" : "−"}${formatGap(result, Math.abs(row.value))}`
                  : formatPrimary(result, row.value)}
              </strong>
              {row.range && (
                <small>
                  {row.key === "gap"
                    ? `${formatGap(result, row.range[0])} to ${formatGap(result, row.range[1])}`
                    : `${formatPrimary(result, row.range[0])}–${formatPrimary(result, row.range[1])}`}
                </small>
              )}
            </span>
          </div>
        ))}
        <div className={styles.rangeAxis} aria-hidden="true">
          <span>{result.fixture.variable === "PRICE" ? "" : "% / pts"}</span>
          <div>
            {ticks.map((tick) => (
              <span key={tick} style={{ left: position(tick) }}>
                {result.fixture.variable === "PRICE" ? formatPrimary(result, tick) : `${Math.round(tick * 100)}`}
              </span>
            ))}
          </div>
          <span />
        </div>
      </div>
      <p className={styles.rangeCaption}>
        {estimate ? (
          <>
            Dots are what happened in this test; bars are the range the true value falls in 90% of the time, from{" "}
            {estimate.draws.toLocaleString("en-US")} simulated re-runs.{" "}
            {crossesZero
              ? "The B − A range crosses zero, so either arm could still be better."
              : `The B − A range sits entirely on one side of zero.`}
          </>
        ) : (
          <>Dots are what happened in this test. Likely ranges appear once the result passes the evidence gate.</>
        )}
      </p>
    </section>
  );
}

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
    return () => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
    };
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
  return (
    <div className="eyebrow sidebar-heading">
      <ScenarioIcon />
      <span>Scenarios</span>
    </div>
  );
}
