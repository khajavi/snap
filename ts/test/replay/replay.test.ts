import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import { decodePatch, type Patch } from "../../src/domain/patch.js";
import { Version } from "../../src/domain/version.js";
import { replay } from "../../src/replay/replay.js";
import type { Tree } from "../../src/replay/integrate.js";
import type { PathState, WarningPair, WarningReason } from "../../src/replay/tiebreak.js";

// Canonical replay end to end (SPEC.md §6.1-§6.2): §6.1 selects and orders
// the target's patches (via replay/select.ts), §6.2 integrates each one
// against its own exact base tree (the replay of the patch's base version,
// threaded by replay/replay.ts), and §6.4 finalizes the warning set.
//
// Every expected order below is hand-traced against §6.1's key 1 — Snap
// order (§3.4) of the ready patches' result versions — which is the
// comparison ts/test/replay/select.test.ts pins: counters are compared over
// the sorted contributor union, and the first unequal counter decides, so
// for two concurrent patches the author whose id sorts FIRST usually holds
// the HIGHER counter there and integrates SECOND (its precheck then sees
// the other patch's paths as current). The namespace regression checkpoint
// below is the wide-`S` reading SPEC.md §6.2 settled on (commit a5aa6e2):
// a path `P` merely EDITS still enters the precheck, so an edit of a
// pre-existing path re-enters the namespace check when a concurrently
// integrated patch replaced that path's neighborhood — instead of falling
// through to §6.4 rule 3 and being dropped as an ordinary delete.

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

/** Builds a `WarningPair` fixture. */
const warning = (raw: string, reason: WarningReason): WarningPair => ({ path: path(raw), reason });

// ---------------------------------------------------------------------------
// Tree snapshots
// ---------------------------------------------------------------------------

type TreeSnapshot = Record<
  string,
  { readonly _tag: "Text"; readonly text: string } | { readonly _tag: "Binary"; readonly bytes: ReadonlyArray<number> }
>;

/** Renders a tree as a plain comparable object: text joined back to bytes, binary as a number array. */
const snapshot = (tree: Tree): TreeSnapshot => {
  const out: Record<
    string,
    | { readonly _tag: "Text"; readonly text: string }
    | { readonly _tag: "Binary"; readonly bytes: ReadonlyArray<number> }
  > = {};
  for (const [treePath, state] of tree) {
    if (state._tag === "Text") {
      out[treePath] = { _tag: "Text", text: state.tokens.join("") };
    } else if (state._tag === "Binary") {
      out[treePath] = { _tag: "Binary", bytes: [...state.bytes] };
    } else {
      // Trees express absence by map absence, so this is a fixture bug.
      throw new Error(`tree contains an explicit Absent state for ${treePath}`);
    }
  }
  return out;
};

/** The `PathState` fixture for the OT seam's return value. */
const textState = (tokens: ReadonlyArray<string>): PathState => ({ _tag: "Text", tokens });

// ---------------------------------------------------------------------------
// Namespace conflicts (SPEC.md §6.2's precheck)
// ---------------------------------------------------------------------------

