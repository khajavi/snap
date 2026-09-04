import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  MAX_REVISION,
  Version,
  compareSnapOrder,
  compareVersions,
} from "../../src/domain/version.js";

// Fixtures drawn verbatim from SPEC.md §3.2's canonical-syntax example and
// from tests/*.yaml's literal version strings and comparison outcomes
// (tests/19-version-boundaries.yaml, tests/21-version-algebra.yaml,
// tests/25-config-version-path-boundaries.yaml), so canonical form and
// causal algebra here match what the acceptance suite actually checks.

function parseOrThrow(input: string): Version {
  const result = Version.parse(input);
  if (Either.isLeft(result)) {
    throw new Error(`expected ${input} to parse, got: ${result.left.reason}`);
  }
  return result.right;
}

describe("Version.parse / toCanonicalString: round-trip canonical syntax", () => {
  const roundTrips = [
    "()", // SPEC.md §3.2: "The empty version is ()."
    "(jdegoes@example.com->2323,vigoo@example.com->239)", // SPEC.md §3.2's worked example
    "(a@x->1)", // tests/21-version-algebra.yaml
    "(a@x->1,b@x->1)", // tests/21-version-algebra.yaml
    "(a@x->1,b@x->2)", // tests/21-version-algebra.yaml
    "(a@x->2,b@x->2)", // tests/21-version-algebra.yaml
    `(a@x->${MAX_REVISION})`, // exactly the maximum safe integer: the boundary is inclusive
  ];

  it.each(roundTrips)("%s", (canonical) => {
    const version = parseOrThrow(canonical);
    expect(version.toCanonicalString()).toBe(canonical);
  });

  it("Version.empty prints as SPEC.md's empty version literal", () => {
    expect(Version.empty.toCanonicalString()).toBe("()");
  });
});

