import { describe, expect, it } from "vitest";
import { Either } from "effect";
import type { ContributorId } from "../../src/domain/contributor.js";
import type { Patch } from "../../src/domain/patch.js";
import {
  causalClosureOf,
  decodeRepository,
  dotKey,
  dotKeyOf,
  indexPatchesByDot,
} from "../../src/domain/repository.js";

// SPEC.md §4.1's worked example, plus the literal repository-level failing
// cases in tests/15-repository-validation.yaml and
// tests/23-strict-validation-matrix.yaml (grepped by content).

const SPEC_EXAMPLE_REPOSITORY = {
  format: 1,
  frontier: [["alice@example.com", 1]],
  patches: [
    {
      author: "alice@example.com",
      revision: 1,
      base: [],
      message: "add greeting",
      changes: [{ type: "text", path: "hello.txt", edit: [{ insert: ["hello\n"] }] }],
    },
  ],
};

describe("decodeRepository: SPEC.md §4.1's worked example", () => {
  it("decodes the exact JSON from SPEC.md §4.1", () => {
    const result = decodeRepository(SPEC_EXAMPLE_REPOSITORY);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.format).toBe(1);
      expect(result.right.frontier).toEqual([["alice@example.com", 1]]);
      expect(result.right.patches).toHaveLength(1);
    }
  });

  it("accepts the empty repository (frontier and patches both empty)", () => {
    const result = decodeRepository({ format: 1, frontier: [], patches: [] });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("decodeRepository: schema layer rejects malformed top-level shapes", () => {
  it("rejects an unknown top-level field ('repository has unknown field' case)", () => {
    const result = decodeRepository({ format: 1, frontier: [], patches: [], unknown: true });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a format other than the documented value 1", () => {
    const result = decodeRepository({ format: 2, frontier: [], patches: [] });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a non-canonical frontier ('canonical' case: b@x before a@x)", () => {
    const result = decodeRepository({
      format: 1,
      frontier: [
        ["b@x", 1],
        ["a@x", 1],
      ],
      patches: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a non-integer patch revision inside patches ('fraction' case)", () => {
    const result = decodeRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1.5,
          base: [],
          message: "fraction",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("does NOT itself enforce patches sortedness/uniqueness/contiguity (that's replay/validate.ts point 2's job)", () => {
    // Two structurally-valid patches, deliberately out of (author, revision)
    // order: the schema layer alone accepts this; `replay/validate.ts`
    // rejects it.
    const result = decodeRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "second",
          changes: [{ type: "text", path: "f", edit: [{ insert: ["b\n"] }] }],
        },
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "first",
          changes: [{ type: "text", path: "f", edit: [{ insert: ["a\n"] }] }],
        },
      ],
    });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("dotKey / dotKeyOf / indexPatchesByDot", () => {
  const patch: Patch = {
    author: "a@x" as ContributorId,
    revision: 3,
    base: [],
    message: "m",
    changes: [{ type: "delete", path: "f" as Patch["changes"][number]["path"] }],
  };

  it("dotKeyOf agrees with dotKey applied to the same author/revision", () => {
    expect(dotKeyOf({ author: patch.author, revision: patch.revision })).toBe(
      dotKey(patch.author, patch.revision),
    );
  });

  it("dotKey distinguishes different authors and different revisions", () => {
    const a1 = dotKey("a@x" as ContributorId, 1);
    const a2 = dotKey("a@x" as ContributorId, 2);
    const b1 = dotKey("b@x" as ContributorId, 1);
    expect(a1).not.toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it("indexPatchesByDot looks up a patch by its own dot", () => {
    const byDot = indexPatchesByDot([patch]);
    expect(byDot.get(dotKey(patch.author, patch.revision))).toBe(patch);
    expect(byDot.size).toBe(1);
  });
});

describe("causalClosureOf: SPEC.md §4.1's causal closure", () => {
  const patchA1: Patch = {
    author: "a@x" as ContributorId,
    revision: 1,
    base: [],
    message: "a1",
    changes: [{ type: "put", path: "f" as Patch["changes"][number]["path"], content: "YQ==" }],
  };
  const patchA2: Patch = {
    author: "a@x" as ContributorId,
    revision: 2,
    base: [["a@x" as ContributorId, 1]],
    message: "a2",
    changes: [{ type: "delete", path: "f" as Patch["changes"][number]["path"] }],
  };

  it("walks the empty frontier to the empty closure", () => {
    const byDot = indexPatchesByDot([patchA1, patchA2]);
    const result = causalClosureOf([], byDot);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.size).toBe(0);
    }
  });

  it("walks a linear chain back to its genesis patch", () => {
    const byDot = indexPatchesByDot([patchA1, patchA2]);
    const result = causalClosureOf([["a@x" as ContributorId, 2]], byDot);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.size).toBe(2);
      expect(result.right.has(dotKey(patchA1.author, patchA1.revision))).toBe(true);
      expect(result.right.has(dotKey(patchA2.author, patchA2.revision))).toBe(true);
    }
  });

  it("stops the walk at a genesis patch (base=[]) without over-including", () => {
    const byDot = indexPatchesByDot([patchA1, patchA2]);
    const result = causalClosureOf([["a@x" as ContributorId, 1]], byDot);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.size).toBe(1);
      expect(result.right.has(dotKey(patchA1.author, patchA1.revision))).toBe(true);
    }
  });

  it("reports the frontier dot itself when it names no patch (referencedBy: null)", () => {
    const byDot = indexPatchesByDot([patchA1]);
    const result = causalClosureOf([["a@x" as ContributorId, 5]], byDot);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.dot).toEqual({ author: "a@x", revision: 5 });
      expect(result.left.referencedBy).toBeNull();
    }
  });

  it("reports the referencing patch when a base dot is missing mid-walk ('missing a@x' case)", () => {
    // tests/15-repository-validation.yaml: frontier [["a@x",2]], patches=[a@x
    // revision 2 only], base=[["a@x",1]] -- revision 1 does not exist.
    const onlyRevision2: Patch = {
      author: "a@x" as ContributorId,
      revision: 2,
      base: [["a@x" as ContributorId, 1]],
      message: "gap",
      changes: [{ type: "text", path: "f" as Patch["changes"][number]["path"], edit: [] }],
    };
    const byDot = indexPatchesByDot([onlyRevision2]);
    const result = causalClosureOf([["a@x" as ContributorId, 2]], byDot);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.dot).toEqual({ author: "a@x", revision: 1 });
      expect(result.left.referencedBy).toEqual({ author: "a@x", revision: 2 });
    }
  });

  it("walks a diamond (two contributors merging back into a shared ancestor) exactly once each", () => {
    const genesis: Patch = {
      author: "a@x" as ContributorId,
      revision: 1,
      base: [],
      message: "genesis",
      changes: [{ type: "put", path: "f" as Patch["changes"][number]["path"], content: "" }],
    };
    const bBranch: Patch = {
      author: "b@x" as ContributorId,
      revision: 1,
      base: [["a@x" as ContributorId, 1]],
      message: "b",
      changes: [{ type: "put", path: "g" as Patch["changes"][number]["path"], content: "" }],
    };
    const merge: Patch = {
      author: "a@x" as ContributorId,
      revision: 2,
      base: [
        ["a@x" as ContributorId, 1],
        ["b@x" as ContributorId, 1],
      ],
      message: "merge",
      changes: [{ type: "put", path: "h" as Patch["changes"][number]["path"], content: "" }],
    };
    const byDot = indexPatchesByDot([genesis, bBranch, merge]);
    const result = causalClosureOf([["a@x" as ContributorId, 2]], byDot);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.size).toBe(3);
    }
  });
});
