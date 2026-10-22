import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEMO_EXPERIMENT_HISTORY } from "../../experiments/demo-experiment-history";
import { assignmentWindowCaveat } from "../../live/attribution";
import { analyseResult } from "../../results/analyse";
import { DEMO_RESULT_FIXTURES } from "../../results/demo-results-v1";
import { experimentResultDetail } from "../../results/experiment-results";
import {
  ProgressStrip,
  ResultComparison,
  ScenarioHeading,
  StageIcon,
  initialResultId,
  isProgressCompact,
  resetResultsViewport,
  setupStages,
} from "./experiment-experience";
import styles from "./experiment-experience.module.css";
import { AudienceEvidencePanel, ExperimentHistory, previewHistoryStorageKey } from "./experiment-history";

describe("Experiment dashboard", () => {
  it("keeps a compact representative fixture set in a semantic table", () => {
    localStorage.removeItem(previewHistoryStorageKey);
    expect(DEMO_EXPERIMENT_HISTORY).toHaveLength(5);
    expect(DEMO_EXPERIMENT_HISTORY.map(({ state }) => state)).toEqual([
      "CLOSED",
      "CLOSED",
      "RUNNING",
      "PARTIAL_LAUNCH",
      "INVALID",
    ]);

    render(<ExperimentHistory preview />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getAllByRole("link")).toHaveLength(5);
    expect(within(table).getByText("Specific preview copy")).not.toBeNull();
    expect(
      screen.getByText(
        /Five fixtures cover a clear winner, a clear no-difference, a running test and blocked launches/,
      ),
    ).not.toBeNull();
  });

  it("renders only the result linked to the experiment in the detail URL", () => {
    render(<ExperimentHistory preview selectedId="demo:experiment:copy-complete" />);
    expect(screen.getByRole("heading", { name: "Specific preview copy", level: 1 })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /Arm B produced 15 percentage points more settled purchases/ }),
    ).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map(({ textContent }) => textContent)).toEqual([
      "What was tested",
      "How sure is this?",
      "Who converted and reversed?",
    ]);
    expect(screen.queryByText("Two PPV price points")).toBeNull();
  });

  it("switches descriptive audience breakdowns and keeps the audit privacy-minimal", () => {
    render(<ExperimentHistory preview selectedId="demo:experiment:copy-complete" />);
    expect(screen.getByRole("heading", { name: "Who converted and reversed?" })).not.toBeNull();
    expect(screen.getByText("Seeded demo · not live")).not.toBeNull();
    const relationship = screen.getByRole("button", { name: "Subscriber relationship" });
    fireEvent.click(relationship);
    expect(relationship.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("rowheader", { name: /^Active · renewing/ })).not.toBeNull();
    expect(screen.getByRole("rowheader", { name: /^Trialing/ })).not.toBeNull();
    expect(screen.queryByRole("rowheader", { name: /^Lapsed/ })).toBeNull();
    expect(screen.getByText(/subscribers list holds current subscribers only/)).not.toBeNull();
    expect(screen.getByText(/No display names, handles, email addresses/)).not.toBeNull();
    expect(screen.getByRole("table", { name: /Stable UUIDs and experiment evidence only/ })).not.toBeNull();
  });

  it("labels live cohorts as live, shows the attribution caveat and never mixes provenance", () => {
    const seeded = DEMO_RESULT_FIXTURES[0].audienceEvidence!;
    const live = seeded.map((row) => ({ ...row, provenance: "REAL" as const }));
    render(<AudienceEvidencePanel evidence={live} caveat={assignmentWindowCaveat} />);
    expect(screen.getByText("Live Fanvue evidence")).not.toBeNull();
    expect(screen.queryByText("Seeded demo · not live")).toBeNull();
    expect(screen.getByText(/not by message ID/)).not.toBeNull();
    cleanup();
    const { container } = render(<AudienceEvidencePanel evidence={[...seeded.slice(1), live[0]]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders live results for a launched REAL experiment, and the reason when they are unavailable", () => {
    const experiment = {
      ...DEMO_EXPERIMENT_HISTORY[1],
      id: "real-1",
      dataProvenance: "REAL" as const,
      state: "RUNNING" as const,
    };
    const real = [
      {
        ...experiment,
        launch: {
          scheduledAt: "2026-10-22T10:02:00Z",
          observationEndsAt: "2026-10-29T10:02:00Z",
          armCounts: { A: 1, B: 1 },
        },
        reconciliation: null,
      },
    ];
    const evidence = DEMO_RESULT_FIXTURES[0].audienceEvidence!.map((row) => ({ ...row, provenance: "REAL" as const }));
    const breakdown = {
      provenance: "REAL" as const,
      attributionStrategy: "ASSIGNMENT_WINDOW" as const,
      evidence,
      assignmentWindowOnly: 0,
      unmatchedPlausible: 0,
      caveat: null,
    };
    const converted = (arm: "A" | "B") => evidence.filter((row) => row.arm === arm && row.converted).length;
    const assigned = (arm: "A" | "B") => evidence.filter((row) => row.arm === arm).length;
    render(
      <ExperimentHistory
        preview={false}
        selectedId="real-1"
        realExperiments={real}
        liveResults={{ status: "available", breakdown, analysis: null }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Results so far" })).not.toBeNull();
    expect(screen.queryByText("Awaiting purchases")).toBeNull();
    expect(screen.getByText(`${converted("A")} of ${assigned("A")}`)).not.toBeNull();
    expect(screen.getByText(`${converted("B")} of ${assigned("B")}`)).not.toBeNull();
    expect(screen.getAllByText("Live Fanvue evidence").length).toBeGreaterThan(0);
    cleanup();
    render(
      <ExperimentHistory
        preview={false}
        selectedId="real-1"
        realExperiments={[{ ...real[0], state: "CLOSED" }]}
        liveResults={{ status: "available", breakdown, analysis: analyseResult(DEMO_RESULT_FIXTURES[0]) }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Final result" })).not.toBeNull();
    expect(screen.getByText(/chance Arm B is genuinely better/)).not.toBeNull();
    expect(screen.getByText("Live · frozen at close")).not.toBeNull();
    cleanup();
    render(
      <ExperimentHistory
        preview={false}
        selectedId="real-1"
        realExperiments={real}
        liveResults={{ status: "unavailable", message: "Live results could not be read right now." }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Awaiting purchases" })).not.toBeNull();
    expect(screen.getByText("Live results could not be read right now.")).not.toBeNull();
  });

  it("fails closed when result evidence names a different experiment", () => {
    const experiment = DEMO_EXPERIMENT_HISTORY[0];
    const result = analyseResult(DEMO_RESULT_FIXTURES[0]);
    expect(() =>
      experimentResultDetail(experiment, {
        ...result,
        fixture: { ...result.fixture, experimentId: "demo:experiment:other" },
      }),
    ).toThrow(/does not match/);
  });
});

describe("Experiment setup progress", () => {
  it("keeps Review as the final creator-facing setup stage", () => {
    expect(setupStages).toEqual(["Audience", "Asset", "Question", "Variants", "Review"]);
  });

  it("switches to a compact icon-only state after setup scrolling", async () => {
    expect(isProgressCompact(160)).toBe(false);
    expect(isProgressCompact(161)).toBe(true);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const { container } = render(<ProgressStrip current={2} />);
    const nav = screen.getByRole("navigation", { name: "Experiment setup progress" });
    expect(nav.getAttribute("data-compact")).toBe("false");
    expect(screen.getByLabelText("Question, current").getAttribute("aria-current")).toBe("step");
    expect(screen.getByLabelText("Asset, completed")).not.toBeNull();
    expect(screen.getByLabelText("Review, unavailable")).not.toBeNull();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
    fireEvent.scroll(window);
    await waitFor(() => expect(nav.getAttribute("data-compact")).toBe("true"));
    expect(container.querySelectorAll(`.${styles.stageIcon}`)).toHaveLength(5);
  });

  it("marks the newly current progress and title icons to animate on appearance", () => {
    const { container } = render(
      <>
        <ProgressStrip current={1} />
        <StageIcon stage="Asset" decorative animateOnAppear />
      </>,
    );
    expect(container.querySelectorAll('[data-animate-on-appear="true"]')).toHaveLength(2);
    expect(screen.getByLabelText("Asset, current").querySelector('[data-animate-on-appear="true"]')).not.toBeNull();
  });

  it("keeps the progress strip still but loops continuous heading icons", () => {
    const { container } = render(
      <>
        <ProgressStrip current={1} />
        <StageIcon stage="Asset" decorative continuous />
      </>,
    );
    expect(container.querySelectorAll(`.${styles.stageIcon} svg`)).toHaveLength(6);
    expect(screen.getByLabelText("Asset, current").querySelector('[data-animate-on-appear="true"]')).not.toBeNull();
  });
});

describe("Results navigation and markup", () => {
  it("keeps the div-rendering animated icon out of paragraph markup", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<ScenarioHeading />);
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect(container.querySelector("p div")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("opens the first scenario and resets the results viewport to the top", () => {
    const results = DEMO_RESULT_FIXTURES.map(analyseResult);
    expect(initialResultId(results)).toBe(results[0].fixture.id);
    const heading = document.createElement("h1");
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    const focus = vi.spyOn(heading, "focus");
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    resetResultsViewport(heading);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    heading.remove();
    focus.mockRestore();
    scrollTo.mockRestore();
  });
});

describe("Aggregate results comparison", () => {
  it("switches compatible metrics while keeping exact values and denominators in a table", () => {
    const result = analyseResult(DEMO_RESULT_FIXTURES[0]);
    const { container } = render(<ResultComparison result={result} />);
    const chart = screen.getByRole("img", { name: /Primary outcome for Arm A and Arm B/ });
    expect(chart.getAttribute("aria-label")).toMatch(/Aggregate-only grouped bar chart/);
    expect(container.querySelector(`.${styles.comparisonChart}`)).not.toBeNull();
    expect(container.querySelector(`.${styles.comparisonChart} title`)).toBeNull();
    expect(screen.getByText(/No temporal buckets exist/)).not.toBeNull();
    const revenue = screen.getByRole("radio", { name: "Settled revenue" });
    fireEvent.click(revenue);
    expect(revenue.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Unit · USD")).not.toBeNull();
    const table = screen.getByRole("table", { name: "Exact aggregate values and assigned-recipient denominators" });
    expect(within(table).getAllByText("120")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Reversals" }));
    expect(screen.getByText("Unit · events")).not.toBeNull();
  });
});
