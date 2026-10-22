import type { Arm } from "../domain/allocation";
import type { SendIntentEvidence } from "../domain/experiment-state";
import { observationWindowProblem } from "../domain/observation-window";
import {
  FanvueWriteError,
  type FanvueWriteTransport,
  type MassMessagePayload,
} from "../integrations/fanvue/write-transport";
import type { PerformRepository, StoredSendIntent } from "../persistence/contracts";
import type { LaunchRepository, ProvisionedListRecord } from "./launch-repository";

const arms = ["A", "B"] as const;
const memberBatchSize = 100;

export type LaunchResult = {
  status: "RUNNING" | "OPERATOR_REVIEW" | "RETRYABLE" | "INVALID";
  scheduledAt: string;
  lists: Readonly<Record<Arm, string | null>>;
  sends: Readonly<Record<Arm, { status: StoredSendIntent["status"]; messageUuid?: string; recipientCount?: number }>>;
  reason?: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function intentEvidence(intents: readonly StoredSendIntent[]): SendIntentEvidence[] {
  return intents.map((intent) => ({
    arm: intent.arm, idempotencyKey: intent.idempotencyKey, payloadHash: intent.payloadHash,
    status: intent.status, externalMessageUuid: intent.externalMessageUuid,
  }));
}

function exactMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  return a.length === e.length && a.every((value, index) => value === e[index]);
}

