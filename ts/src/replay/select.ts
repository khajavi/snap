/**
 * Patch selection and deterministic integration ordering (SPEC.md §6.1):
 * given a target version `V` and a repository's `patches`, select every
 * patch `(c, n)` where `n <= V[c]`, then sequence that selected set by
 * ready-set consumption — "Repeatedly find patches whose bases are fully
 * integrated, choose the least ready patch", integrate it, recompute the
 * ready set, and repeat — which "puts causal dependencies before
 * concurrent patches".
 *
 * The least-ready-patch order is SPEC.md §6.1's three keys, in order:
 *
 *   1. Snap order of the patch's own result version (SPEC.md §3.4's
 *      `compareSnapOrder`, applied to SPEC.md §4.2's
 *      `computePatchResult`);
 *   2. unsigned UTF-8 order of author (SPEC.md §3.2); then
 *   3. numeric revision.
 *
 * "Valid histories normally decide at the first key": two distinct patches
 * with equal result versions would each name the other's dot in its base
 * (a result version preserves every base component except the author's
 * own, SPEC.md §4.2), a two-cycle `replay/validate.ts` point 4 rejects —
 * so keys 2 and 3 are the total-order tie-breaks §6.1 specifies anyway.
 *
 * §6.1's two prose invariants surface as typed errors rather than silent
 * misbehavior:
 *
 *   - "The set must contain every selected patch's base" — checked at
 *     selection time (`selectPatches`), reusing `IncompleteBaseClosureError`
 *     (SPEC.md §4.5 point 3's error). This is exactly SPEC.md §4.1's
 *     known-version condition ("every patch `(c, n)` selected by
 *     `n <= V[c]` exists, and that selected set contains the complete base
 *     of every selected patch"), and it is not merely defensive:
 *     `replay/validate.ts`'s pipeline establishes it for a repository's
 *     own frontier, not for an arbitrary target version — a validated
 *     repository can still name a `V` whose selected set strands a base
 *     (a base dot at a revision beyond that component of `V`).
 *   - "If no ready patch remains before replay is complete, the history
 *     has a cycle or missing dependency" — `orderSelectedPatches`'s stall
 *     case, reusing `ReplayNotReadyError` (SPEC.md §4.5 point 6's error)
 *     with every never-ready dot.
 *
 * Pure and synchronous throughout, like `replay/validate.ts`: `Either`
 * returns, no services, no filesystem. `replay/replay.ts` (a later phase)
 * composes this with `replay/integrate.ts` to turn the sequence into a
 * tree.
 */

import { Either } from "effect";
import { compareContributorIds } from "../domain/contributor.js";
import { computePatchResult, dotOf, type Patch, type VersionPairs } from "../domain/patch.js";
import { dotKey, type DotKey } from "../domain/repository.js";
import { Version, compareSnapOrder } from "../domain/version.js";
import { IncompleteBaseClosureError, ReplayNotReadyError } from "../errors/domain-errors.js";

/** The union of errors patch selection and ordering (SPEC.md §6.1) can produce. */
export type PatchSelectionError = IncompleteBaseClosureError | ReplayNotReadyError;

// ---------------------------------------------------------------------------
// VersionPairs -> Version
// ---------------------------------------------------------------------------

/**
 * Converts the version-JSON shape (`VersionPairs`, SPEC.md §3.2 — what
 * every patch carries and what `computePatchResult` returns) into the
 * `Version` type `compareSnapOrder` (SPEC.md §3.4) compares, by printing
 * the pairs in canonical syntax and re-parsing through `Version.parse` —
 * the constructor `domain/version.ts` offers for arbitrary versions, and
 * the one that re-establishes its canonical-form invariant.
 *
 * For `computePatchResult` output the parse cannot fail: its `base` input
 * arrived through `VersionPairsSchema` (sorted by unsigned UTF-8 bytes, no
 * duplicate author, revisions in `[1, MAX_REVISION]`, valid contributor
 * IDs), and `computePatchResult`'s upsert preserves all of those
 * properties. The impossible failure branch throws rather than being
 * silently tolerated — an internal invariant violation, not a validation
 * error, the same contract `domain/diff.ts`'s `applyEditScript` uses for
 * its impossible branches (validating externally-sourced values is
 * `replay/validate.ts`'s job, not this pure helper's).
 */
function versionOfPairs(pairs: VersionPairs): Version {
  const canonical = `(${pairs.map(([id, revision]) => `${id}->${revision}`).join(",")})`;
  const parsed = Version.parse(canonical);
  if (Either.isLeft(parsed)) {
    throw new Error(`canonical version pairs failed to re-parse: ${parsed.left.reason}`);
  }
  return parsed.right;
}

// ---------------------------------------------------------------------------
// Selection: every patch (c, n) where n <= V[c] (SPEC.md §6.1)
// ---------------------------------------------------------------------------

/**
 * Selects every patch `(c, n)` in `patches` where `n <= V[c]` (an absent
 * `V` component is 0, SPEC.md §3.3, so a patch by an author `V` does not
 * name is never selected), preserving `patches`' order. Patches beyond a
 * component of `V` are simply excluded — never an error by themselves.
 *
 * Then enforces SPEC.md §6.1's "The set must contain every selected
 * patch's base": every dot a selected patch's `base` names must itself be
 * a selected patch, or the selection fails with `IncompleteBaseClosureError`
 * naming the first offending patch and dot — the condition that makes `V`
 * a version the repository knows (SPEC.md §4.1).
 */
