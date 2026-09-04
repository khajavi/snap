import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import { decodePatch, type Patch } from "../../src/domain/patch.js";
import { Version } from "../../src/domain/version.js";
import { replay } from "../../src/replay/replay.js";
import type { Tree } from "../../src/replay/integrate.js";

// End-to-end coverage for Phase 5b: replay/replay.ts's `replay()` now
// defaults its `textTransform` parameter to replay/ot.ts's
// `snapTextTransform` (SPEC.md §6.3), so every test below calls `replay`
// with NO explicit third argument and still resolves concurrent text
// edits through real OT instead of failing with `OtUnavailableError`.

/** Builds a validated `TrackedPath` fixture (fails loudly on a bad fixture). */
const path = (raw: string): TrackedPath => {
  const result = parseTrackedPath(raw);
  if (Either.isLeft(result)) {
    throw new Error(`fixture path is not a valid tracked path: ${raw}`);
  }
  return result.right;
};

/** Builds a schema-decoded patch fixture (fails loudly on a bad fixture). */
const makePatch = (
  author: string,
  revision: number,
  base: ReadonlyArray<readonly [string, number]>,
  message: string,
  changes: ReadonlyArray<Record<string, unknown>>,
): Patch => {
  const decoded = decodePatch({ author, revision, base, message, changes });
  if (Either.isLeft(decoded)) {
    throw new Error(`fixture patch failed to decode: ${decoded.left.message}`);
  }
  return decoded.right;
};

/** Builds a parsed `Version` fixture (fails loudly on a bad fixture). */
const versionOrThrow = (canonical: string): Version => {
  const parsed = Version.parse(canonical);
  if (Either.isLeft(parsed)) {
    throw new Error(`fixture version is not canonical: ${canonical}`);
  }
  return parsed.right;
};

/** Reads one path's joined text content out of a replayed tree (fails loudly if absent or non-text). */
const textOf = (tree: Tree, raw: string): string => {
  const state = tree.get(path(raw));
  if (state === undefined || state._tag !== "Text") {
    throw new Error(`expected ${raw} to be present text in the replayed tree`);
  }
  return state.tokens.join("");
};

// ---------------------------------------------------------------------------
// A minimal two-patch sanity case: concurrent inserts at opposite ends
// ---------------------------------------------------------------------------

