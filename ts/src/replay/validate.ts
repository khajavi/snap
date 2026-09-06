/**
 * The full repository validation pipeline, SPEC.md §4.5's six points, run
 * in order:
 *
 *   1. schema validation                          -- FULLY IMPLEMENTED
 *   2. sorting, one value per dot, contiguity      -- FULLY IMPLEMENTED
 *   3. base closure and the revision formula       -- FULLY IMPLEMENTED
 *   4. acyclic causality                           -- FULLY IMPLEMENTED
 *   5. every change against its materialized base  -- FULLY IMPLEMENTED
 *   6. deterministic replay of the declared        -- FULLY IMPLEMENTED,
 *      frontier                                       structurally (see below)
 *
 * Point 6's "structurally" qualifier matters: SPEC's own closing
 * paragraph for §4.5 --- "If no ready patch remains before replay is
 * complete, the history has a cycle or missing dependency" --- describes
 * exactly a topological (Kahn's-algorithm) consumption of the
 * base-dependency graph, which needs no patch *content* at all, only the
 * graph of `(author, revision) -> base dots` edges every patch already
 * carries. This module implements that consumption directly
 * (`simulateReadySetConsumption`) rather than deferring it, since it is
 * genuinely computable now -- unlike the *general* case of point 5, which
 * needs the actual materialized tree (Phase 4/5's replay machinery).
 *
 * Point 5 is now fully implemented (Phases 4-5 landed the replay
 * machinery it needed): each patch's exact base tree is materialized by
 * `replay/replay.ts`'s canonical replay of the patch's base version, and
 * every change is checked against it per SPEC §4.3's rules (existence,
 * no-op, and — for text edits — old-token consumption and canonical
 * result). Replay failures on a base version (a stranded base, a stall)
 * are NOT reported here: points 3/4/6 own those conditions, and point 5
 * runs before point 6, so reporting a replay-structure failure first
 * could reorder which condition the suite's pinned diagnostics name.
 */

import { Either } from "effect";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { applyEditScript, type EditScript } from "../domain/diff.js";
import { compareContributorIds } from "../domain/contributor.js";
import { revisionOfVersionPairs, type Change, type Dot, type Patch } from "../domain/patch.js";
import { isCanonicalTokenSequence } from "../domain/text.js";
import {
  causalClosureOf,
  decodeRepository,
  dotKey,
  indexPatchesByDot,
  type DotKey,
  type Repository,
} from "../domain/repository.js";
import {
  ChangeBaseConflictError,
  CorruptPatchError,
  CyclicCausalityError,
  DuplicatePatchError,
  IncompleteBaseClosureError,
  InvalidRevisionFormulaError,
  NonContiguousRevisionError,
  ReplayNotReadyError,
  SchemaValidationError,
  UnknownFrontierDotError,
  UnreachablePatchError,
  UnsortedPatchesError,
  type DotRef,
} from "../errors/domain-errors.js";
import type { Tree } from "./integrate.js";
import { replay, versionOfPairs } from "./replay.js";
import { pathStateFromBytes, pathStatesEqual, type PathState } from "./tiebreak.js";

/** The union of every error `validateRepository` (points 1-4, 5's partial case, and 6) can produce. */
export type RepositoryValidationError =
  | SchemaValidationError
  | UnsortedPatchesError
  | DuplicatePatchError
  | CorruptPatchError
  | NonContiguousRevisionError
  | IncompleteBaseClosureError
  | InvalidRevisionFormulaError
  | CyclicCausalityError
  | ChangeBaseConflictError
  | UnknownFrontierDotError
  | UnreachablePatchError
  | ReplayNotReadyError;

function toDotRef(dot: Dot): DotRef {
  return { author: dot.author, revision: dot.revision };
}

