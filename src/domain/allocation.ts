export type Arm = "A" | "B";

export const allocationAlgorithmVersion = "fnv1a-stratified-alternating-v2";
export const defaultStratum = "all";

export interface AudienceMember {
  fanUuid: string;
  /** Optional balancing bucket, for example subscription state. */
  stratum?: string;
}

export interface Assignment {
  fanUuid: string;
  stratum: string;
  arm: Arm;
  algorithmVersion: typeof allocationAlgorithmVersion;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashParts(...parts: string[]): number {
  return fnv1a(JSON.stringify(parts));
}

function normaliseMembers(members: readonly AudienceMember[]): AudienceMember[] {
  const unique = new Map<string, AudienceMember>();

  for (const member of members) {
    const fanUuid = member.fanUuid.trim();
    const stratum = member.stratum?.trim() || defaultStratum;
    if (!fanUuid) throw new Error("Audience members must have a fan UUID");

    const previous = unique.get(fanUuid);
    if (previous && previous.stratum !== stratum) {
      throw new Error(`Fan ${fanUuid} appears in conflicting strata: ${previous.stratum} and ${stratum}`);
    }

    unique.set(fanUuid, { fanUuid, stratum });
  }

  return [...unique.values()];
}

/**
 * Split an audience into two stable, mutually exclusive groups. Members are
 * deduplicated, sorted by a seeded hash inside each optional balancing bucket,
 * and alternated between arms. The seeded starting arm prevents A from always
 * receiving the extra member in odd-sized buckets.
 */
export function allocateAudience(experimentUuid: string, members: readonly AudienceMember[]): Assignment[] {
  if (!experimentUuid.trim()) throw new Error("An experiment UUID is required");

  const strata = new Map<string, AudienceMember[]>();
  for (const member of normaliseMembers(members)) {
    const stratum = member.stratum ?? defaultStratum;
    const group = strata.get(stratum) ?? [];
    group.push(member);
    strata.set(stratum, group);
  }

  return [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([stratum, group]) => {
      const firstArm: Arm =
        hashParts(allocationAlgorithmVersion, experimentUuid, stratum, "first-arm") % 2 === 0 ? "A" : "B";

      return group
        .sort((left, right) => {
          const delta =
            hashParts(allocationAlgorithmVersion, experimentUuid, left.fanUuid) -
            hashParts(allocationAlgorithmVersion, experimentUuid, right.fanUuid);
          return delta || left.fanUuid.localeCompare(right.fanUuid);
        })
        .map((member, index) => ({
          fanUuid: member.fanUuid,
          stratum,
          arm: index % 2 === 0 ? firstArm : firstArm === "A" ? "B" : "A",
          algorithmVersion: allocationAlgorithmVersion,
        }));
    });
}

/** A stable SHA-256 fingerprint of the complete, deduplicated audience. */
export async function hashAudienceSnapshot(members: readonly AudienceMember[]): Promise<string> {
  const canonical = normaliseMembers(members)
    .map(({ fanUuid, stratum }) => [fanUuid, stratum ?? defaultStratum] as const)
    .sort(
      ([leftFan, leftStratum], [rightFan, rightStratum]) =>
        leftFan.localeCompare(rightFan) || leftStratum.localeCompare(rightStratum),
    );
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
