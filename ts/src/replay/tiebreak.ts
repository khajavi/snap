/**
 * SPEC.md §6.4's path-level tie-break rules, the per-path state model they
 * resolve, and the warning-pair finalization §6.4 defines for the whole
 * replay ("Replay returns the set of unique warning pairs sorted by path,
 * then reason").
 *
 * §6.2 dispatches here per changed path ("Otherwise use §6.4's path-level
 * rules") only after its own earlier cases miss: case 1 (path identical in
 * `B` and `C` — apply the authored change directly), case 2 (path identical
 * in `C` and `T`), and case 3 (the all-text OT case of §6.3). §6.4's own
 * numbered list is nonetheless total and self-contained — its rule 1
 * restates §6.2 case 2 — so `replay/integrate.ts` (a later phase) can call
 * `tiebreakPath` for every path its cases 1 and 3 do not settle without
 * re-implementing any of §6.4's ordering.
 *
 * Everything here is pure and synchronous, and the rules are total over
 * their inputs, so — like `domain/diff.ts` and `domain/text.ts` — these
 * functions return plain values, not `Either`. "Later" is always canonical
 * integration order (§6.4: "'Later' always means canonical integration
 * order, never wall-clock time"): the caller has already fixed which
 * change is the incoming one by the order it integrates patches (§6.1), so
 * nothing here consults a clock.
 */

import { compareTrackedPaths, type TrackedPath } from "../domain/path.js";
import type { Change } from "../domain/patch.js";
import { classify, type Token } from "../domain/text.js";

// ---------------------------------------------------------------------------
// Per-path state (SPEC.md §6.2's B/C/T values)
// ---------------------------------------------------------------------------

/**
 * One path's state in a tree: absent, present as text, or present as
 * binary. Text reuses `domain/text.ts`'s representation — the canonical
 * token sequence, which is lossless for text content (joining the tokens
 * and re-encoding UTF-8 reproduces the bytes); binary keeps the raw bytes,
 * the only representation binary content has. The `_tag` naming mirrors
 * `Classification`'s, with the absent case added.
 *
 * An empty text file is `Text` with zero tokens — present, and therefore
 * distinct from `Absent`.
 *
 * Exported for `replay/integrate.ts` (a later phase), which builds the
 * `B`/`C`/`T` states for each changed path and hands them to `tiebreakPath`.
 */
export type PathState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Text"; readonly tokens: ReadonlyArray<Token> }
  | { readonly _tag: "Binary"; readonly bytes: Uint8Array };

/**
 * The incoming change's variant (SPEC.md §4.3's three), consulted by rule 5.
 * Derived from `Change`'s own union rather than re-declared so the two
 * cannot drift apart.
 */
export type ChangeVariant = Change["type"];

/**
 * Builds a present path state from raw content bytes by classifying them
 * once through `domain/text.ts`'s `classify` (§4.4): text bytes become
 * their canonical token sequence, anything else stays binary. This is how a
 * `put` change's decoded content becomes a `PathState` — classification
 * decides text-vs-binary in exactly one place.
 */