describe("Version.parse: rejects every case SPEC.md §3.2 calls out", () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["(a@x->01)", "leading zero (tests/21-version-algebra.yaml)"],
    ["(a@x->1,a@x->2)", "duplicate contributor id (tests/21-version-algebra.yaml)"],
    ["(good@x->0)", "explicit zero (tests/25-config-version-path-boundaries.yaml)"],
    ["(good@x->-1)", "not a plain digit literal (tests/25-config-version-path-boundaries.yaml)"],
    [
      "(good@x->9007199254740992)",
      "overflow: one past MAX_SAFE_INTEGER (tests/25-config-version-path-boundaries.yaml)",
    ],
    [
      "(b@x->1,a@x->1)",
      "noncanonical (unsorted) contributor order (tests/25-config-version-path-boundaries.yaml)",
    ],
    [
      "(a@x->1, b@x->1)",
      "whitespace after the comma (tests/25-config-version-path-boundaries.yaml)",
    ],
    ["a@x->1", "not enclosed in parentheses"],
    ["(a@x->1", "missing closing parenthesis"],
    ["a@x->1)", "missing opening parenthesis"],
    ["(a@x->)", "empty revision"],
    ["(a@x->1,)", "trailing comma / empty entry"],
    ["(a@x)", 'entry missing "->"'],
    ["(bad-id->1)", "invalid contributor id embedded in a version entry"],
    ["(a@x->99999999999999999999)", "revision with far more digits than MAX_SAFE_INTEGER"],
  ];

  it.each(invalid)("%s (%s)", (input) => {
    const result = Version.parse(input);
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("compareVersions: SPEC.md §3.3's four-way causal comparison", () => {
  it("equal versions compare equal", () => {
    expect(compareVersions(parseOrThrow("(a@x->1)"), parseOrThrow("(a@x->1)"))).toBe("equal");
    expect(compareVersions(Version.empty, parseOrThrow("()"))).toBe("equal");
  });

  it("a strictly-smaller-everywhere version is before a strictly-larger one", () => {
    // tests/21-version-algebra.yaml: diff (a@x->1) (a@x->2,b@x->2) succeeds,
    // i.e. (a@x->1) is a causal ancestor of (a@x->2,b@x->2).
    expect(compareVersions(parseOrThrow("(a@x->1)"), parseOrThrow("(a@x->2,b@x->2)"))).toBe(
      "before",
    );
    expect(compareVersions(parseOrThrow("(a@x->2,b@x->2)"), parseOrThrow("(a@x->1)"))).toBe(
      "after",
    );
  });

  it("one component up, another down is concurrent (never before/after)", () => {
    // tests/21-version-algebra.yaml: diff (a@x->2,b@x->2) (a@x->1,b@x->2)
    // succeeds as an "after" relation (a advances, b holds) — but a version
    // with a strictly higher a and a strictly lower b than another is
    // genuinely incomparable.
    expect(compareVersions(parseOrThrow("(a@x->2,b@x->2)"), parseOrThrow("(a@x->1,b@x->2)"))).toBe(
      "after",
    );
    expect(compareVersions(parseOrThrow("(a@x->2,b@x->1)"), parseOrThrow("(a@x->1,b@x->2)"))).toBe(
      "concurrent",
    );
    expect(compareVersions(parseOrThrow("(a@x->1,b@x->2)"), parseOrThrow("(a@x->2,b@x->1)"))).toBe(
      "concurrent",
    );
  });

  it("disjoint contributors are concurrent unless one side is empty", () => {
    expect(compareVersions(parseOrThrow("(a@x->1)"), parseOrThrow("(b@x->1)"))).toBe("concurrent");
    expect(compareVersions(Version.empty, parseOrThrow("(a@x->1)"))).toBe("before");
    expect(compareVersions(parseOrThrow("(a@x->1)"), Version.empty)).toBe("after");
  });
});

describe("Version.join: componentwise max (SPEC.md §3.3)", () => {
  it("matches tests/21-version-algebra.yaml's concurrent merge result", () => {
    // a-side committed to (a@x->2); b-side committed to (a@x->1,b@x->2);
    // merging either into the other converges on (a@x->2,b@x->2).
    const aSide = parseOrThrow("(a@x->2)");
    const bSide = parseOrThrow("(a@x->1,b@x->2)");
    expect(Version.join(aSide, bSide).toCanonicalString()).toBe("(a@x->2,b@x->2)");
    expect(Version.join(bSide, aSide).toCanonicalString()).toBe("(a@x->2,b@x->2)");
  });

  it("is idempotent and has the empty version as identity", () => {
    const v = parseOrThrow("(a@x->1,b@x->2)");
    expect(Version.join(v, v).toCanonicalString()).toBe(v.toCanonicalString());
    expect(Version.join(v, Version.empty).toCanonicalString()).toBe(v.toCanonicalString());
    expect(Version.join(Version.empty, v).toCanonicalString()).toBe(v.toCanonicalString());
  });

  it("join(V, W) is always at-or-after both V and W", () => {
    const v = parseOrThrow("(a@x->2,b@x->1)");
    const w = parseOrThrow("(a@x->1,b@x->2)");
    const joined = Version.join(v, w);
    expect(compareVersions(joined, v)).not.toBe("before");
    expect(compareVersions(joined, w)).not.toBe("before");
  });
});

describe("compareSnapOrder: SPEC.md §3.4's arbitrary-but-fixed total order", () => {
  it("decides by the first unequal counter over the sorted contributor union", () => {
    // Sorted union is [a@x, b@x]; a@x's counters (1 vs 2) differ first.
    const v = parseOrThrow("(a@x->1,b@x->2)");
    const w = parseOrThrow("(a@x->2,b@x->1)");
    expect(compareSnapOrder(v, w)).toBe(-1);
    expect(compareSnapOrder(w, v)).toBe(1);
  });

  it("is antisymmetric and reflexive (a total order)", () => {
    const v = parseOrThrow("(a@x->1,b@x->2)");
    expect(compareSnapOrder(v, v)).toBe(0);
  });

  it("extends causal order: a causal 'before' is never Snap-order 'after'", () => {
    const before = parseOrThrow("(a@x->1)");
    const after = parseOrThrow("(a@x->2,b@x->2)");
    expect(compareVersions(before, after)).toBe("before");
    expect(compareSnapOrder(before, after)).toBe(-1);
    expect(compareSnapOrder(after, before)).toBe(1);
  });
});
