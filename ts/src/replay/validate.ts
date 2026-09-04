/**
 * The full repository validation pipeline, SPEC.md §4.5's six points, run
 * in order:
 *
 *   1. schema validation                          -- FULLY IMPLEMENTED
 *   2. sorting, one value per dot, contiguity      -- FULLY IMPLEMENTED
 *   3. base closure and the revision formula       -- FULLY IMPLEMENTED
 *   4. acyclic causality                           -- FULLY IMPLEMENTED
 *   5. every change against its materialized base  -- PARTIALLY IMPLEMENTED
 *                                                      (see
 *                                                      `checkChangesAgainstMaterializedBase`'s
 *                                                      `TODO(Phase 4)` below)
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
 * Point 5's "partially" qualifier: a patch whose `base` is the empty
 * version (`[]`) has a materialized base tree that is unambiguously the
 * empty tree -- there are zero patches to integrate, so no replay
 * machinery is needed to know every path is absent. That trivial case is
 * fully and soundly checked below; every other case (`base` nonempty)
 * needs real replay and is deferred, not approximated -- see the
 * `TODO(Phase 4)` on `checkChangesAgainstMaterializedBase`.
 */

import { Either } from "effect";
import { isDeepStrictEqual } from "node:util";
import { compareContributorIds } from "../domain/contributor.js";
import { revisionOfVersionPairs, type Dot, type Patch } from "../domain/patch.js";
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
// Point 5: every change against its materialized exact base -- STUBBED
// ---------------------------------------------------------------------------

/**
 * SPEC §4.5 point 5: "every change against its materialized exact
 * base" -- SPEC §4.3: "A text or put creation requires the path to be
 * absent in the patch's exact base tree. An edit, replacement, or
 * delete requires it to be present. A change that does not alter path
 * existence or bytes is invalid, except that an empty text edit may
 * create an empty file."
 *
 * PARTIALLY IMPLEMENTED in this phase: only the trivial case where a
 * patch's `base` is the empty version (`[]`) is checked. That base is
 * unambiguously the empty tree -- there is nothing to replay, so every
 * path is definitionally absent, with zero risk of the concurrency
 * ambiguity the general case has. Concretely, for such a patch: a
 * `delete` change is always invalid (`ChangeBaseConflictError`, matching
 * `tests/23-strict-validation-matrix.yaml`'s "delete of absent path: f"
 * case), and a `text` change's edit script may not contain a `retain` or
 * `delete` op (there are zero old tokens to retain or delete against).
 * `text`/`put` creations are always valid onto the empty tree.
 *
 * Every patch with a NONEMPTY `base` is skipped here -- deliberately, not
 * approximated.
 *
 * TODO(Phase 4): A nonempty `base` is a full vector clock that can
 * include several contributors' concurrent patches, so "materialize the
 * base tree" there is exactly `replay/replay.ts`'s job:
 * `replay/select.ts`'s ready-set/Snap-order integration sequencing,
 * `replay/integrate.ts`'s per-path case dispatch (including its own
 * namespace-conflict precheck), and `replay/ot.ts`'s text transform for
 * concurrent text edits on the same path -- none of which exist yet
 * (they're Phase 4/5 modules). Two shortcuts were considered and rejected
 * for the nonempty-base case in this phase: (a) re-implementing a slice
 * of replay here, which would duplicate logic and risk silently drifting
 * from the real `replay/replay.ts` once it lands; (b) approximating
 * "present in the base tree" with a naive ancestry walk ("was this path
 * ever created, and never deleted, along *some* path back to the
 * base?"), which is unsound the moment the base's history contains
 * concurrent edits/deletes of the same path that Snap's tie-break rules
 * (§6.4) resolve one way but a naive walk would resolve another (or not
 * at all, for the OT text/text case) -- exactly the scenario
 * `tests/15-repository-validation.yaml`'s "does not consume old content"
 * and `tests/23-strict-validation-matrix.yaml`'s "consumes beyond old
 * content"/"no-op change" cases exercise, which this phase's
 * unit tests confirm are NOT rejected by this function alone. Once
 * `replay/replay.ts` exists, this function should materialize
 * `patch.base` through it and check every patch's `changes` against the
 * resulting path set (and, for the no-op rule, byte content) uniformly,
 * replacing the empty-base special case below rather than keeping it
 * alongside the general one.
 */
export function checkChangesAgainstMaterializedBase(
  repository: Repository,
): Either.Either<void, ChangeBaseConflictError> {
  for (const patch of repository.patches) {
    if (patch.base.length > 0) {
      continue; // General case: deferred to Phase 4, see the TODO above.
    }
    for (const change of patch.changes) {
      if (change.type === "delete") {
        return Either.left(
          new ChangeBaseConflictError({
            patch: toDotRef(patch),
            path: change.path,
            reason: "delete of absent path",
          }),
        );
      }
      if (change.type === "text") {
        for (const op of change.edit) {
          if ("retain" in op || "delete" in op) {
            return Either.left(
              new ChangeBaseConflictError({
                patch: toDotRef(patch),
                path: change.path,
                reason: "edit references old content that does not exist",
              }),
            );
          }
        }
      }
      // A "put" change and a "text" change with only `insert` operations
      // (or the empty script) are always valid creations onto the empty
      // tree.
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
  const decoded = decodeRepository(input); // 1. schema
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
