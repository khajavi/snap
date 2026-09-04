import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import {
  finalizeWarningPairs,
  pathStateFromBytes,
  pathStatesEqual,
  tiebreakPath,
  type ChangeVariant,
  type PathState,
  type WarningPair,
  type WarningReason,
} from "../../src/replay/tiebreak.js";

// SPEC.md §6.4's six path-level rules exercised one per rule (plus
// rule-precedence pins and mixed text/binary states for rules 4/5/6), the
// per-path state model's equality, and §6.4's warning-set finalization
// ("the set of unique warning pairs sorted by path, then reason").
//
// Most rows keep `B` and `C` different: in the real replay (§6.2) a path
// identical in `B` and `C` is settled by case 1 ("apply the authored change
// directly") before §6.4 is ever consulted, so `B ≡ C` rows here would
// document a combination the pipeline never produces. The one deliberate
// exception (rule 6's fall-through row) says so in its name.

/** Builds a validated `TrackedPath` fixture (fails loudly on a bad fixture). */
const path = (raw: string): TrackedPath => {
  const result = parseTrackedPath(raw);
  if (Either.isLeft(result)) {
    throw new Error(`fixture path is not a valid tracked path: ${raw}`);
  }
  return result.right;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const text = (tokens: ReadonlyArray<string>): PathState => ({ _tag: "Text", tokens });
const binary = (bytes: Uint8Array): PathState => ({ _tag: "Binary", bytes });

const P = path("f.txt");

const ABSENT: PathState = { _tag: "Absent" };
const BASE_TEXT = text(["base\n"]);
const CURRENT_TEXT = text(["current\n"]);
const INCOMING_TEXT = text(["incoming\n"]);
const CURRENT_BINARY = binary(new Uint8Array([0x00, 0xff]));
const INCOMING_BINARY = binary(new Uint8Array([0xff]));
const EMPTY_TEXT = text([]);

// ---------------------------------------------------------------------------
// The path-state model
// ---------------------------------------------------------------------------

describe("pathStatesEqual: rule 1's 'identical'", () => {
  it.each<[string, PathState, PathState, boolean]>([
    ["both absent", ABSENT, ABSENT, true],
    ["an empty text file is present, not absent", EMPTY_TEXT, ABSENT, false],
    ["equal token sequences (distinct arrays) are identical", text(["a\n", "b\n"]), text(["a\n", "b\n"]), true],
    ["different token sequences are not identical", text(["a\n"]), text(["b\n"]), false],
    ["equal byte sequences (distinct arrays) are identical", binary(utf8("\x01\x02")), binary(utf8("\x01\x02")), true],
    ["binary differing only in length is not identical", binary(utf8("\x01")), binary(utf8("\x01\x02")), false],
    ["binary of equal length with different bytes is not identical", binary(utf8("\x01\x02")), binary(utf8("\x01\x03")), false],
    ["text and binary are never identical, even when the bytes would decode to the same text", text(["a\n"]), binary(utf8("a\n")), false],
  ])("%s", (_name, a, b, expected) => {
    expect(pathStatesEqual(a, b)).toBe(expected);
    expect(pathStatesEqual(b, a)).toBe(expected); // symmetric
  });
});

describe("pathStateFromBytes", () => {
  it("classifies text bytes into their canonical token sequence", () => {
    expect(pathStateFromBytes(utf8("a\nb\n"))).toEqual({ _tag: "Text", tokens: ["a\n", "b\n"] });
  });

  it("classifies the empty file as text with zero tokens", () => {
    expect(pathStateFromBytes(new Uint8Array([]))).toEqual({ _tag: "Text", tokens: [] });
  });

  it("keeps non-text bytes as binary, preserving the bytes", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80]);
    expect(pathStateFromBytes(bytes)).toEqual({ _tag: "Binary", bytes });
  });
});

// ---------------------------------------------------------------------------
// The six rules (SPEC.md §6.4), in order
// ---------------------------------------------------------------------------