describe("replay: real OT by default, minimal two-patch sanity case", () => {
  it("one contributor inserts at the top, another concurrently inserts at the bottom: both survive with no OtUnavailableError", () => {
    // seed@x creates g = "mid\n". alice@x inserts "TOP\n" before it; bob@x
    // concurrently inserts "BOTTOM\n" after it. §6.1 orders bob@x's result
    // version Snap-less than alice@x's (comparing the sorted union
    // [alice@x, bob@x, seed@x], alice@x's own counter is 1 vs bob@x's
    // patch's 0 there), so bob@x integrates second (case 1, B ≡ C) and
    // alice@x last, whose edit hits §6.2 case 3 against
    // C = {g: "mid\nBOTTOM\n"}. Hand-traced through §6.3's transform table:
    // Q = diff(B, C) = [retain 1, insert ["BOTTOM\n"]]; transforming P =
    // [insert ["TOP\n"], retain 1] through Q emits [insert ["TOP\n"],
    // retain 2], which applied to C reproduces "TOP\nmid\nBOTTOM\n" —
    // neither insert clobbers the other.
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "g", edit: [{ insert: ["mid\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "top", [
      { type: "text", path: "g", edit: [{ insert: ["TOP\n"] }, { retain: 1 }] },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bottom", [
      { type: "text", path: "g", edit: [{ retain: 1 }, { insert: ["BOTTOM\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@x->1,bob@x->1,seed@x->1)"), [seed, alice, bob]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(textOf(result.right.tree, "g")).toBe("TOP\nmid\nBOTTOM\n");
      expect(result.right.warnings).toStrictEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// tests/22-ot-matrix.yaml's "survive" row: a Q-insert before a P-delete
// ---------------------------------------------------------------------------

describe("replay: real OT by default, tests/22-ot-matrix.yaml representative row", () => {
  it("Q insert before a P deletion survives because deletions consume base tokens only (the YAML's 'survive' scenario)", () => {
    // tests/22-ot-matrix.yaml: base f = "0\n1\n2\n3\n4\n"; alice@x deletes
    // "1\n" (delete-base-token) -> "0\n2\n3\n4\n"; bob@x concurrently
    // inserts "B\n" right before "1\n" (insert-before-token) ->
    // "0\nB\n1\n2\n3\n4\n". The YAML asserts the merge yields
    // "0\nB\n2\n3\n4\n" regardless of merge direction. §6.1 again
    // integrates bob@x first (case 1) and alice@x last (case 3): Q =
    // diff(B, C) = [retain 1, insert ["B\n"], retain 4]; transforming P =
    // [retain 1, delete 1, retain 3] through Q emits [retain 2, delete 1,
    // retain 3], which applied to C = "0\nB\n1\n2\n3\n4\n" drops only the
    // base's own "1\n", keeping bob@x's inserted "B\n".
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "f", edit: [{ insert: ["0\n", "1\n", "2\n", "3\n", "4\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "delete-base-token", [
      {
        type: "text",
        path: "f",
        edit: [{ retain: 1 }, { delete: 1 }, { retain: 3 }],
      },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "insert-before-token", [
      {
        type: "text",
        path: "f",
        edit: [{ retain: 1 }, { insert: ["B\n"] }, { retain: 4 }],
      },
    ]);

    const result = replay(versionOrThrow("(alice@x->1,bob@x->1,seed@x->1)"), [seed, alice, bob]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(textOf(result.right.tree, "f")).toBe("0\nB\n2\n3\n4\n");
      expect(result.right.warnings).toStrictEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// tests/18-three-way-convergence.yaml: three concurrent text edits converge
// ---------------------------------------------------------------------------

describe("replay: real OT by default, tests/18-three-way-convergence.yaml", () => {
  it("three contributors concurrently edit one file (insert/insert/delete); replay of the joined frontier converges to the YAML's asserted content with zero warnings", () => {
    // tests/18-three-way-convergence.yaml: seed@x commits story.txt =
    // "start\nend\n"; a@x edits it to "start\nA\nend\n" (insert "A\n"
    // between); b@x edits it to "start\nB\nend\n" (insert "B\n" between);
    // c@x edits it to "end\n" (delete the "start\n" line). The YAML merges
    // all three pairwise, in every association order, into aggregate-1..6,
    // and asserts every aggregate's story.txt equals "B\nA\nend\n" — this
    // test replays the joined frontier (a@x->1,b@x->1,c@x->1,seed@x->1)
    // directly, with no explicit textTransform, proving replay()'s new
    // default performs the real OT needed to reach that exact result.
    //
    // Hand-traced order (§6.1's Snap-order key over the four-way union
    // [a@x, b@x, c@x, seed@x]): seed@x first (empty base), then c@x, b@x,
    // a@x in that order (pairwise Snap-order comparisons all resolve at
    // the smallest-sorting author's own counter: c@x < b@x < a@x). c@x's
    // edit lands as §6.2 case 1 (B ≡ C); b@x's and a@x's each hit case 3
    // against the tree c@x's delete already produced, and the two §6.3
    // transforms compose to "B\nA\nend\n" with no warnings — no structural
    // conflict exists in this scenario, only concurrent text edits.
    const base = ["start\n", "end\n"];
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "story.txt", edit: [{ insert: base }] },
    ]);
    const a = makePatch("a@x", 1, [["seed@x", 1]], "a", [
      {
        type: "text",
        path: "story.txt",
        edit: [{ retain: 1 }, { insert: ["A\n"] }, { retain: 1 }],
      },
    ]);
    const b = makePatch("b@x", 1, [["seed@x", 1]], "b", [
      {
        type: "text",
        path: "story.txt",
        edit: [{ retain: 1 }, { insert: ["B\n"] }, { retain: 1 }],
      },
    ]);
    const c = makePatch("c@x", 1, [["seed@x", 1]], "c", [
      { type: "text", path: "story.txt", edit: [{ delete: 1 }, { retain: 1 }] },
    ]);

    const result = replay(versionOrThrow("(a@x->1,b@x->1,c@x->1,seed@x->1)"), [seed, a, b, c]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(textOf(result.right.tree, "story.txt")).toBe("B\nA\nend\n");
      expect(result.right.warnings).toStrictEqual([]);
    }
  });
});
