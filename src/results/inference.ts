import type { UncertaintyEstimate } from "./contracts";

function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

function beta(alpha: number, betaShape: number, random: () => number): number {
  const left = gamma(alpha, random);
  return left / (left + gamma(betaShape, random));
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

const draws = 10_000;

export function estimateCopyResult(
  input: { assignedA: number; purchasesA: number; assignedB: number; purchasesB: number },
  seed = "perform-copy-beta-v1",
): UncertaintyEstimate {
  for (const [purchases, assigned] of [
    [input.purchasesA, input.assignedA],
    [input.purchasesB, input.assignedB],
  ]) {
    // A Beta posterior needs successes within trials; anything else is an attribution bug upstream.
    if (!Number.isInteger(purchases) || purchases < 0 || purchases > assigned) {
      throw new Error("Converted fans must be a whole number between zero and the assigned recipients");
    }
  }
  const random = seededRandom(seed);
  const armA: number[] = [];
  const armB: number[] = [];
  const difference: number[] = [];
  let bBetter = 0;
  for (let index = 0; index < draws; index += 1) {
    const a = beta(input.purchasesA + 1, input.assignedA - input.purchasesA + 1, random);
    const b = beta(input.purchasesB + 1, input.assignedB - input.purchasesB + 1, random);
    armA.push(a);
    armB.push(b);
    difference.push(b - a);
    if (b > a) bBetter += 1;
  }
  armA.sort((a, b) => a - b);
  armB.sort((a, b) => a - b);
  difference.sort((a, b) => a - b);
  return {
    method: "BETA_BINOMIAL",
    seed,
    draws,
    probabilityArmBBetter: bBetter / draws,
    armAInterval: [quantile(armA, 0.05), quantile(armA, 0.95)],
    armBInterval: [quantile(armB, 0.05), quantile(armB, 0.95)],
    differenceInterval: [quantile(difference, 0.05), quantile(difference, 0.95)],
  };
}

export function estimatePriceResult(
  revenuesA: readonly number[],
  revenuesB: readonly number[],
  seed = "perform-price-bootstrap-v1",
): UncertaintyEstimate {
  const random = seededRandom(seed);
  const armA: number[] = [];
  const armB: number[] = [];
  const difference: number[] = [];
  let bBetter = 0;
  const resampleMean = (values: readonly number[]) => {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    return total / values.length;
  };
  for (let index = 0; index < draws; index += 1) {
    const a = resampleMean(revenuesA);
    const b = resampleMean(revenuesB);
    armA.push(a);
    armB.push(b);
    difference.push(b - a);
    if (b > a) bBetter += 1;
  }
  armA.sort((a, b) => a - b);
  armB.sort((a, b) => a - b);
  difference.sort((a, b) => a - b);
  return {
    method: "RECIPIENT_BOOTSTRAP",
    seed,
    draws,
    probabilityArmBBetter: bBetter / draws,
    armAInterval: [quantile(armA, 0.05), quantile(armA, 0.95)],
    armBInterval: [quantile(armB, 0.05), quantile(armB, 0.95)],
    differenceInterval: [quantile(difference, 0.05), quantile(difference, 0.95)],
  };
}
