import { describe, expect, it } from "vitest";
import {
  allocateAudience,
  allocationAlgorithmVersion,
  hashAudienceSnapshot,
} from "./allocation";

const members = Array.from({ length: 101 }, (_, index) => ({
  fanUuid: `fan-${index}`,
  stratum: index % 3 === 0 ? "high" : "standard",
}));

describe("allocateAudience", () => {
  it("is stable for the same experiment regardless of input order", () => {
    expect(allocateAudience("exp-1", members)).toEqual(
      allocateAudience("exp-1", [...members].reverse()),
    );
  });

  it("deduplicates identical fans and assigns the complete union once", () => {
    const assignments = allocateAudience("exp-1", [...members, members[0]]);
    expect(assignments).toHaveLength(members.length);
    expect(new Set(assignments.map(({ fanUuid }) => fanUuid)).size).toBe(members.length);
    expect(
      assignments.every(
        ({ algorithmVersion }) => algorithmVersion === allocationAlgorithmVersion,
      ),
    ).toBe(true);
  });

  it("rejects a fan placed in conflicting balancing buckets", () => {
    expect(() =>
      allocateAudience("exp-1", [
        { fanUuid: "fan-1", stratum: "active" },
        { fanUuid: "fan-1", stratum: "expired" },
      ]),
    ).toThrow(/conflicting strata/);
  });

  it("keeps both groups mutually exclusive and balances every bucket within one", () => {
    const assignments = allocateAudience("exp-1", members);
    const a = new Set(
      assignments.filter((item) => item.arm === "A").map((item) => item.fanUuid),
    );
    const b = new Set(
      assignments.filter((item) => item.arm === "B").map((item) => item.fanUuid),
    );

    expect([...a].filter((fanUuid) => b.has(fanUuid))).toEqual([]);
    expect(a.size + b.size).toBe(members.length);

    for (const stratum of ["high", "standard"]) {
      const group = assignments.filter((item) => item.stratum === stratum);
      const armA = group.filter((item) => item.arm === "A").length;
      const armB = group.filter((item) => item.arm === "B").length;
      expect(Math.abs(armA - armB)).toBeLessThanOrEqual(1);
    }
  });

  it("does not systematically give every odd-bucket extra member to A", () => {
    const singleMember = [{ fanUuid: "fan-1", stratum: "active" }];
    const observed = new Set(
      Array.from({ length: 20 }, (_, index) =>
        allocateAudience(`experiment-${index}`, singleMember)[0].arm,
      ),
    );
    expect(observed).toEqual(new Set(["A", "B"]));
  });
});

describe("hashAudienceSnapshot", () => {
  it("is stable across order and identical duplicates", async () => {
    await expect(hashAudienceSnapshot(members)).resolves.toBe(
      await hashAudienceSnapshot([...members, members[0]].reverse()),
    );
  });

  it("changes when bucket membership changes", async () => {
    const changed = members.map((member, index) =>
      index === 0 ? { ...member, stratum: "changed" } : member,
    );
    expect(await hashAudienceSnapshot(changed)).not.toBe(await hashAudienceSnapshot(members));
  });
});