describe("replay: namespace conflicts across concurrent patches (SPEC.md §6.2)", () => {
  it("regression checkpoint (tests/11-namespace-conflicts.yaml scenario 3): a concurrent edit of a pre-existing path re-enters the namespace precheck and survives an earlier-integrated namespace replacement", () => {
    // Structure of tests/11-namespace-conflicts.yaml's third scenario (as
    // corrected: the replacer is bob@ns and the editor is alice@ns — the
    // author-name assignment §6.1 orders "replacer first, editor last" for
    // this shape; see the next test for the original, pre-correction
    // assignment and why it cannot meet the YAML's assertions). seed@ns
    // creates a/b = "orig\n"; bob@ns (base (seed@ns->1)) deletes a/b and
    // creates file a = "replaced\n" (the namespace replacement); alice@ns
    // (base (seed@ns->1)) edits the pre-existing a/b to "edited\n".
    const seed = makePatch("seed@ns", 1, [], "seed", [
      { type: "text", path: "a/b", edit: [{ insert: ["orig\n"] }] },
    ]);
    const replacer = makePatch("bob@ns", 1, [["seed@ns", 1]], "replace", [
      { type: "text", path: "a", edit: [{ insert: ["replaced\n"] }] },
      { type: "delete", path: "a/b" },
    ]);
    const editor = makePatch("alice@ns", 1, [["seed@ns", 1]], "edit", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["edited\n"] }] },
    ]);

    // §6.1 order of (alice@ns->1,bob@ns->1,seed@ns->1): seed@ns first; then
    // between the concurrent pair, key 1 compares their result versions
    // over the sorted union [alice@ns, bob@ns, seed@ns] — the first unequal
    // counter is alice@ns's, 0 for bob@ns's (bob@ns->1,seed@ns->1) vs 1 for
    // alice@ns's — so the REPLACER (bob@ns) integrates second and the
    // EDITOR (alice@ns) last.
    //
    //   1. seed@ns: B = C = () for a/b, §6.2 case 1 installs "orig\n".
    //   2. bob@ns: B = C = {a/b: "orig\n"}. S = {a} (its create); C' = C
    //      minus the path bob@ns authored as a deletion (a/b) = {}, so no
    //      namespace conflict; both changes are case 1 (B ≡ C) and apply
    //      directly: install a = "replaced\n", delete a/b.
    //   3. alice@ns: B = {a/b: "orig\n"} (her base version's replay, NOT the
    //      running tree), C = {a: "replaced\n"}. S = {a/b} — the wide
    //      reading: an EDIT of a pre-existing path is a present authored
    //      result — and C' = C (she authors no deletion), so a/b's strict
    //      segment ancestor a IS current: the precheck installs a/b as its
    //      authored result "edited\n" and removes a with namespace-wins,
    //      overriding the per-path dispatch (which would otherwise hit
    //      §6.4 rule 3, B present / C absent, and silently drop the edit —
    //      the exact fork the §6.2 correction closed).
    const result = replay(versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"), [
      seed,
      replacer,
      editor,
    ]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        "a/b": { _tag: "Text", text: "edited\n" },
      });
      expect(result.right.warnings).toStrictEqual([warning("a", "namespace-wins")]);
    }
  });

  it("the same scenario with the original author-name assignment (alice@ns replaces, bob@ns edits): §6.1 integrates the editor first, so the replacement resolves per-path instead", () => {
    // The YAML's third scenario as originally authored (before its
    // contributor-role correction): the replacer was alice@ns and the
    // editor bob@ns. §6.1's key 1 orders the EDITOR (bob@ns) second and the
    // REPLACER (alice@ns) last — the same first-unequal-counter comparison
    // select.test.ts pins ("bob integrates first even though alice < bob");
    // the shared seed@ns counter is equal and never decides. The faithful
    // outcome is then:
    //
    //   1. seed@ns: installs a/b = "orig\n".
    //   2. bob@ns (editor): B ≡ C for a/b, case 1 installs "edited\n".
    //   3. alice@ns (replacer): B = {a/b: "orig\n"}, C = {a/b: "edited\n"}.
    //      S = {a} and C' = C minus her own authored deletion a/b = {}, so
    //      no namespace conflict can fire under ANY reading of S (a is
    //      never current at any point of this replay); her create of a is
    //      case 1 (B ≡ C ≡ absent) and installs, while her delete of a/b
    //      reaches §6.4 rule 2 (T absent) and wins with delete-wins.
    //
    // The YAML's asserted expectation (a/b survives with "edited\n", a:
    // namespace-wins) is the previous test's outcome — it requires the
    // REPLACER to integrate before the editor, which §6.1's ordering
    // produces only when the replacer's author name yields the Snap-lesser
    // result version (bob@ns); with the roles on these names it is not
    // reachable, which is why the YAML's contributor roles were corrected
    // to the previous test's assignment.
    const seed = makePatch("seed@ns", 1, [], "seed", [
      { type: "text", path: "a/b", edit: [{ insert: ["orig\n"] }] },
    ]);
    const replacer = makePatch("alice@ns", 1, [["seed@ns", 1]], "replace", [
      { type: "text", path: "a", edit: [{ insert: ["replaced\n"] }] },
      { type: "delete", path: "a/b" },
    ]);
    const editor = makePatch("bob@ns", 1, [["seed@ns", 1]], "edit", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["edited\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"), [
      seed,
      replacer,
      editor,
    ]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        a: { _tag: "Text", text: "replaced\n" },
      });
      expect(result.right.warnings).toStrictEqual([warning("a/b", "delete-wins")]);
    }
  });

  it("YAML scenario 1 in memory: concurrent ancestor-file create vs descendant-file create — the later-integrated ancestor create wins", () => {
    // tests/11-namespace-conflicts.yaml's first scenario: ancestor (alice@x)
    // holds file a = "ancestor\n", descendant (bob@x) holds file a/b =
    // "descendant\n", both from base (); merge expects stderr
    // "warning: auto-resolved a/b: namespace-wins" with a surviving and a/b
    // gone. §6.1 orders bob@x first (his (bob@x->1) is Snap-less at the
    // alice@x counter: 0 < 1), so alice@x's create integrates last and its
    // precheck removes the current descendant a/b.
    const alice = makePatch("alice@x", 1, [], "ancestor", [
      { type: "text", path: "a", edit: [{ insert: ["ancestor\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [], "descendant", [
      { type: "text", path: "a/b", edit: [{ insert: ["descendant\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@x->1,bob@x->1)"), [alice, bob]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        a: { _tag: "Text", text: "ancestor\n" },
      });
      expect(result.right.warnings).toStrictEqual([warning("a/b", "namespace-wins")]);
    }
  });

  it("YAML scenario 2 in memory: the other direction — the later-integrated descendant create wins", () => {
    // tests/11-namespace-conflicts.yaml's second scenario: early-ancestor
    // (bob@x) holds file x = "ancestor\n", late-descendant (alice@x) holds
    // file x/y = "descendant\n"; merge expects stderr "warning:
    // auto-resolved x: namespace-wins" with x/y surviving (x a directory).
    // §6.1 again integrates bob@x first, so alice@x's create of x/y is
    // incoming against current x: its strict segment ancestor x conflicts,
    // installs x/y, and removes x with namespace-wins.
    const bob = makePatch("bob@x", 1, [], "ancestor", [
      { type: "text", path: "x", edit: [{ insert: ["ancestor\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "descendant", [
      { type: "text", path: "x/y", edit: [{ insert: ["descendant\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@x->1,bob@x->1)"), [bob, alice]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        "x/y": { _tag: "Text", text: "descendant\n" },
      });
      expect(result.right.warnings).toStrictEqual([warning("x", "namespace-wins")]);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-path dispatch through full folds
// ---------------------------------------------------------------------------

describe("replay: per-path dispatch (SPEC.md §6.2 cases 1-4, §6.4)", () => {
  it("two sequential patches by one author (create then edit): clean tree, no warnings", () => {
    const create = makePatch("solo@x", 1, [], "create", [
      { type: "text", path: "a/b", edit: [{ insert: ["orig\n"] }] },
    ]);
    const edit = makePatch("solo@x", 2, [["solo@x", 1]], "edit", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["edited\n"] }] },
    ]);

    const result = replay(versionOrThrow("(solo@x->2)"), [create, edit]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        "a/b": { _tag: "Text", text: "edited\n" },
      });
      expect(result.right.warnings).toStrictEqual([]);
    }
  });

  it("concurrent create of the same path by two authors resolves later-create-wins (§6.4 rule 4)", () => {
    // Both patches create the single-segment path f (S-safe: nothing here
    // has an ancestor or descendant, so the namespace precheck never
    // fires). §6.1 integrates bob@x first, so alice@x's create is the
    // canonically-later incoming change: B absent, C and T present — rule 4.
    const alice = makePatch("alice@x", 1, [], "one", [
      { type: "text", path: "f", edit: [{ insert: ["one\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [], "two", [
      { type: "text", path: "f", edit: [{ insert: ["two\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@x->1,bob@x->1)"), [alice, bob]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        f: { _tag: "Text", text: "one\n" },
      });
      expect(result.right.warnings).toStrictEqual([warning("f", "later-create-wins")]);
    }
  });

  it("identical concurrent text edits collapse with no warning and no OT (§6.2 case 2)", () => {
    // seed@ns creates f = "orig\n"; bob@ns and alice@ns concurrently edit
    // it to the same "new\n". §6.1 integrates bob@ns second (case 1, B ≡ C)
    // and alice@ns last, whose B = "orig\n" ≠ C = "new\n" but C ≡ T —
    // §6.2 case 2 keeps C "before OT rather than duplicating their effect".
    // The case-2 check firing first is the point: without it this replay
    // would demand the §6.3 transform and fail with OtUnavailableError.
    const seed = makePatch("seed@ns", 1, [], "seed", [
      { type: "text", path: "f", edit: [{ insert: ["orig\n"] }] },
    ]);
    const bob = makePatch("bob@ns", 1, [["seed@ns", 1]], "edit", [
      { type: "text", path: "f", edit: [{ delete: 1 }, { insert: ["new\n"] }] },
    ]);
    const alice = makePatch("alice@ns", 1, [["seed@ns", 1]], "same edit", [
      { type: "text", path: "f", edit: [{ delete: 1 }, { insert: ["new\n"] }] },
    ]);

    const result = replay(versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"), [seed, bob, alice]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({
        f: { _tag: "Text", text: "new\n" },
      });
      expect(result.right.warnings).toStrictEqual([]);
    }
  });

  it("threads each patch its own exact base tree: a concurrent delete reaches §6.4 rule 2 because B is the base version's replay, not the running tree", () => {
    // seed@ns creates a/b; bob@ns (base seed->1) edits it to "beta\n";
    // alice@ns (base seed->1) deletes it. §6.1 order: seed, bob, alice.
    // alice@ns's base tree is the replay of (seed@ns->1) = {a/b: "orig\n"}
    // — NOT the running canonical tree {a/b: "beta\n"} (§6.2: "materialize
    // its exact base tree B"). With the exact base tree B ≠ C, her delete
    // escapes §6.2 case 1 and resolves by §6.4 rule 2 (T absent → the
    // incoming delete wins) with a delete-wins warning; threading the
    // running tree instead would make B ≡ C, apply the delete silently as
    // case 1, and emit nothing. The warning pins the threading.
    const seed = makePatch("seed@ns", 1, [], "seed", [
      { type: "text", path: "a/b", edit: [{ insert: ["orig\n"] }] },
    ]);
    const editor = makePatch("bob@ns", 1, [["seed@ns", 1]], "edit", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["beta\n"] }] },
    ]);
    const deleter = makePatch("alice@ns", 1, [["seed@ns", 1]], "delete", [
      { type: "delete", path: "a/b" },
    ]);

    const result = replay(versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"), [
      seed,
      editor,
      deleter,
    ]);

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(snapshot(result.right.tree)).toStrictEqual({});
      expect(result.right.warnings).toStrictEqual([warning("a/b", "delete-wins")]);
    }
  });
});

// ---------------------------------------------------------------------------
// The §6.3 OT seam
// ---------------------------------------------------------------------------

describe("replay: the §6.2 case 3 / §6.3 OT seam", () => {
  /** seed@ns creates a/b; bob@ns and alice@ns concurrently edit it to different texts. */
  const concurrentEdits = (): ReadonlyArray<Patch> => [
    makePatch("seed@ns", 1, [], "seed", [
      { type: "text", path: "a/b", edit: [{ insert: ["orig\n"] }] },
    ]),
    // bob@ns's result (bob@ns->1,seed@ns->1) is Snap-less than alice@ns's
    // (alice@ns->1,seed@ns->1) at the alice@ns counter, so bob@ns
    // integrates second and alice@ns last — her edit is the one that hits
    // case 3 against C = {a/b: "beta\n"}.
    makePatch("bob@ns", 1, [["seed@ns", 1]], "beta", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["beta\n"] }] },
    ]),
    makePatch("alice@ns", 1, [["seed@ns", 1]], "alpha", [
      { type: "text", path: "a/b", edit: [{ delete: 1 }, { insert: ["alpha\n"] }] },
    ]),
  ];

  it("concurrent text/text edit on one path with no transform injected fails with OtUnavailableError", () => {
    const result = replay(versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"), concurrentEdits());

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("OtUnavailableError");
      if (result.left._tag === "OtUnavailableError") {
        expect(result.left.path).toBe("a/b");
        expect(result.left.patch).toStrictEqual({ author: "alice@ns", revision: 1 });
      }
    }
  });

  it("the same replay with a transform injected resolves through the seam, which sees B, C, and the incoming edit", () => {
    const calls: Array<{
      readonly path: string;
      readonly base: ReadonlyArray<string>;
      readonly current: ReadonlyArray<string>;
      readonly edit: unknown;
    }> = [];
    // A stand-in for §6.3 (Phase 5 implements the real transform): keep C,
    // dropping the incoming edit. §6.4: "Line OT emits no warning."
    const transform = (
      seamPath: TrackedPath,
      baseTokens: ReadonlyArray<string>,
      currentTokens: ReadonlyArray<string>,
      incomingEdit: unknown,
    ): PathState => {
      calls.push({ path: seamPath, base: [...baseTokens], current: [...currentTokens], edit: incomingEdit });
      return textState(currentTokens);
    };

    const result = replay(
      versionOrThrow("(alice@ns->1,bob@ns->1,seed@ns->1)"),
      concurrentEdits(),
      transform,
    );

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(calls).toStrictEqual([
        {
          path: "a/b",
          base: ["orig\n"],
          current: ["beta\n"],
          edit: [{ delete: 1 }, { insert: ["alpha\n"] }],
        },
      ]);
      expect(snapshot(result.right.tree)).toStrictEqual({
        "a/b": { _tag: "Text", text: "beta\n" },
      });
      expect(result.right.warnings).toStrictEqual([]);
    }
  });
});