describe("tiebreakPath: SPEC.md §6.4's six rules, in order", () => {
  type RuleCase = [string, PathState, PathState, PathState, ChangeVariant, PathState, WarningReason | undefined];

  it.each<RuleCase>([
    // Rule 1: "If C and T are identical, keep C and emit no warning."
    ["rule 1: C and T identical text keeps C with no warning", BASE_TEXT, CURRENT_TEXT, CURRENT_TEXT, "text", CURRENT_TEXT, undefined],
    ["rule 1: C and T identical binary keeps C with no warning (fires before rule 5)", BASE_TEXT, CURRENT_BINARY, CURRENT_BINARY, "put", CURRENT_BINARY, undefined],
    ["rule 1 fires before rule 2 when C and T are both absent — nothing is left to delete", BASE_TEXT, ABSENT, ABSENT, "delete", ABSENT, undefined],
    // Rule 2: "If T is absent, the incoming delete wins (delete-wins)."
    ["rule 2: incoming delete (T absent) removes the path with delete-wins", BASE_TEXT, CURRENT_TEXT, ABSENT, "delete", ABSENT, "delete-wins"],
    ["rule 2: deleting an empty text file still warns — empty text is present, not absent", BASE_TEXT, EMPTY_TEXT, ABSENT, "delete", ABSENT, "delete-wins"],
    // Rule 3: "If B is present and C is absent, the earlier concurrent delete
    // wins (delete-wins)."
    ["rule 3: earlier concurrent delete (B present, C absent) beats an incoming text result", BASE_TEXT, ABSENT, INCOMING_TEXT, "text", ABSENT, "delete-wins"],
    ["rule 3 fires before rule 5: a put against a concurrently deleted path loses with delete-wins", BASE_TEXT, ABSENT, INCOMING_BINARY, "put", ABSENT, "delete-wins"],
    // Rule 4: "If B is absent and C and T are present, the incoming
    // (canonically later) create wins (later-create-wins)."
    ["rule 4: concurrent creates (B absent, C and T present) — incoming create wins", ABSENT, CURRENT_TEXT, INCOMING_TEXT, "text", INCOMING_TEXT, "later-create-wins"],
    ["rule 4: incoming text create beats a concurrent binary create", ABSENT, CURRENT_BINARY, INCOMING_TEXT, "text", INCOMING_TEXT, "later-create-wins"],
    ["rule 4 fires before rule 5: a put onto a concurrently created path resolves as later-create-wins, not later-put-wins", ABSENT, CURRENT_TEXT, INCOMING_BINARY, "put", INCOMING_BINARY, "later-create-wins"],
    // Rule 5: "If the incoming change is put, the incoming atomic replacement
    // wins (later-put-wins)."
    ["rule 5: incoming put atomically replaces concurrent text content with later-put-wins", BASE_TEXT, CURRENT_TEXT, INCOMING_BINARY, "put", INCOMING_BINARY, "later-put-wins"],
    ["rule 5: incoming put of text content replaces a concurrent binary put with later-put-wins", BASE_TEXT, CURRENT_BINARY, INCOMING_TEXT, "put", INCOMING_TEXT, "later-put-wins"],
    // Rule 6: "Otherwise P is text and C is non-text, so the incompatible
    // current content wins (put-wins)."
    ["rule 6: incoming text edit against concurrent binary content — current binary wins with put-wins", BASE_TEXT, CURRENT_BINARY, INCOMING_TEXT, "text", CURRENT_BINARY, "put-wins"],
    ["rule 6: a text T against absent C keeps C with put-wins — pipeline-unreachable, since §6.2 case 1 applies a creation onto B ≡ C directly; pins the literal rule order", ABSENT, ABSENT, INCOMING_TEXT, "text", ABSENT, "put-wins"],
  ])("%s", (_name, base, current, incoming, incomingVariant, expectedState, expectedReason) => {
    const result = tiebreakPath({ path: P, base, current, incoming, incomingVariant });
    expect(result.state).toEqual(expectedState);
    if (expectedReason === undefined) {
      expect(result.warning).toBeUndefined();
    } else {
      expect(result.warning).toEqual({ path: P, reason: expectedReason });
    }
  });
});

// ---------------------------------------------------------------------------
// Warning-set finalization (SPEC.md §6.4)
// ---------------------------------------------------------------------------

describe("finalizeWarningPairs: 'the set of unique warning pairs sorted by path, then reason'", () => {
  const pair = (raw: string, reason: WarningReason): WarningPair => ({ path: path(raw), reason });

  it("returns an empty set for no warnings", () => {
    expect(finalizeWarningPairs([])).toEqual([]);
  });

  it("deduplicates exact (path, reason) repeats (§6.2: 'duplicate removals and warnings collapse')", () => {
    const result = finalizeWarningPairs([
      pair("b.txt", "put-wins"),
      pair("a.txt", "delete-wins"),
      pair("b.txt", "put-wins"),
    ]);
    expect(result).toEqual([pair("a.txt", "delete-wins"), pair("b.txt", "put-wins")]);
  });

  it("keeps same-path pairs with different reasons distinct, sorted by reason", () => {
    const reasons: ReadonlyArray<WarningReason> = [
      "put-wins",
      "delete-wins",
      "later-put-wins",
      "namespace-wins",
      "later-create-wins",
    ];
    const result = finalizeWarningPairs(reasons.map((reason) => pair("a.txt", reason)));
    expect(result.map((p) => p.reason)).toEqual([
      "delete-wins",
      "later-create-wins",
      "later-put-wins",
      "namespace-wins",
      "put-wins",
    ]);
  });

  it("sorts by path in unsigned UTF-8 byte order, not UTF-16 code-unit order", () => {
    // "\uE000" encodes as EE 80 80 and U+1F600 as F0 9F 98 80, so byte order
    // is "a" < "\uE000" < U+1F600 — while JS `<` (UTF-16 code units) orders
    // the surrogate-led emoji string first. Assert the divergence so this
    // test genuinely pins byte order rather than re-stating sort()'s default.
    const emojiFirstByUtf16 = "\uD83D\uDE00" < "\uE000";
    expect(emojiFirstByUtf16).toBe(true);
    const result = finalizeWarningPairs([
      pair("\uD83D\uDE00", "put-wins"),
      pair("\uE000", "put-wins"),
      pair("a", "put-wins"),
    ]);
    expect(result.map((p) => p.path)).toEqual(["a", "\uE000", "\uD83D\uDE00"]);
  });

  it("deduplicates and sorts a mixed warning set, including §6.2's namespace-wins pairs", () => {
    const result = finalizeWarningPairs([
      pair("z.txt", "delete-wins"),
      pair("a/b.txt", "namespace-wins"),
      pair("a.txt", "put-wins"),
      pair("a.txt", "put-wins"),
      pair("a.txt", "delete-wins"),
    ]);
    expect(result).toEqual([
      // "a.txt" < "a/b.txt": "." (0x2E) sorts before "/" (0x2F) in byte order.
      pair("a.txt", "delete-wins"),
      pair("a.txt", "put-wins"),
      pair("a/b.txt", "namespace-wins"),
      pair("z.txt", "delete-wins"),
    ]);
  });
});
