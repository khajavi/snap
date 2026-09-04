import { describe, expect, it } from "vitest";
import { applyEditScript, diffTokens, type EditScript } from "../../src/domain/diff.js";
import { isCanonicalTokenSequence, tokenize } from "../../src/domain/text.js";

/** Asserts SPEC §4.4's "no adjacent operations of the same kind" rule. */
const assertNoAdjacentSameKind = (script: EditScript): void => {
  const kindOf = (op: EditScript[number]): string =>
    "retain" in op ? "retain" : "delete" in op ? "delete" : "insert";
  for (let i = 1; i < script.length; i++) {
    expect(kindOf(script[i]!)).not.toBe(kindOf(script[i - 1]!));
  }
};

describe("diffTokens", () => {
  it("produces an empty script for two empty sequences (creating an empty text file)", () => {
    expect(diffTokens([], [])).toEqual([]);
  });

  it("an insert-only script for an empty old side", () => {
    expect(diffTokens([], ["new"])).toEqual([{ insert: ["new"] }]);
  });

  it("a delete-only script for an empty new side", () => {
    expect(diffTokens(["a\n", "b\n"], [])).toEqual([{ delete: 2 }]);
  });

  it("an all-retain script for identical sequences", () => {
    expect(diffTokens(["a\n", "b\n", "c"], ["a\n", "b\n", "c"])).toEqual([{ retain: 3 }]);
  });

  it("appending a token: retain then insert", () => {
    expect(diffTokens(["a\n"], ["a\n", "b"])).toEqual([{ retain: 1 }, { insert: ["b"] }]);
  });

  it("prepending a token: insert then retain", () => {
    expect(diffTokens(["b"], ["a\n", "b"])).toEqual([{ insert: ["a\n"] }, { retain: 1 }]);
  });

  it("a lone repeated-token match prefers retaining the first occurrence (equality has priority over any tie-break)", () => {
    // A = ["a", "a"], B = ["a"]: SPEC's walk always takes rule 1 (retain) at
    // (0,0) since A[0] == B[0], regardless of D's tie value — it never
    // reaches the delete/insert choice for that position.
    expect(diffTokens(["a", "a"], ["a"])).toEqual([{ retain: 1 }, { delete: 1 }]);
  });

  it("a genuine D-value tie between two non-matching tokens resolves to delete, per SPEC's deletion-on-tie rule", () => {
    // A = ["a", "b"], B = ["c"]: at every step neither token matches, and
    // D(i+1,j) == D(i,j+1) at both (0,0) and (1,0) — hand-traced against
    // SPEC's own D(i,j) recurrence.
    expect(diffTokens(["a", "b"], ["c"])).toEqual([{ delete: 2 }, { insert: ["c"] }]);
  });

  describe("tests/05-diff-goldens.yaml's repeated.txt fixture", () => {
    // Old content "a\nb\na\n" committed, then working tree changed to
    // "b\na\na" (repeated-line reorder plus a dropped trailing newline).
    // The repository.json golden in that fixture records exactly this
    // edit script for the second patch's `repeated.txt` change.
    const oldTokens = tokenize("a\nb\na\n");
    const newTokens = tokenize("b\na\na");

    it("tokenizes as the fixture's before/after content", () => {
      expect(oldTokens).toEqual(["a\n", "b\n", "a\n"]);
      expect(newTokens).toEqual(["b\n", "a\n", "a"]);
    });

    it("matches the golden edit script exactly: delete 1, retain 2, insert [a]", () => {
      expect(diffTokens(oldTokens, newTokens)).toEqual([{ delete: 1 }, { retain: 2 }, { insert: ["a"] }]);
    });
  });

  describe("tests/05-diff-goldens.yaml's added.txt fixture", () => {
    it("a brand-new file's diff (from an empty old side) is a single insert", () => {
      expect(diffTokens([], tokenize("new"))).toEqual([{ insert: ["new"] }]);
    });
  });

  it("coalesces multi-token inserts into one insert operation", () => {
    expect(diffTokens([], ["a\n", "b\n", "c"])).toEqual([{ insert: ["a\n", "b\n", "c"] }]);
  });

  const noAdjacentSameKindCases: ReadonlyArray<[string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
    ["repeated.txt fixture", ["a\n", "b\n", "a\n"], ["b\n", "a\n", "a"]],
    ["disjoint short sequences", ["a", "b"], ["c"]],
    ["interleaved repeats", ["x\n", "y\n", "x\n", "y"], ["y\n", "x\n", "y\n", "x"]],
    ["long common run with edits at both ends", ["p\n", "m1\n", "m2\n", "m3\n", "q"], ["r\n", "m1\n", "m2\n", "m3\n", "s"]],
  ];

  it.each(noAdjacentSameKindCases)("%s: never has adjacent same-kind operations", (_name, a, b) => {
    assertNoAdjacentSameKind(diffTokens(a, b));
  });

  const roundTripCases: ReadonlyArray<[string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
    ["empty to empty", [], []],
    ["empty to nonempty", [], ["a\n", "b"]],
    ["nonempty to empty", ["a\n", "b"], []],
    ["identical", ["a\n", "b\n"], ["a\n", "b\n"]],
    ["repeated.txt fixture", ["a\n", "b\n", "a\n"], ["b\n", "a\n", "a"]],
    ["disjoint short sequences", ["a", "b"], ["c"]],
    ["interleaved repeats", ["x\n", "y\n", "x\n", "y"], ["y\n", "x\n", "y\n", "x"]],
    ["append", ["a\n"], ["a\n", "b"]],
    ["prepend", ["b"], ["a\n", "b"]],
    ["middle edit around a shared prefix/suffix", ["p\n", "m1\n", "m2\n", "m3\n", "q"], ["p\n", "n1\n", "q"]],
  ];

  it.each(roundTripCases)("%s: applying the script to the old tokens reproduces the new tokens", (_name, a, b) => {
    const script = diffTokens(a, b);
    expect(applyEditScript(a, script)).toEqual(b);
  });

  it.each(roundTripCases)("%s: the diff's implied result is a canonical token sequence", (_name, a, b) => {
    expect(isCanonicalTokenSequence(applyEditScript(a, diffTokens(a, b)))).toBe(true);
  });
});

describe("applyEditScript", () => {
  it("throws when the script does not consume the complete old token sequence", () => {
    expect(() => applyEditScript(["a", "b"], [{ retain: 1 }])).toThrow();
  });

  it("throws when a retain runs past the end of the old tokens", () => {
    expect(() => applyEditScript(["a"], [{ retain: 5 }])).toThrow();
  });

  it("throws when a delete runs past the end of the old tokens", () => {
    expect(() => applyEditScript(["a"], [{ delete: 5 }])).toThrow();
  });

  it("an empty script is valid for an empty old sequence (creating an empty text file)", () => {
    expect(applyEditScript([], [])).toEqual([]);
  });
});
