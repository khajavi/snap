import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  compareContributorIds,
  parseContributorId,
  type ContributorId,
} from "../../src/domain/contributor.js";

// Fixtures drawn from SPEC.md §3.1's grammar and from tests/*.yaml's literal
// contributor-id arguments, so this module's notion of "valid"/"invalid"
// matches what the acceptance suite actually exercises.

describe("parseContributorId: accepts SPEC-shaped IDs and preserves spelling", () => {
  const valid = [
    "a@x", // tests/19-version-boundaries.yaml, tests/21-version-algebra.yaml, etc.
    "alice@example.com", // tests/04-commit-status-log.yaml
    "bob@x", // tests/10-merge-conflicts.yaml
    "seed@x", // tests/10-merge-conflicts.yaml
    "remote@x", // tests/26-portability-and-failure-safety.yaml
    "global@example.com", // tests/03-configuration.yaml
    "local@example.com", // tests/03-configuration.yaml
    "jdegoes@example.com", // SPEC.md §3.2's canonical-syntax example
    "vigoo@example.com", // SPEC.md §3.2's canonical-syntax example
    "a-b@x", // lone '-' is allowed (only the substring "->" is forbidden)
    "a>b@x", // lone '>' is allowed (only the substring "->" is forbidden)
    "x@y", // minimal shape: one char on each side of '@'
    "a".repeat(126) + "@" + "b".repeat(127), // 254 bytes exactly: the boundary is inclusive
  ] as const;

  it.each(valid)("%s", (input) => {
    const result = parseContributorId(input);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      // Spelling is preserved exactly, not normalized.
      expect(result.right as string).toBe(input);
    }
  });
});

describe("parseContributorId: rejects grammar violations", () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["bad-id", "no @ at all (tests/03-configuration.yaml)"],
    ["not-an-id", "no @ at all (tests/25-config-version-path-boundaries.yaml)"],
    ["two@@x", "two @ characters (tests/25-config-version-path-boundaries.yaml)"],
    ["space @x", "contains whitespace (tests/25-config-version-path-boundaries.yaml)"],
    ["a,b@x", "contains ',' (tests/25-config-version-path-boundaries.yaml)"],
    ["a(b)@x", "contains '(' and ')' (tests/25-config-version-path-boundaries.yaml)"],
    ["a->b@x", 'contains "->" (tests/25-config-version-path-boundaries.yaml)'],
    ["", "empty string"],
    ["@x", "empty text before '@'"],
    ["x@", "empty text after '@'"],
    ["a\tb@x", "contains a tab (control/whitespace)"],
    ["a\nb@x", "contains a newline (control/whitespace)"],
    ["a\u0000b@x", "contains a NUL control character"],
    ["a\u007fb@x", "contains DEL"],
    ["café@x", "non-ASCII character"],
    ["a".repeat(127) + "@" + "b".repeat(127), "255 bytes: one over the 254-byte limit"],
  ];

  it.each(invalid)("%s (%s)", (input) => {
    const result = parseContributorId(input);
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("compareContributorIds: unsigned UTF-8 byte order (SPEC.md §3.2)", () => {
  it("orders SPEC.md's canonical-syntax example contributors correctly", () => {
    const jdegoes = "jdegoes@example.com" as ContributorId;
    const vigoo = "vigoo@example.com" as ContributorId;
    // (jdegoes@example.com->2323,vigoo@example.com->239) is the example's
    // canonical ordering, i.e. jdegoes sorts before vigoo.
    expect(compareContributorIds(jdegoes, vigoo)).toBe(-1);
    expect(compareContributorIds(vigoo, jdegoes)).toBe(1);
    expect(compareContributorIds(jdegoes, jdegoes)).toBe(0);
  });

  it("compares by byte value, not by locale collation", () => {
    const a = "a@x" as ContributorId;
    const b = "b@x" as ContributorId;
    expect(compareContributorIds(a, b)).toBe(-1);
    expect(compareContributorIds(b, a)).toBe(1);
  });
});
