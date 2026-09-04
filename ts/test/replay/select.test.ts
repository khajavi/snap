import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  orderSelectedPatches,
  selectAndOrderPatches,
  selectPatches,
} from "../../src/replay/select.js";
import type { Patch } from "../../src/domain/patch.js";
import { Version } from "../../src/domain/version.js";

// SPEC.md §6.1: "To materialize version V, select every patch (c, n) where
// n <= V[c]. The set must contain every selected patch's base." — then the
// ready-set/Snap-order integration sequence. Every expected order below is
// hand-traced against §6.1's three keys (§3.4 Snap order of result version,
// §3.2 unsigned UTF-8 author order, numeric revision).

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const makePatch = (
  author: string,
  revision: number,
  base: ReadonlyArray<readonly [string, number]>,
): Patch =>
  ({
    author,
    revision,
    base,
    message: "m",
    changes: [{ type: "text", path: "f", edit: [{ insert: ["t\n"] }] }],
  }) as unknown as Patch;

const parseVersionOrThrow = (input: string): Version => {
  const result = Version.parse(input);
  if (Either.isLeft(result)) {
    throw new Error(`test bug: invalid version literal ${input}`);
  }
  return result.right;
};

const dotsOf = (patches: ReadonlyArray<Patch>): ReadonlyArray<readonly [string, number]> =>
  patches.map((patch) => [patch.author, patch.revision] as const);

describe("selectPatches: n <= V[c] selection (SPEC.md §6.1)", () => {
  const chain = [
    makePatch(ALICE, 1, []),
    makePatch(ALICE, 2, [[ALICE, 1]]),
    makePatch(ALICE, 3, [[ALICE, 2]]),
    makePatch(BOB, 1, []),
    makePatch(BOB, 2, [[BOB, 1]]),
  ];

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly patches: ReadonlyArray<Patch>;
    readonly target: string;
    readonly expected: ReadonlyArray<readonly [string, number]>;
  }> = [
    {
      name: "empty repository selects nothing",
      patches: [],
      target: "()",
      expected: [],
    },
    {
      name: "V = () selects nothing even when patches exist",
      patches: chain,
      target: "()",
      expected: [],
    },
    {
      name: "V = (bob->2) selects only bob's chain (alice's component is 0)",
      patches: chain,
      target: `(${BOB}->2)`,
      expected: [
        [BOB, 1],
        [BOB, 2],
      ],
    },
    {
      name: "V = (alice->2) takes alice up to revision 2 and excludes bob entirely",
      patches: chain,
      target: `(${ALICE}->2)`,
      expected: [
        [ALICE, 1],
        [ALICE, 2],
      ],
    },
    {
      name: "patches beyond a component of V are excluded per component",
      patches: chain,
      target: `(${ALICE}->3,${BOB}->1)`,
      expected: [
        [ALICE, 1],
        [ALICE, 2],
        [ALICE, 3],
        [BOB, 1],
      ],
    },
    {
      name: "V covering every component selects everything, in repository order",
      patches: chain,
      target: `(${ALICE}->3,${BOB}->2)`,
      expected: [
        [ALICE, 1],
        [ALICE, 2],
        [ALICE, 3],
        [BOB, 1],
        [BOB, 2],
      ],
    },
  ];

  it.each(cases)("$name", ({ patches, target, expected }) => {
    const result = selectPatches(parseVersionOrThrow(target), patches);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual(expected);
    }
  });

  it("errors when a base dot is beyond a component of V (missing from the selected set)", () => {
    // V = (bob->1) selects only bob's patch, whose base names (alice, 1);
    // V's alice component is 0, so (alice, 1) is NOT selected — the selected
    // set does not contain every selected patch's base (SPEC.md §6.1), i.e.
    // V is not a version this repository knows (SPEC.md §4.1).
    const patches = [makePatch(ALICE, 1, []), makePatch(BOB, 1, [[ALICE, 1]])];
    const result = selectPatches(parseVersionOrThrow(`(${BOB}->1)`), patches);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("IncompleteBaseClosureError");
      expect(result.left.patch).toStrictEqual({ author: BOB, revision: 1 });
      expect(result.left.missingBaseDot).toStrictEqual({ author: ALICE, revision: 1 });
    }
  });

  it("errors when a selected patch's base dot has no patch at all", () => {
    const patches = [makePatch(ALICE, 2, [[ALICE, 1]])];
    const result = selectPatches(parseVersionOrThrow(`(${ALICE}->2)`), patches);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("IncompleteBaseClosureError");
      expect(result.left.missingBaseDot).toStrictEqual({ author: ALICE, revision: 1 });
    }
  });
});