export const pathStateFromBytes = (bytes: Uint8Array): PathState => {
  const classification = classify(bytes);
  return classification._tag === "Text"
    ? { _tag: "Text", tokens: classification.tokens }
    : { _tag: "Binary", bytes };
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality of two path states: same presence and same content
 * (element-wise token equality for text, byte equality for binary). This is
 * §6.4 rule 1's "identical" (and, in the dispatch above it, §6.2 case 1's
 * "identical in `B` and `C`" and case 2's "identical in `C` and `T`").
 * Exported because `replay/integrate.ts` needs those two §6.2 checks too.
 */
export const pathStatesEqual = (a: PathState, b: PathState): boolean => {
  if (a._tag !== b._tag) {
    return false;
  }
  if (a._tag === "Text" && b._tag === "Text") {
    if (a.tokens.length !== b.tokens.length) {
      return false;
    }
    for (let i = 0; i < a.tokens.length; i++) {
      if (a.tokens[i] !== b.tokens[i]) {
        return false;
      }
    }
    return true;
  }
  if (a._tag === "Binary" && b._tag === "Binary") {
    return bytesEqual(a.bytes, b.bytes);
  }
  return true; // Both absent.
};

// ---------------------------------------------------------------------------
// Warning pairs (SPEC.md §6.4's format line)
// ---------------------------------------------------------------------------

/**
 * §6.4's warning reasons, from its format line
 * `(<path>, <delete-wins|later-create-wins|later-put-wins|namespace-wins|put-wins>)`.
 * The rules below produce only four of them (`delete-wins` by rules 2 and
 * 3, `later-create-wins` by rule 4, `later-put-wins` by rule 5, `put-wins`
 * by rule 6); `namespace-wins` is §6.2's namespace-precheck reason and
 * belongs to the same union because the whole replay's warning set —
 * precheck pairs included — flows through the same `WarningPair` shape and
 * the same `finalizeWarningPairs`.
 */
export type WarningReason =
  | "delete-wins"
  | "later-create-wins"
  | "later-put-wins"
  | "namespace-wins"
  | "put-wins";

/** One §6.4 warning pair: `(<path>, <reason>)`. */
export interface WarningPair {
  readonly path: TrackedPath;
  readonly reason: WarningReason;
}

/**
 * §6.4's finalization: "Replay returns the set of unique warning pairs
 * sorted by path, then reason." Deduplicates exact `(path, reason)` repeats
 * (§6.2: "duplicate removals and warnings collapse"), then sorts by path in
 * unsigned UTF-8 byte order (`compareTrackedPaths`, §2) and, within one
 * path, by reason in plain string order. Which copy of a duplicate survives
 * is unobservable — a duplicate re-announces exactly the same pair.
 */
export function finalizeWarningPairs(
  pairs: ReadonlyArray<WarningPair>,
): ReadonlyArray<WarningPair> {
  const seen = new Set<string>();
  const unique: WarningPair[] = [];
  for (const pair of pairs) {
    // A tracked path cannot contain NUL (SPEC §2 forbids ASCII control
    // characters), and no reason contains it either, so a NUL separator
    // makes the key unambiguous.
    const key = `${pair.path}\u0000${pair.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(pair);
    }
  }
  unique.sort((a, b) => {
    const byPath = compareTrackedPaths(a.path, b.path);
    if (byPath !== 0) {
      return byPath;
    }
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });
  return unique;
}

// ---------------------------------------------------------------------------
// §6.4's six rules, in order
// ---------------------------------------------------------------------------

/** One §6.4 evaluation: the three per-path states plus the incoming change's variant. */
export interface TiebreakInput {
  /** The path being resolved; names the warning pair when a rule fires. */
  readonly path: TrackedPath;
  /** `B`: the path's state in the incoming patch's exact base tree (§6.2). */
  readonly base: PathState;
  /** `C`: the path's state in the canonical tree built so far (§6.2). */
  readonly current: PathState;
  /** `T`: the incoming change's authored result for the path (§6.2). */
  readonly incoming: PathState;
  /**
   * The incoming change's variant (§4.3). Only rules 5 and 6 consult it —
   * a `delete` change's `T` is absent by construction (§4.3: applying a
   * delete removes the path), so rule 2 is what a delete normally hits.
   */
  readonly incomingVariant: ChangeVariant;
}

/** One §6.4 outcome: the resolved state, plus the warning pair iff a rule 2-6 fired. */
export interface TiebreakResult {
  readonly state: PathState;
  /** Present iff one of rules 2-6 fired; rule 1 emits no warning. */
  readonly warning: WarningPair | undefined;
}

/**
 * Resolves one changed path per §6.4's six rules, in order, given base
 * state `B`, current canonical state `C`, and incoming authored result `T`:
 *
 *   1. `C` and `T` identical — keep `C`, no warning.
 *   2. `T` absent — incoming delete wins (`delete-wins`).
 *   3. `B` present, `C` absent — earlier concurrent delete wins
 *      (`delete-wins`).
 *   4. `B` absent, `C` and `T` present — incoming (canonically later)
 *      create wins (`later-create-wins`).
 *   5. Incoming change is `put` — incoming atomic replacement wins
 *      (`later-put-wins`).
 *   6. Otherwise (incoming is text, current is non-text) — incompatible
 *      current content wins (`put-wins`).
 *
 * The rules are total, so every input yields a result; combinations the
 * §6.2 dispatch never produces still resolve by this literal order (e.g.
 * `B` and `C` both absent with `T` present falls through rules 2-4 to rule
 * 5/6 — in the pipeline §6.2 case 1 would have applied such a creation
 * directly long before reaching here).
 */
export function tiebreakPath(input: TiebreakInput): TiebreakResult {
  const { path, base, current, incoming, incomingVariant } = input;

  const resolve = (state: PathState, reason: WarningReason): TiebreakResult => ({
    state,
    warning: { path, reason },
  });

  // Rule 1: "If `C` and `T` are identical, keep `C` and emit no warning."
  if (pathStatesEqual(current, incoming)) {
    return { state: current, warning: undefined };
  }

  // Rule 2: "If `T` is absent, the incoming delete wins (`delete-wins`)."
  if (incoming._tag === "Absent") {
    return resolve(incoming, "delete-wins");
  }

  // Rule 3: "If `B` is present and `C` is absent, the earlier concurrent
  // delete wins (`delete-wins`)." (`T` is present here; rule 2 returned.)
  if (base._tag !== "Absent" && current._tag === "Absent") {
    return resolve(current, "delete-wins");
  }

  // Rule 4: "If `B` is absent and `C` and `T` are present, the incoming
  // (canonically later) create wins (`later-create-wins`)." (`T` is
  // present here; rule 2 returned.)
  if (base._tag === "Absent" && current._tag !== "Absent") {
    return resolve(incoming, "later-create-wins");
  }

  // Rule 5: "If the incoming change is `put`, the incoming atomic
  // replacement wins (`later-put-wins`)."
  if (incomingVariant === "put") {
    return resolve(incoming, "later-put-wins");
  }

  // Rule 6: "Otherwise `P` is text and `C` is non-text, so the incompatible
  // current content wins (`put-wins`)."
  return resolve(current, "put-wins");
}