function comparePatchDots(a: Patch, b: Patch): -1 | 0 | 1 {
  const cmp = compareContributorIds(a.author, b.author);
  if (cmp !== 0) return cmp;
  return a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Point 2: patch sorting, one value per dot, contiguous revisions
// ---------------------------------------------------------------------------

/**
 * SPEC §4.1: "`patches` contains exactly the causal closure of
 * `frontier`, sorted by author and then numeric revision." SPEC §4.2:
 * "Patches with the same dot are duplicates only when their parsed typed
 * values are structurally equal. Different values at one dot are
 * corruption." SPEC §3.5: "For each contributor, revision `n` has
 * exactly one patch and follows revision `n-1`."
 */
export function checkPatchSortingDuplicatesAndContiguity(
  patches: ReadonlyArray<Patch>,
): Either.Either<
  void,
  UnsortedPatchesError | DuplicatePatchError | CorruptPatchError | NonContiguousRevisionError
> {
  for (let i = 1; i < patches.length; i++) {
    const previous = patches[i - 1]!;
    const current = patches[i]!;
    const cmp = comparePatchDots(previous, current);
    if (cmp > 0) {
      return Either.left(new UnsortedPatchesError({ dot: toDotRef(current) }));
    }
    if (cmp === 0) {
      return Either.left(
        isDeepStrictEqual(previous, current)
          ? new DuplicatePatchError({ dot: toDotRef(current) })
          : new CorruptPatchError({ dot: toDotRef(current) }),
      );
    }
  }

  const lastRevisionByAuthor = new Map<string, number>();
  for (const patch of patches) {
    const expected = (lastRevisionByAuthor.get(patch.author) ?? 0) + 1;
    if (patch.revision !== expected) {
      return Either.left(
        new NonContiguousRevisionError({ dot: toDotRef(patch), expectedRevision: expected }),
      );
    }
    lastRevisionByAuthor.set(patch.author, patch.revision);
  }

  return Either.right(undefined);
}

// ---------------------------------------------------------------------------
// Point 3: complete base closure and the revision formula
// ---------------------------------------------------------------------------

/**
 * SPEC §4.5 point 3: "every patch's complete base closure and `revision
 * = base[author] + 1`." Checked per patch against the full indexed
 * `patches` set (already established sorted/unique/contiguous by point
 * 2, so `byDot` is well-formed).
 */
export function checkBaseClosureAndRevisionFormula(
  patches: ReadonlyArray<Patch>,
  byDot: ReadonlyMap<DotKey, Patch>,
): Either.Either<void, IncompleteBaseClosureError | InvalidRevisionFormulaError> {
  for (const patch of patches) {
    for (const [baseAuthor, baseRevision] of patch.base) {
      if (baseRevision > 0 && !byDot.has(dotKey(baseAuthor, baseRevision))) {
        return Either.left(
          new IncompleteBaseClosureError({
            patch: toDotRef(patch),
            missingBaseDot: { author: baseAuthor, revision: baseRevision },
          }),
        );
      }
    }

    const expectedRevision = revisionOfVersionPairs(patch.base, patch.author) + 1;
    if (patch.revision !== expectedRevision) {
      return Either.left(
        new InvalidRevisionFormulaError({ patch: toDotRef(patch), expectedRevision }),
      );
    }
  }

  return Either.right(undefined);
}

// ---------------------------------------------------------------------------
// Point 4: acyclic causality
// ---------------------------------------------------------------------------

/**
 * SPEC §4.5 point 4: "acyclic causality." A depth-first walk of the
 * base-dependency graph (patch -> each of its base dots) with the usual
 * white/gray/black coloring; a "gray" dot revisited mid-walk is a cycle
 * witness.
 */
export function checkAcyclicCausality(
  patches: ReadonlyArray<Patch>,
  byDot: ReadonlyMap<DotKey, Patch>,
): Either.Either<void, CyclicCausalityError> {
  const state = new Map<DotKey, "visiting" | "done">();
  const stack: DotKey[] = [];

  const dotRefOf = (key: DotKey): DotRef => {
    const patch = byDot.get(key);
    return patch === undefined ? { author: key, revision: 0 } : toDotRef(patch);
  };

  const visit = (key: DotKey): CyclicCausalityError | undefined => {
    const status = state.get(key);
    if (status === "done") {
      return undefined;
    }
    if (status === "visiting") {
      const cycleStart = stack.indexOf(key);
      const cycleKeys = [...stack.slice(cycleStart), key];
      return new CyclicCausalityError({ cycle: cycleKeys.map(dotRefOf) });
    }

    state.set(key, "visiting");
    stack.push(key);
    const patch = byDot.get(key);
    if (patch !== undefined) {
      for (const [baseAuthor, baseRevision] of patch.base) {
        if (baseRevision > 0) {
          const error = visit(dotKey(baseAuthor, baseRevision));
          if (error !== undefined) {
            return error;
          }
        }
      }
    }
    stack.pop();
    state.set(key, "done");
    return undefined;
  };

  for (const patch of patches) {
    const error = visit(dotKey(patch.author, patch.revision));
    if (error !== undefined) {
      return Either.left(error);
    }
  }

  return Either.right(undefined);
}

// ---------------------------------------------------------------------------
// Point 5: every change against its materialized exact base
// ---------------------------------------------------------------------------

/**
 * Classifies a text change's edit script against the base path's old token
 * sequence (§4.4: "The script MUST consume the complete old token
 * sequence; there is no implicit trailing retain"). Returns `undefined`
 * when the script consumes exactly the old sequence, otherwise the COMPLETE
 * diagnostic, naming the path:
 *
 *   - `edit of <path> does not consume old content` when it stops short
 *     (`tests/15-repository-validation.yaml`'s `{"retain": 1}` against two
 *     old tokens; the suite pins the phrase as a substring);
 *   - `edit of <path> consumes beyond old content` when it overruns them
 *     (`tests/23-strict-validation-matrix.yaml`'s `{"delete": 2}` against
 *     one old token — the pin `.+consumes beyond old content` is
 *     end-anchored, so the path goes BEFORE the phrase; this is also what
 *     any retain/delete against an absent or non-text base produces, since
 *     those expose zero old tokens).
 */
function editScriptMalformedReason(
  path: string,
  oldTokens: ReadonlyArray<string>,
  edit: EditScript,
): `edit of ${string} does not consume old content` | `edit of ${string} consumes beyond old content` | undefined {
  let consumed = 0;
  for (const op of edit) {
    if ("retain" in op) {
      consumed += op.retain;
    } else if ("delete" in op) {
      consumed += op.delete;
    }
    if (consumed > oldTokens.length) {
      return `edit of ${path} consumes beyond old content`;
    }
  }
  return consumed === oldTokens.length
    ? undefined
    : `edit of ${path} does not consume old content`;
}

/**
 * Materializes one change's per-path effect on the base tree (existence
 * plus content) — §6.2's `T` ("let `T` be the authored result of applying
 * that change to `B`"), built exactly as `replay/integrate.ts` builds it,
 * without integrating anything. Only called once the change's edit script
 * (if any) has passed `editScriptMalformedReason`, so `applyEditScript`'s
 * consumption invariant holds by construction and cannot throw.
 */
function changeTargetState(baseTree: Tree, change: Change): PathState {
  switch (change.type) {
    case "text": {
      const base = baseTree.get(change.path);
      const baseTokens = base !== undefined && base._tag === "Text" ? base.tokens : [];
      return { _tag: "Text", tokens: applyEditScript(baseTokens, change.edit) };
    }
    case "put":
      return pathStateFromBytes(Buffer.from(change.content, "base64"));
    case "delete":
      return { _tag: "Absent" };
  }
}

/**
 * SPEC §4.5 point 5: "every change against its materialized exact
 * base" -- SPEC §4.3: "A text or put creation requires the path to be
 * absent in the patch's exact base tree. An edit, replacement, or
 * delete requires it to be present. A change that does not alter path
 * existence or bytes is invalid, except that an empty text edit may
 * create an empty file."
 *
 * Fully implemented: each patch's exact base tree is materialized through
 * `replay/replay.ts`'s canonical replay of the patch's base version —
 * Phase 4-5's selection, integration, and OT machinery, which histories
 * with concurrent edits genuinely need here. Per change:
 *
 *   - a `text` edit script that does not consume exactly the base path's
 *     old tokens is rejected with the pinned under/over-consumption
 *     diagnostics (see `editScriptMalformedReason`);
 *   - a `delete` of an absent path is rejected with the pinned
 *     `delete of absent path: <path>` (tests 15/23);
 *   - a `text` edit of a present non-text path is rejected (§4.4's edit
 *     mechanics are defined over a text file's old tokens);
 *   - any other present→present change that alters neither bytes nor
 *     existence is rejected as a `no-op change` (test 15's "no op": a put
 *     of the same bytes; test 27's "create present": an empty script on an
 *     occupied path) — an empty script on an ABSENT path is §4.3's valid
 *     empty-file creation and passes;
 *   - everything else (creations, replacements, deletes of present paths,
 *     binary↔text transitions through `put`) is valid.
 *
 * A base-version replay failure (`IncompleteBaseClosureError` or
 * `ReplayNotReadyError`) is swallowed and the patch skipped — points 3, 4,
 * and 6 own replay-structure conditions, and point 5 runs before point 6,
 * so reporting them here could reorder which pinned diagnostic a malformed
 * history produces first.
 */
export function checkChangesAgainstMaterializedBase(
  repository: Repository,
): Either.Either<void, ChangeBaseConflictError> {
  for (const patch of repository.patches) {
    const baseReplay = replay(versionOfPairs(patch.base), repository.patches);
    if (Either.isLeft(baseReplay)) {
      continue; // Replay-structure failure: points 3/4/6 own it (see docstring).
    }
    const baseTree = baseReplay.right.tree;

    for (const change of patch.changes) {
      const baseState = baseTree.get(change.path);
      const basePresent = baseState !== undefined;

      if (change.type === "text") {
        const malformedReason = editScriptMalformedReason(
          change.path,
          baseState !== undefined && baseState._tag === "Text" ? baseState.tokens : [],
          change.edit,
        );
        if (malformedReason !== undefined) {
          return Either.left(
            new ChangeBaseConflictError({
              patch: toDotRef(patch),
              path: change.path,
              reason: malformedReason,
            }),
          );
        }
      }

      const target = changeTargetState(baseTree, change);

      // §4.4: applying the script "MUST produce exactly the canonical token
      // sequence of the result" — a script whose result token sequence is
      // not canonical (e.g. test 27's `insert ["a","b"]` creating a file
      // with an interior token lacking its trailing LF) is invalid.
      if (change.type === "text" && target._tag === "Text" && !isCanonicalTokenSequence(target.tokens)) {
        return Either.left(
          new ChangeBaseConflictError({
            patch: toDotRef(patch),
            path: change.path,
            reason: `edit result is not a canonical token sequence: ${change.path}`,
          }),
        );
      }

      if (change.type === "delete") {
        if (!basePresent) {
          return Either.left(
            new ChangeBaseConflictError({
              patch: toDotRef(patch),
              path: change.path,
              // Composed here in full; the renderer prints the reason bare,
              // producing the exactly-pinned `delete of absent path: f`
              // (tests/23).
              reason: `delete of absent path: ${change.path}`,
            }),
          );
        }
        continue; // A delete of a present path always alters existence.
      }

      if (!basePresent) {
        // A creation (text with inserts or an empty script, or a put):
        // §4.3 requires the path to be absent, and it is. The empty-script
        // empty-file creation is §4.3's explicit exception and lands here.
        continue;
      }

      if (change.type === "text" && baseState!._tag !== "Text") {
        return Either.left(
          new ChangeBaseConflictError({
            patch: toDotRef(patch),
            path: change.path,
            reason: `text edit of non-text content: ${change.path}`,
          }),
        );
      }

      // §4.3's no-op rule: "A change that does not alter path existence or
      // bytes is invalid." (Its exception — the empty-script creation —
      // already continued above; on an occupied path an empty script is a
      // no-op and is rejected here, as is a put of identical bytes.)
      if (pathStatesEqual(baseState!, target)) {
        return Either.left(
          new ChangeBaseConflictError({
            patch: toDotRef(patch),
            path: change.path,
            reason: `no-op change: ${change.path}`,
          }),
        );
      }
    }
  }
  return Either.right(undefined);
}

// ---------------------------------------------------------------------------
// Point 6: deterministic replay of the declared frontier
// ---------------------------------------------------------------------------

/**
 * Kahn's-algorithm consumption of the base-dependency graph restricted
 * to `dots`: a dot is "ready" once every one of its base dots that is
 * also in `dots` has already been consumed. Returns the subset of `dots`
 * that never became ready -- SPEC §4.5's closing paragraph: "If no ready
 * patch remains before replay is complete, the history has a cycle or
 * missing dependency." Pure graph reachability; no patch content is
 * read.
 */
function simulateReadySetConsumption(
  dots: ReadonlySet<DotKey>,
  byDot: ReadonlyMap<DotKey, Patch>,
): ReadonlySet<DotKey> {
  const remainingDependencyCount = new Map<DotKey, number>();
  const dependents = new Map<DotKey, DotKey[]>();

  for (const key of dots) {
    const patch = byDot.get(key)!;
    let count = 0;
    for (const [baseAuthor, baseRevision] of patch.base) {
      if (baseRevision === 0) {
        continue;
      }
      const baseKey = dotKey(baseAuthor, baseRevision);
      if (dots.has(baseKey)) {
        count++;
        const existing = dependents.get(baseKey);
        if (existing === undefined) {
          dependents.set(baseKey, [key]);
        } else {
          existing.push(key);
        }
      }
    }
    remainingDependencyCount.set(key, count);
  }

  const ready: DotKey[] = [];
  for (const [key, count] of remainingDependencyCount) {
    if (count === 0) {
      ready.push(key);
    }
  }

  const consumed = new Set<DotKey>();
  let cursor = 0;
  while (cursor < ready.length) {
    const key = ready[cursor]!;
    cursor++;
    consumed.add(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (remainingDependencyCount.get(dependent) ?? 0) - 1;
      remainingDependencyCount.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
  }

  const stalled = new Set<DotKey>();
  for (const key of dots) {
    if (!consumed.has(key)) {
      stalled.add(key);
    }
  }
  return stalled;
}

/**
 * SPEC §4.5 point 6, plus §4.1's "no unreachable patches": walks the
 * causal closure of `repository.frontier`, checks every patch in
 * `repository.patches` is part of it, then confirms that closure's
 * base-dependency graph fully consumes under `simulateReadySetConsumption`.
 */
export function checkFrontierReplay(
  repository: Repository,
  byDot: ReadonlyMap<DotKey, Patch>,
): Either.Either<
  void,
  UnknownFrontierDotError | IncompleteBaseClosureError | UnreachablePatchError | ReplayNotReadyError
> {
  const closureResult = causalClosureOf(repository.frontier, byDot);
  if (Either.isLeft(closureResult)) {
    const { dot, referencedBy } = closureResult.left;
    return Either.left(
      referencedBy === null
        ? new UnknownFrontierDotError({ dot: toDotRef(dot) })
        : new IncompleteBaseClosureError({
            patch: toDotRef(referencedBy),
            missingBaseDot: toDotRef(dot),
          }),
    );
  }
  const closure = closureResult.right;

  for (const patch of repository.patches) {
    const key = dotKey(patch.author, patch.revision);
    if (!closure.has(key)) {
      return Either.left(new UnreachablePatchError({ dot: toDotRef(patch) }));
    }
  }

  const stalled = simulateReadySetConsumption(closure, byDot);
  if (stalled.size > 0) {
    return Either.left(
      new ReplayNotReadyError({
        unreachable: Array.from(stalled, (key) => toDotRef(byDot.get(key)!)),
      }),
    );
  }

  return Either.right(undefined);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Runs SPEC §4.5's full six-point validation pipeline against unknown
 * JSON input, in order. Point 5 only checks the trivial empty-base case
 * (see `checkChangesAgainstMaterializedBase`'s `TODO(Phase 4)` for what's
 * deferred); every other point is fully checked, and the pipeline
 * short-circuits on the first failure, per point order.
 */
export function validateRepository(
  input: unknown,
): Either.Either<Repository, RepositoryValidationError> {
  const decoded = decodeRepository(input); // 1. schema (after the key-structure lint)
  if (Either.isLeft(decoded)) {
    return decoded;
  }
  const repository = decoded.right;
  const patches = repository.patches;

  const sortingResult = checkPatchSortingDuplicatesAndContiguity(patches); // 2. sorting/dot/contiguity
  if (Either.isLeft(sortingResult)) {
    return Either.left(sortingResult.left);
  }

  const byDot = indexPatchesByDot(patches);

  const baseClosureResult = checkBaseClosureAndRevisionFormula(patches, byDot); // 3. base closure/formula
  if (Either.isLeft(baseClosureResult)) {
    return Either.left(baseClosureResult.left);
  }

  const acyclicResult = checkAcyclicCausality(patches, byDot); // 4. acyclic
  if (Either.isLeft(acyclicResult)) {
    return Either.left(acyclicResult.left);
  }

  const changeBaseResult = checkChangesAgainstMaterializedBase(repository); // 5. PARTIAL -- see TODO(Phase 4) above
  if (Either.isLeft(changeBaseResult)) {
    return Either.left(changeBaseResult.left);
  }

  const replayResult = checkFrontierReplay(repository, byDot); // 6. frontier replay
  if (Either.isLeft(replayResult)) {
    return Either.left(replayResult.left);
  }

  return Either.right(repository);
}