async function provisionArm(input: {
  arm: Arm;
  experimentId: string;
  members: readonly string[];
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<ProvisionedListRecord> {
  let record = await input.launchRepository.getList(input.arm);
  if (!record) {
    record = await input.launchRepository.beginList(input.arm, input.members.length, input.now());
    try {
      const created = await input.transport.createCustomList(`Perform ${input.experimentId} · ${input.arm}`);
      record = { ...record, status: "CONFIRMED", externalListUuid: created.uuid };
      await input.launchRepository.recordListOutcome({ ...record, occurredAt: input.now() });
    } catch (error) {
      record = {
        ...record, status: "UNKNOWN",
        lastErrorCode: error instanceof FanvueWriteError ? String(error.status ?? "NETWORK") : "UNEXPECTED",
      };
      await input.launchRepository.recordListOutcome({ ...record, occurredAt: input.now() });
      throw new Error(`Arm ${input.arm} list creation is uncertain; operator review is required before any retry`);
    }
  }
  if (record.status === "UNKNOWN" || record.status === "CREATING") {
    throw new Error(`Arm ${input.arm} list creation is uncertain; a second list will not be created`);
  }
  if (record.status === "DELETED" || !record.externalListUuid) throw new Error(`Arm ${input.arm} list is unavailable`);

  for (let offset = 0; offset < input.members.length; offset += memberBatchSize) {
    const members = input.members.slice(offset, offset + memberBatchSize);
    const batchNumber = Math.floor(offset / memberBatchSize) + 1;
    const payloadHash = await sha256(members);
    const batch = await input.launchRepository.beginBatch({
      arm: input.arm, batchNumber, payloadHash, memberCount: members.length, occurredAt: input.now(),
    });
    if (batch.status === "CONFIRMED") continue;
    try {
      // Fanvue documents this operation as set-like: existing members are skipped.
      // Replaying the identical durable batch cannot duplicate membership.
      await input.transport.addCustomListMembers(record.externalListUuid, members);
      await input.launchRepository.recordBatchOutcome({ ...batch, status: "CONFIRMED", occurredAt: input.now() });
    } catch (error) {
      const uncertain = error instanceof FanvueWriteError && error.kind === "UNCERTAIN";
      await input.launchRepository.recordBatchOutcome({
        ...batch, status: uncertain ? "UNKNOWN" : "FAILED",
        errorCode: error instanceof FanvueWriteError ? String(error.status ?? "NETWORK") : "UNEXPECTED",
        occurredAt: input.now(),
      });
      throw error;
    }
  }

  const actual = await input.transport.listCustomListMembers(record.externalListUuid);
  if (!exactMembers(actual, input.members)) {
    await input.launchRepository.recordListOutcome({ ...record, actualCount: new Set(actual).size, occurredAt: input.now() });
    throw new Error(`Arm ${input.arm} list verification did not exactly match its frozen assignment`);
  }
  record = { ...record, status: "CONFIRMED", actualCount: input.members.length };
  await input.launchRepository.recordListOutcome({ ...record, occurredAt: input.now() });
  return record;
}

async function sendIntent(input: {
  intent: StoredSendIntent;
  repository: PerformRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<void> {
  if (input.intent.status === "CONFIRMED" || input.intent.status === "FAILED") return;
  const payload = JSON.parse(input.intent.payloadJson) as MassMessagePayload;
  if (input.intent.status === "UNKNOWN") {
    const found = await input.transport.findMassMessageByIdempotencyKey(input.intent.idempotencyKey);
    if (found) {
      await input.repository.recordSendOutcome({
        intentId: input.intent.id, status: "CONFIRMED", occurredAt: input.now(),
        externalMessageUuid: found.uuid, scheduledAt: found.scheduledAt,
        recipientCount: found.recipientCount,
      });
      return;
    }
  }
  try {
    // UNKNOWN retries deliberately use the persisted key and byte-equivalent payload.
    const sent = await input.transport.createMassMessage(payload, input.intent.idempotencyKey);
    await input.repository.recordSendOutcome({
      intentId: input.intent.id, status: "CONFIRMED", occurredAt: input.now(),
      externalMessageUuid: sent.uuid, scheduledAt: sent.scheduledAt,
      recipientCount: sent.recipientCount,
    });
  } catch (error) {
    const uncertain = error instanceof FanvueWriteError && error.kind === "UNCERTAIN";
    await input.repository.recordSendOutcome({
      intentId: input.intent.id, status: uncertain ? "UNKNOWN" : "FAILED",
      errorCode: error instanceof FanvueWriteError ? String(error.status ?? "NETWORK") : "UNEXPECTED",
      occurredAt: input.now(), scheduledAt: payload.scheduledAt,
    });
  }
}

export async function executeConfirmedLaunch(input: {
  creatorUuid: string;
  experimentId: string;
  scheduledAt: string;
  observationEndsAt: string;
  confirmationHash: string;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<LaunchResult> {
  let experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment || experiment.creatorUuid !== input.creatorUuid) throw new Error("Experiment was not found for this creator");
  if (experiment.state === "RUNNING") {
    const existing = await input.repository.listSendIntents(experiment.id);
    return launchResult("RUNNING", input.scheduledAt, await Promise.all(arms.map((arm) => input.launchRepository.getList(arm))), existing);
  }
  if (experiment.state === "PARTIAL_LAUNCH" || experiment.state === "OPERATOR_REVIEW") {
    const existing = await input.repository.listSendIntents(experiment.id);
    return launchResult("OPERATOR_REVIEW", input.scheduledAt, await Promise.all(arms.map((arm) => input.launchRepository.getList(arm))), existing);
  }
  if (!["ALLOCATED", "PROVISIONING", "VERIFIED", "ARMED", "SENDING"].includes(experiment.state)) {
    throw new Error(`Experiment state ${experiment.state} cannot launch`);
  }
  const scheduled = new Date(input.scheduledAt);
  if (Number.isNaN(scheduled.valueOf()) || scheduled.valueOf() < new Date(input.now()).valueOf() + 3 * 60_000) {
    throw new Error("The scheduled delivery must be at least three minutes in the future");
  }
  const windowProblem = observationWindowProblem(input.scheduledAt, input.observationEndsAt);
  if (windowProblem) throw new Error(windowProblem);
  await input.launchRepository.recordConfirmation({
    scheduledAt: input.scheduledAt, observationEndsAt: input.observationEndsAt,
    confirmationHash: input.confirmationHash, confirmedAt: input.now(),
  });
  const [assignments, variants] = await Promise.all([
    input.repository.listAssignments(experiment.id), input.repository.listVariants(experiment.id),
  ]);
  const members = Object.fromEntries(arms.map((arm) => [arm, assignments.filter((row) => row.arm === arm).map((row) => row.fanUuid).sort()])) as Record<Arm, string[]>;
  if (members.A.length === 0 || members.B.length === 0) throw new Error("Both arms need frozen assignments");

  if (experiment.state === "ALLOCATED") {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:provision`, experimentId: experiment.id, to: "PROVISIONING", occurredAt: input.now(),
      evidence: { snapshot: {
        hash: experiment.snapshotHash!, eligibleCount: assignments.length, assignmentCount: assignments.length,
        armCounts: { A: members.A.length, B: members.B.length }, algorithmVersion: experiment.allocationAlgorithm!,
      } },
    });
    experiment = (await input.repository.getExperiment(experiment.id))!;
  }

  const lists = await Promise.all(arms.map((arm) => provisionArm({
    arm, experimentId: experiment!.id, members: members[arm], launchRepository: input.launchRepository,
    transport: input.transport, now: input.now,
  })));
  if (experiment.state === "PROVISIONING") {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:verified`, experimentId: experiment.id, to: "VERIFIED", occurredAt: input.now(),
      evidence: { provisioning: {
        armCounts: { A: lists[0].actualCount!, B: lists[1].actualCount! },
        expectedArmCounts: { A: members.A.length, B: members.B.length },
      } },
    });
    experiment = (await input.repository.getExperiment(experiment.id))!;
  }

  let intents = await input.repository.listSendIntents(experiment.id);
  if (intents.length === 0) {
    const createdAt = input.now();
    const newIntents = await Promise.all(arms.map(async (arm, index) => {
      const variant = variants.find((item) => item.arm === arm);
      if (!variant || !lists[index].externalListUuid) throw new Error(`Arm ${arm} launch definition is incomplete`);
      const payload: MassMessagePayload = {
        text: variant.copy,
        includedLists: { customListUuids: [lists[index].externalListUuid!] },
        excludedLists: {}, mediaUuids: [variant.mediaUuid], price: variant.priceMinor,
        scheduledAt: input.scheduledAt,
      };
      return {
        id: `${experiment!.id}:intent:${arm}`, experimentId: experiment!.id, arm,
        idempotencyKey: `${experiment!.id}:${arm}`, payloadJson: canonical(payload),
        payloadHash: await sha256(payload), createdAt,
      };
    }));
    await input.repository.createSendIntents(newIntents);
    intents = await input.repository.listSendIntents(experiment.id);
  }
  if (intents.length !== 2) throw new Error("Exactly two durable send intents are required");

  if (experiment.state === "VERIFIED") {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:armed`, experimentId: experiment.id, to: "ARMED", occurredAt: input.now(),
      evidence: { sendIntents: intentEvidence(intents), launchConfirmed: true },
    });
    experiment = (await input.repository.getExperiment(experiment.id))!;
  }
  if (experiment.state === "ARMED") {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:sending`, experimentId: experiment.id, to: "SENDING", occurredAt: input.now(),
      evidence: { sendIntents: intentEvidence(intents) },
    });
  }

  await Promise.all(intents.map((intent) => sendIntent({
    intent, repository: input.repository, transport: input.transport, now: input.now,
  })));
  intents = await input.repository.listSendIntents(experiment.id);
  const confirmed = intents.filter((intent) => intent.status === "CONFIRMED");
  if (confirmed.length === 2) {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:running`, experimentId: experiment.id, to: "RUNNING", occurredAt: input.scheduledAt,
      evidence: { sendIntents: intentEvidence(intents) },
    });
    return launchResult("RUNNING", input.scheduledAt, lists, intents);
  }
  if (intents.some((intent) => intent.status === "UNKNOWN")) {
    return launchResult("RETRYABLE", input.scheduledAt, lists, intents, "An uncertain send must be resolved by read before retry");
  }
  if (confirmed.length === 1) {
    const surviving = confirmed[0];
    try {
      await input.transport.cancelMassMessage(surviving.externalMessageUuid!);
      await input.launchRepository.markIntentCancelled(surviving.id, input.now());
    } catch { /* cancellation remains visible to operator review */ }
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:partial`, experimentId: experiment.id, to: "PARTIAL_LAUNCH", occurredAt: input.now(),
      evidence: { sendIntents: intentEvidence(intents) },
    });
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:review`, experimentId: experiment.id, to: "OPERATOR_REVIEW", occurredAt: input.now(),
      evidence: { operatorReviewOpened: true },
    });
    return launchResult("OPERATOR_REVIEW", input.scheduledAt, lists, intents, "Exactly one schedule confirmed; cancellation was attempted");
  }
  await input.repository.transitionExperiment({
    commandId: `${experiment.id}:send-failed`, experimentId: experiment.id, to: "INVALID", occurredAt: input.now(),
    evidence: { invalidReason: "Neither scheduled send was confirmed", sendIntents: intentEvidence(intents) },
  });
  return launchResult("INVALID", input.scheduledAt, lists, intents, "Neither scheduled send was confirmed");
}

export async function cancelScheduledLaunch(input: {
  experimentId: string;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<{ status: "CANCELLED"; cancelledMessages: number; deletedLists: number }> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment) throw new Error("Experiment was not found");
  const intents = await input.repository.listSendIntents(experiment.id);
  const scheduledAt = intents.map((intent) => intent.scheduledAt).filter(Boolean).sort()[0];
  if (!scheduledAt || new Date(input.now()).valueOf() >= new Date(scheduledAt).valueOf()) {
    throw new Error("The cancellation window has closed");
  }
  let cancelledMessages = 0;
  for (const intent of intents) {
    if (intent.status !== "CONFIRMED" || !intent.externalMessageUuid || intent.cancelledAt) continue;
    await input.transport.cancelMassMessage(intent.externalMessageUuid);
    await input.launchRepository.markIntentCancelled(intent.id, input.now());
    cancelledMessages += 1;
  }
  let deletedLists = 0;
  for (const arm of arms) {
    const list = await input.launchRepository.getList(arm);
    if (!list?.externalListUuid || list.status === "DELETED") continue;
    await input.transport.deleteCustomList(list.externalListUuid);
    await input.launchRepository.recordListOutcome({ ...list, status: "DELETED", occurredAt: input.now() });
    deletedLists += 1;
  }
  if (["RUNNING", "SENDING", "ARMED", "VERIFIED", "PROVISIONING", "ALLOCATED"].includes(experiment.state)) {
    await input.repository.transitionExperiment({
      commandId: `${experiment.id}:cancelled`, experimentId: experiment.id, to: "INVALID",
      occurredAt: input.now(), evidence: { invalidReason: "Creator cancelled before scheduled delivery", sendIntents: intentEvidence(intents) },
    });
  }
  return { status: "CANCELLED", cancelledMessages, deletedLists };
}

function launchResult(
  status: LaunchResult["status"],
  scheduledAt: string,
  lists: readonly (ProvisionedListRecord | null)[],
  intents: readonly StoredSendIntent[],
  reason?: string,
): LaunchResult {
  const listMap = Object.fromEntries(arms.map((arm, index) => [arm, lists[index]?.externalListUuid ?? null])) as Record<Arm, string | null>;
  const sends = Object.fromEntries(arms.map((arm) => {
    const intent = intents.find((item) => item.arm === arm);
    return [arm, { status: intent?.status ?? "PENDING", messageUuid: intent?.externalMessageUuid, recipientCount: intent?.recipientCount }];
  })) as LaunchResult["sends"];
  return { status, scheduledAt, lists: listMap, sends, reason };
}