describe("selectAndOrderPatches: ready-set integration ordering (SPEC.md §6.1)", () => {
  it("sequences a single-contributor linear chain in revision order", () => {
    const patches = [
      makePatch(ALICE, 1, []),
      makePatch(ALICE, 2, [[ALICE, 1]]),
      makePatch(ALICE, 3, [[ALICE, 2]]),
    ];
    const result = selectAndOrderPatches(parseVersionOrThrow(`(${ALICE}->3)`), patches);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual([
        [ALICE, 1],
        [ALICE, 2],
        [ALICE, 3],
      ]);
    }
  });

  it("orders two concurrent base-() patches by key 1 (Snap order of result version)", () => {
    // Hand trace: alice's result version is (alice->1), bob's is (bob->1).
    // Snap order (§3.4) compares counters over the sorted contributor union
    // [alice, bob]; the first unequal counter is alice's — 1 for alice's
    // result, 0 for bob's — so (bob->1) is Snap-LESS. Bob integrates first,
    // even though "alice" < "bob" in unsigned UTF-8 order: key 1 decides,
    // key 2 never fires.
    const patches = [makePatch(ALICE, 1, []), makePatch(BOB, 1, [])];
    const result = selectAndOrderPatches(
      parseVersionOrThrow(`(${ALICE}->1,${BOB}->1)`),
      patches,
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual([
        [BOB, 1],
        [ALICE, 1],
      ]);
    }
  });

  it("key 1 dominates author order from the other side too (b@x before a@x)", () => {
    // Mirror of the previous case: b@x's result is (b@x->1), a@x's is
    // (a@x->1); the sorted union is [a@x, b@x] and the first unequal
    // counter is a@x's — 0 for b@x's result — so b@x integrates first.
    const patches = [makePatch("a@x", 1, []), makePatch("b@x", 1, [])];
    const result = selectAndOrderPatches(parseVersionOrThrow("(a@x->1,b@x->1)"), patches);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual([
        ["b@x", 1],
        ["a@x", 1],
      ]);
    }
  });

  it("recomputes the ready set each round; concurrent results still decide at key 1", () => {
    // History: A1 and B1 from the empty tree; A2 and B2 both based on
    // (alice->1,bob->1), so A2 and B2 are concurrent with each other.
    // Round by round:
    //   1. ready {A1, B1}: results (alice->1) vs (bob->1) — at the alice
    //      component, 1 vs 0 — bob's is Snap-less, so B1 integrates first.
    //   2. ready {A1} alone: A1.
    //   3. ready {A2, B2}: results (alice->2,bob->1) vs (alice->1,bob->2)
    //      — first unequal counter is alice's, 2 vs 1 — B2's result is
    //      Snap-less, so B2.
    //   4. A2 alone.
    const patches = [
      makePatch(ALICE, 1, []),
      makePatch(ALICE, 2, [
        [ALICE, 1],
        [BOB, 1],
      ]),
      makePatch(BOB, 1, []),
      makePatch(BOB, 2, [
        [ALICE, 1],
        [BOB, 1],
      ]),
    ];
    const result = selectAndOrderPatches(
      parseVersionOrThrow(`(${ALICE}->2,${BOB}->2)`),
      patches,
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual([
        [BOB, 1],
        [ALICE, 1],
        [BOB, 2],
        [ALICE, 2],
      ]);
    }
  });

  it("orderSelectedPatches does not depend on the input array's order", () => {
    // The same history as the previous case, handed over in a scrambled
    // order: the three §6.1 keys are a total order over distinct dots, so
    // the sequence is identical.
    const patches = [
      makePatch(ALICE, 2, [
        [ALICE, 1],
        [BOB, 1],
      ]),
      makePatch(BOB, 1, []),
      makePatch(BOB, 2, [
        [ALICE, 1],
        [BOB, 1],
      ]),
      makePatch(ALICE, 1, []),
    ];
    const result = orderSelectedPatches(patches);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(dotsOf(result.right)).toStrictEqual([
        [BOB, 1],
        [ALICE, 1],
        [BOB, 2],
        [ALICE, 2],
      ]);
    }
  });

  it("errors with ReplayNotReadyError when a selected patch's base is not in the set", () => {
    // (alice, 1) has no patch in this set, so (alice, 2) is never ready:
    // a missing dependency (SPEC.md §6.1's stall).
    const result = orderSelectedPatches([makePatch(ALICE, 2, [[ALICE, 1]])]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ReplayNotReadyError");
      expect(result.left.unreachable).toStrictEqual([{ author: ALICE, revision: 2 }]);
    }
  });

  it("errors with ReplayNotReadyError on a base cycle", () => {
    // Each patch names the other's dot as its base, so neither is ever
    // ready: a cycle (SPEC.md §6.1's stall).
    const result = orderSelectedPatches([
      makePatch("a@x", 1, [["b@x", 1]]),
      makePatch("b@x", 1, [["a@x", 1]]),
    ]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ReplayNotReadyError");
      expect(result.left.unreachable).toStrictEqual([
        { author: "a@x", revision: 1 },
        { author: "b@x", revision: 1 },
      ]);
    }
  });

  it("surfaces the selection error for a version the repository does not know", () => {
    // V = (alice->1,bob->1) selects bob's patch, whose base names
    // (alice, 2) — beyond V's alice component — so the selected set strands
    // a base and selection fails before any ordering.
    const patches = [
      makePatch(ALICE, 1, []),
      makePatch(ALICE, 2, [[ALICE, 1]]),
      makePatch(BOB, 1, [[ALICE, 2]]),
    ];
    const result = selectAndOrderPatches(
      parseVersionOrThrow(`(${ALICE}->1,${BOB}->1)`),
      patches,
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result) && result.left._tag === "IncompleteBaseClosureError") {
      expect(result.left.missingBaseDot).toStrictEqual({ author: ALICE, revision: 2 });
    } else {
      expect.fail("expected an IncompleteBaseClosureError");
    }
  });

  it("sequences nothing for an empty repository", () => {
    const result = selectAndOrderPatches(Version.empty, []);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toStrictEqual([]);
    }
  });

  it("selects and sequences nothing for V = () even when patches exist", () => {
    const result = selectAndOrderPatches(Version.empty, [
      makePatch(ALICE, 1, []),
      makePatch(BOB, 1, []),
    ]);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toStrictEqual([]);
    }
  });
});
