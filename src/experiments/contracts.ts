import type { Assignment, AudienceMember, Arm } from "../domain/allocation";
import type { ExperimentVariable, VariantDefinition } from "../domain/experiment-state";
import type { AssetProvenance, MediaAsset } from "../workspace/contracts";

export type AudienceProvenance = {
  kind: "DEMO_SEEDED";
  label: "Seeded demo data";
  fixtureVersion: string;
};

export type AudienceExclusion = {
  reason: "MUTED" | "CREATOR_ACCOUNT" | "NOT_CONTACTABLE" | "DUPLICATE";
  count: number;
  explanation: string;
};

export type AudienceSnapshot = {
  id: string;
  name: string;
  description: string;
  sourceKind: "DEMO_FIXTURE";
  capturedAt: string;
  members: readonly AudienceMember[];
  sourceCount: number;
  exclusions: readonly AudienceExclusion[];
  provenance: AudienceProvenance;
};

export type ExperimentDraft = {
  id: string;
  name: string;
  audience: AudienceSnapshot;
  asset: MediaAsset;
  variable: ExperimentVariable;
  hypothesis: string;
  variants: readonly VariantDefinition[];
};

export type ExactDifference = {
  field: "copy" | "priceMinor";
  label: string;
  armA: string;
  armB: string;
};

export type ExperimentReview = {
  experimentId: string;
  draft: ExperimentDraft;
  exactDifference: ExactDifference;
  snapshotHash: string;
  assignments: readonly Assignment[];
  armCounts: Readonly<Record<Arm, number>>;
  overlapCount: number;
  eligibleCount: number;
  excludedCount: number;
  provenance: AssetProvenance;
};

export type DryRunEffect = {
  id: string;
  method: "POST";
  path: string;
  purpose: string;
  headers?: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
};

export type DryRunPlan = {
  version: "perform-dry-run-v1";
  mode: "DRY_RUN";
  writeMode: "disabled";
  experimentId: string;
  snapshotHash: string;
  provenance: AssetProvenance;
  summary: {
    listCreations: 2;
    memberBatches: number;
    messages: 2;
    intendedRecipients: number;
    executedEffects: 0;
  };
  effects: readonly DryRunEffect[];
};
