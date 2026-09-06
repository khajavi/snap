import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  checkAcyclicCausality,
  checkBaseClosureAndRevisionFormula,
  checkChangesAgainstMaterializedBase,
  checkFrontierReplay,
  checkPatchSortingDuplicatesAndContiguity,
  validateRepository,
} from "../../src/replay/validate.js";
import { indexPatchesByDot } from "../../src/domain/repository.js";
import type { Patch } from "../../src/domain/patch.js";

// SPEC.md §4.1's worked example plus the literal repository-validation
// failing cases in tests/15-repository-validation.yaml,
// tests/16-dot-collision.yaml, and tests/23-strict-validation-matrix.yaml
// (grepped by content, not guessed by filename), organized by which of
// SPEC.md §4.5's six validation points they exercise.

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

describe("validateRepository: SPEC.md §4.1's worked example", () => {
  it("accepts the exact JSON from SPEC.md §4.1", () => {
    const result = validateRepository(SPEC_EXAMPLE_REPOSITORY);
    expect(Either.isRight(result)).toBe(true);
  });

  it("accepts the empty repository", () => {
    const result = validateRepository({ format: 1, frontier: [], patches: [] });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("validateRepository point 1 (schema): unknown fields and invalid typed values", () => {
  it("rejects an unknown top-level field ('repository has unknown field: unknown')", () => {
    const result = validateRepository({ format: 1, frontier: [], patches: [], unknown: true });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects a non-canonical frontier ('canonical' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [
        ["b@x", 1],
        ["a@x", 1],
      ],
      patches: [],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects a non-integer revision ('fraction' case)", () => {
    const result = validateRepository({
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
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects an empty message ('message is empty' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        { author: "a@x", revision: 1, base: [], message: "", changes: [{ type: "text", path: "f", edit: [] }] },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects empty changes ('changes is empty' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [{ author: "a@x", revision: 1, base: [], message: "none", changes: [] }],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects an unknown field on a change ('change field' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "change field",
          changes: [{ type: "put", path: "f", content: "YQ==", extra: 1 }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects a two-key edit op ('bad op' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad op",
          changes: [{ type: "text", path: "f", edit: [{ retain: 1, delete: 1 }] }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects a non-positive edit-op count ('bad count' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad count",
          changes: [{ type: "text", path: "f", edit: [{ retain: 0 }] }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects an empty insert ('empty insert' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "empty insert",
          changes: [{ type: "text", path: "f", edit: [{ insert: [] }] }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects adjacent same-kind edit ops ('adjacent insert' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "adjacent",
          changes: [
            { type: "text", path: "f", edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }] },
          ],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects an invalid change path ('bad path' case: .snap/secret)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad path",
          changes: [{ type: "put", path: ".snap/secret", content: "YQ==" }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects malformed base64 content ('bad bytes' case)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad bytes",
          changes: [{ type: "put", path: "f", content: "abc" }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });

  it("rejects a same-patch tree-path prefix conflict ('tree paths conflict' case: a, a/b)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "prefix",
          changes: [
            { type: "put", path: "a", content: "YQ==" },
            { type: "put", path: "a/b", content: "Yg==" },
          ],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });
});

describe("validateRepository point 2: sorting, one value per dot, contiguity", () => {
  const makePatch = (author: string, revision: number, base: ReadonlyArray<readonly [string, number]>): Patch =>
    ({
      author,
      revision,
      base,
      message: "m",
      changes: [{ type: "delete", path: "f" }],
    }) as unknown as Patch;

  it("checkPatchSortingDuplicatesAndContiguity accepts a well-formed sorted chain", () => {
    const patches = [makePatch("a@x", 1, []), makePatch("a@x", 2, [["a@x", 1]])];
    expect(Either.isRight(checkPatchSortingDuplicatesAndContiguity(patches))).toBe(true);
  });

  it("rejects patches out of (author, revision) order", () => {
    const patches = [makePatch("b@x", 1, []), makePatch("a@x", 1, [])];
    const result = checkPatchSortingDuplicatesAndContiguity(patches);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UnsortedPatchesError");
    }
  });

  it("rejects a byte-identical duplicate dot", () => {
    const patch = makePatch("a@x", 1, []);
    const result = checkPatchSortingDuplicatesAndContiguity([patch, structuredClone(patch)]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("DuplicatePatchError");
    }
  });

  it("rejects the same dot with structurally different values as corruption (SPEC.md §3.5/§4.2)", () => {
    const first = makePatch("a@x", 1, []);
    const second = { ...first, message: "different" } as Patch;
    const result = checkPatchSortingDuplicatesAndContiguity([first, second]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("CorruptPatchError");
    }
  });

  it("rejects a revision gap ('gap' case: a@x jumps straight to revision 2)", () => {
    const patches = [makePatch("a@x", 2, [["a@x", 1]])];
    const result = checkPatchSortingDuplicatesAndContiguity(patches);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result) && result.left._tag === "NonContiguousRevisionError") {
      expect(result.left.expectedRevision).toBe(1);
    } else {
      expect.fail("expected a NonContiguousRevisionError");
    }
  });

  it("tracks contiguity per author independently", () => {
    // Sorted by (author, revision): all of a@x's entries precede b@x's.
    const patches = [makePatch("a@x", 1, []), makePatch("a@x", 2, [["a@x", 1]]), makePatch("b@x", 1, [])];
    expect(Either.isRight(checkPatchSortingDuplicatesAndContiguity(patches))).toBe(true);
  });
});

describe("validateRepository point 3: base closure and the revision formula", () => {
  it("rejects a base dot with no matching patch (IncompleteBaseClosureError)", () => {
    const patches = [
      { author: "a@x", revision: 1, base: [["b@x", 1]], message: "m", changes: [{ type: "delete", path: "f" }] },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    const result = checkBaseClosureAndRevisionFormula(patches, byDot);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("IncompleteBaseClosureError");
    }
  });

  it("rejects revision != base[author] + 1 (InvalidRevisionFormulaError)", () => {
    const patches = [
      { author: "a@x", revision: 3, base: [], message: "m", changes: [{ type: "delete", path: "f" }] },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    const result = checkBaseClosureAndRevisionFormula(patches, byDot);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result) && result.left._tag === "InvalidRevisionFormulaError") {
      expect(result.left.expectedRevision).toBe(1);
    } else {
      expect.fail("expected an InvalidRevisionFormulaError");
    }
  });

  it("accepts a well-formed base closure with the correct revision formula", () => {
    const patches = [
      { author: "a@x", revision: 1, base: [], message: "m", changes: [{ type: "delete", path: "f" }] },
      {
        author: "a@x",
        revision: 2,
        base: [["a@x", 1]],
        message: "m",
        changes: [{ type: "delete", path: "g" }],
      },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    expect(Either.isRight(checkBaseClosureAndRevisionFormula(patches, byDot))).toBe(true);
  });
});

describe("validateRepository point 4: acyclic causality", () => {
  it("rejects a two-patch cycle ('cyclic or incomplete patch history' case)", () => {
    const patches = [
      { author: "a@x", revision: 1, base: [["b@x", 1]], message: "cycle a", changes: [{ type: "delete", path: "a" }] },
      { author: "b@x", revision: 1, base: [["a@x", 1]], message: "cycle b", changes: [{ type: "delete", path: "b" }] },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    const result = checkAcyclicCausality(patches, byDot);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("CyclicCausalityError");
      expect(result.left.cycle.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("accepts an acyclic diamond", () => {
    const patches = [
      { author: "a@x", revision: 1, base: [], message: "genesis", changes: [{ type: "delete", path: "f" }] },
      { author: "b@x", revision: 1, base: [["a@x", 1]], message: "b", changes: [{ type: "delete", path: "g" }] },
      {
        author: "a@x",
        revision: 2,
        base: [
          ["a@x", 1],
          ["b@x", 1],
        ],
        message: "merge",
        changes: [{ type: "delete", path: "h" }],
      },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    expect(Either.isRight(checkAcyclicCausality(patches, byDot))).toBe(true);
  });
});

describe("validateRepository point 5 (PARTIAL): trivial empty-base case only", () => {
  it("rejects a delete under an empty base ('delete of absent path: f' case)", () => {
    const repository = {
      format: 1 as const,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ] as ReadonlyArray<readonly [string, number]>,
      patches: [
        { author: "a@x", revision: 1, base: [], message: "base", changes: [{ type: "put", path: "f", content: "YQ==" }] },
        { author: "b@x", revision: 1, base: [], message: "absent", changes: [{ type: "delete", path: "f" }] },
      ],
    } as unknown as Parameters<typeof checkChangesAgainstMaterializedBase>[0];
    const result = checkChangesAgainstMaterializedBase(repository);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ChangeBaseConflictError");
      expect(result.left.path).toBe("f");
    }
  });

  it("rejects a text edit with a retain/delete op under an empty base (no old tokens exist)", () => {
    const repository = {
      format: 1 as const,
      frontier: [["a@x", 1]] as ReadonlyArray<readonly [string, number]>,
      patches: [
        { author: "a@x", revision: 1, base: [], message: "m", changes: [{ type: "text", path: "f", edit: [{ retain: 1 }] }] },
      ],
    } as unknown as Parameters<typeof checkChangesAgainstMaterializedBase>[0];
    const result = checkChangesAgainstMaterializedBase(repository);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ChangeBaseConflictError");
    }
  });

  it("accepts text/put creations under an empty base", () => {
    const repository = {
      format: 1 as const,
      frontier: [["a@x", 1]] as ReadonlyArray<readonly [string, number]>,
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "m",
          changes: [
            { type: "put", path: "f", content: "YQ==" },
          ],
        },
      ],
    } as unknown as Parameters<typeof checkChangesAgainstMaterializedBase>[0];
    expect(Either.isRight(checkChangesAgainstMaterializedBase(repository))).toBe(true);
  });

  it("rejects a nonempty-base edit that does not consume its old content (Phase 4+ machinery now wired in)", () => {
    // tests/15-repository-validation.yaml's "does not consume old content"
    // case: patch a@x->2 edits `f` (created by a@x->1 with two tokens) with
    // a single `{"retain": 1}` -- it stops short of the complete old token
    // sequence (§4.4), so point 5 must reject it via the base-version replay.
    const underconsume = {
      format: 1,
      frontier: [["a@x", 2]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "base",
          changes: [{ type: "text", path: "f", edit: [{ insert: ["one\n", "two\n"] }] }],
        },
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "underconsume",
          changes: [{ type: "text", path: "f", edit: [{ retain: 1 }] }],
        },
      ],
    };
    const result = validateRepository(underconsume);
    // The base-version replay machinery (Phases 4-5) is wired in, so the
    // malformed edit script IS rejected -- the old phase boundary is gone.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ChangeBaseConflictError");
    }
  });
});

describe("validateRepository point 6: deterministic replay of the declared frontier", () => {
  it("rejects an unreachable patch ('unreachable patch' case: empty frontier, one patch)", () => {
    const result = validateRepository({
      format: 1,
      frontier: [],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "unreachable",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UnreachablePatchError");
    }
  });

  it("rejects a frontier entry with no matching patch", () => {
    const result = validateRepository({ format: 1, frontier: [["a@x", 1]], patches: [] });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UnknownFrontierDotError");
    }
  });

  it("checkFrontierReplay accepts a repository whose frontier closure is exactly its patches", () => {
    const patches = [
      { author: "a@x", revision: 1, base: [], message: "m", changes: [{ type: "delete", path: "f" }] },
    ] as unknown as Patch[];
    const byDot = indexPatchesByDot(patches);
    const repository = { format: 1 as const, frontier: [["a@x", 1]] as ReadonlyArray<readonly [string, number]>, patches };
    const result = checkFrontierReplay(
      repository as unknown as Parameters<typeof checkFrontierReplay>[0],
      byDot,
    );
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("validateRepository: cross-repository dot collision surfaces as corruption (tests/16-dot-collision.yaml)", () => {
  it("flags a@x revision 1 as corrupt when the local and remote patch sets disagree on its content", () => {
    // tests/16-dot-collision.yaml imports a remote repository.json whose
    // a@x revision 1 patch differs from the local one at the same dot --
    // simulated here as the union `patches` array a future merge command
    // would build before validating.
    const local = {
      author: "a@x",
      revision: 1,
      base: [],
      message: "local",
      changes: [{ type: "text", path: "file.txt", edit: [{ insert: ["local\n"] }] }],
    };
    const remote = {
      author: "a@x",
      revision: 1,
      base: [],
      message: "different",
      changes: [{ type: "text", path: "file.txt", edit: [{ insert: ["remote\n"] }] }],
    };
    const patches = [local, remote] as unknown as Patch[];
    const result = checkPatchSortingDuplicatesAndContiguity(patches);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("CorruptPatchError");
      expect(result.left.dot).toEqual({ author: "a@x", revision: 1 });
    }
  });
});

describe("validateRepository: point ordering short-circuits on the first failure", () => {
  it("a schema failure is reported even when a later point would also fail", () => {
    // Unknown top-level field (point 1) AND an unreachable patch (point 6)
    // are both present; point 1 must win since it runs first.
    const result = validateRepository({
      format: 1,
      frontier: [],
      unknown: true,
      patches: [
        { author: "a@x", revision: 1, base: [], message: "m", changes: [{ type: "text", path: "f", edit: [] }] },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("SchemaValidationError");
    }
  });
});
