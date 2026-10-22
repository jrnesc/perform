import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OperatorEvidenceView } from "../../../live/operator-view";
import { OperatorEvidenceTables } from "./operator-view";

const view: OperatorEvidenceView = {
  provenance: "REAL",
  deadLetters: {
    total: 1,
    byReason: { INVALID_PAYLOAD: 1 },
    recent: [{ id: "d", reason: "INVALID_PAYLOAD", eventId: "event-1", receivedAt: "2026-10-21T11:00:00.000Z" }],
  },
  pendingReversals: { total: 0, oldest: [] },
  reconciliation: [],
  attribution: [{ experimentId: "experiment-1", messageMatched: 0, assignmentWindowOnly: 3, unmatchedPlausible: 0 }],
};

describe("operator evidence tables", () => {
  it("renders identifiers and counts with explicit empty states", () => {
    render(<OperatorEvidenceTables view={view} />);
    expect(screen.getByText("Dead letters · 1 total")).not.toBeNull();
    expect(screen.getByText("event-1")).not.toBeNull();
    expect(screen.getByText("None pending.")).not.toBeNull();
    expect(screen.getByText("No reconciliation snapshot has been recorded.")).not.toBeNull();
    expect(screen.getByText(/per-recipient message IDs/)).not.toBeNull();
  });
});