export function selectPatches(
  target: Version,
  patches: ReadonlyArray<Patch>,
): Either.Either<ReadonlyArray<Patch>, IncompleteBaseClosureError> {
  const selected = patches.filter((patch) => patch.revision <= target.revisionOf(patch.author));

  const selectedDots = new Set<DotKey>();
  for (const patch of selected) {
    selectedDots.add(dotKey(patch.author, patch.revision));
  }

  for (const patch of selected) {
    for (const [baseAuthor, baseRevision] of patch.base) {
      // `VersionPairSchema` bounds base revisions to [1, MAX_REVISION], so
      // `baseRevision > 0` always holds for schema-decoded patches; the
      // guard tolerates hand-built values, matching `replay/validate.ts`'s
      // own base-walk guards.
      if (baseRevision > 0 && !selectedDots.has(dotKey(baseAuthor, baseRevision))) {
        return Either.left(
          new IncompleteBaseClosureError({
            patch: dotOf(patch),
            missingBaseDot: { author: baseAuthor, revision: baseRevision },
          }),
        );
      }
    }
  }

  return Either.right(selected);
}

// ---------------------------------------------------------------------------
// Ordering: ready-set consumption under §6.1's three keys
// ---------------------------------------------------------------------------

/**
 * A selected patch paired with what §6.1's rules read: its dot key (base
 * integration is tracked per dot) and its own result version (tie-break
 * key 1), computed once per patch rather than once per comparison.
 */
interface SequencingCandidate {
  readonly patch: Patch;
  readonly key: DotKey;
  readonly result: Version;
}

/**
 * True iff every dot `patch.base` names is already integrated — SPEC.md
 * §6.1's "patches whose bases are fully integrated". A patch with an empty
 * `base` is ready immediately: its base version is `()`, already
 * integrated by §6.1's "Start from the empty tree".
 */
function isBaseIntegrated(patch: Patch, integrated: ReadonlySet<DotKey>): boolean {
  for (const [author, revision] of patch.base) {
    if (revision > 0 && !integrated.has(dotKey(author, revision))) {
      return false;
    }
  }
  return true;
}

/**
 * SPEC.md §6.1's least-ready-patch order over two ready candidates:
 * (1) Snap order (§3.4) of their result versions, then (2) unsigned UTF-8
 * order of author (§3.2), then (3) numeric revision. Over distinct dots
 * the three keys are a total order, so the least ready patch is unique
 * and the sequence deterministic regardless of the input array's order.
 */
function compareReadyCandidates(a: SequencingCandidate, b: SequencingCandidate): -1 | 0 | 1 {
  const resultOrder = compareSnapOrder(a.result, b.result);
  if (resultOrder !== 0) {
    return resultOrder;
  }
  const authorOrder = compareContributorIds(a.patch.author, b.patch.author);
  if (authorOrder !== 0) {
    return authorOrder;
  }
  return a.patch.revision < b.patch.revision
    ? -1
    : a.patch.revision > b.patch.revision
      ? 1
      : 0;
}

/**
 * Sequences the selected set into SPEC.md §6.1's deterministic integration
 * order: starting from the empty tree, repeatedly integrate the least
 * patch whose base version is fully integrated (all its base dots'
 * patches already sequenced), then recompute the ready set and repeat —
 * so a patch never integrates before any of its causal bases.
 *
 * If no ready patch remains before every patch is sequenced, the set has
 * a cycle or a missing dependency (SPEC.md §6.1's stall, phrased
 * identically in §4.5 point 6): fails with `ReplayNotReadyError` naming
 * every never-ready dot. When the input came from `selectPatches`, that
 * stall means the input itself was malformed — selection has already
 * ruled out a base stranded outside the selected set.
 */
export function orderSelectedPatches(
  selected: ReadonlyArray<Patch>,
): Either.Either<ReadonlyArray<Patch>, ReplayNotReadyError> {
  const remaining: Array<SequencingCandidate> = selected.map((patch) => ({
    patch,
    key: dotKey(patch.author, patch.revision),
    result: versionOfPairs(computePatchResult(patch)),
  }));

  const sequenced: Patch[] = [];
  const integrated = new Set<DotKey>();

  while (remaining.length > 0) {
    let best: SequencingCandidate | undefined;
    for (const candidate of remaining) {
      if (!isBaseIntegrated(candidate.patch, integrated)) {
        continue;
      }
      if (best === undefined || compareReadyCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }

    if (best === undefined) {
      return Either.left(
        new ReplayNotReadyError({
          unreachable: remaining.map((candidate) => dotOf(candidate.patch)),
        }),
      );
    }

    remaining.splice(remaining.indexOf(best), 1);
    integrated.add(best.key);
    sequenced.push(best.patch);
  }

  return Either.right(sequenced);
}

// ---------------------------------------------------------------------------
// The composed entry point
// ---------------------------------------------------------------------------

/**
 * SPEC.md §6.1 in one step: select every patch `(c, n)` where `n <= V[c]`
 * (`selectPatches`, including its every-selected-base check), then
 * sequence the selected set into the deterministic ready-set integration
 * order (`orderSelectedPatches`). The entry point `replay/replay.ts` (a
 * later phase) builds on: hand it a target version and a validated
 * repository's patches, get back the exact patch order to integrate.
 */
export function selectAndOrderPatches(
  target: Version,
  patches: ReadonlyArray<Patch>,
): Either.Either<ReadonlyArray<Patch>, PatchSelectionError> {
  const selection = selectPatches(target, patches);
  if (Either.isLeft(selection)) {
    return Either.left(selection.left);
  }
  return orderSelectedPatches(selection.right);
}
