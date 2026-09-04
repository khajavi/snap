/**
 * Canonical replay (SPEC.md §6.1-§6.2, §6.5): select and order the patches
 * a target version names (`replay/select.ts`), then fold
 * `replay/integrate.ts`'s single-patch integration from the empty tree —
 * threading each patch its own exact base tree, not the running canonical
 * tree at its turn.
 *
 * The base-tree detail is §6.2's opening sentence: "For incoming patch `P`,
 * materialize its exact base tree `B`." `P`'s base tree is the tree of its
 * base *version* — the replay of exactly the patches `P.base` selects —
 * because the running canonical tree at `P`'s turn already contains earlier
 * concurrent effects (§6.2: "`C` ... contains `B` plus only earlier
 * concurrent effects"), and §6.4's rules compare against `B`, not `C`.
 * Base trees are therefore computed by the same select-and-fold this module
 * performs, recursively, with results memoized per canonical version so a
 * history with N patches costs O(distinct versions) folds rather than an
 * exponential re-replay of every base chain.
 *
 * Warnings: only the target replay's own fold contributes — every selected
 * patch integrates exactly once there, and a sub-replay's patches are a
 * subset of the target's (a base version is componentwise `<=` the target,
 * so its selection is too), so excluding sub-replay warnings loses nothing
 * and double-counts nothing. The union is finalized by §6.4's rule: "Replay
 * returns the set of unique warning pairs sorted by path, then reason"
 * (`finalizeWarningPairs`).
 *
 * Pure and synchronous: `Either` returns, no services, no filesystem. The
 * optional `textTransform` parameter is §6.3's Phase 5 seam, passed through
 * to every `integratePatch` call — base-tree sub-replays included, since
 * they run the same dispatch.
 */

import { Either } from "effect";
import type { Patch, VersionPairs } from "../domain/patch.js";
import { Version } from "../domain/version.js";
import { OtUnavailableError } from "../errors/domain-errors.js";
import { integratePatch, type TextTransform, type Tree } from "./integrate.js";
import { selectAndOrderPatches, type PatchSelectionError } from "./select.js";
import { finalizeWarningPairs, type WarningPair } from "./tiebreak.js";

/** The errors canonical replay can produce: §6.1's selection/ordering failures plus §6.2 case 3's seam error. */
export type ReplayError = PatchSelectionError | OtUnavailableError;

/** One completed replay: the materialized tree and the finalized warning set. */
export interface ReplayOutcome {
  /** The canonical tree of `target` (§6.2): every present path and its state. */
  readonly tree: Tree;
  /**
   * §6.4's "set of unique warning pairs sorted by path, then reason" —
   * finalized by `finalizeWarningPairs`, ready for §7.8's merge rendering
   * (`warning: auto-resolved <path>: <reason>`).
   */
  readonly warnings: ReadonlyArray<WarningPair>;
}

/**
 * Converts a patch's `base` (SPEC.md §3.2's version-JSON pairs) into the
 * `Version` the base-tree recursion keys on — the same print-and-reparse
 * trick `replay/select.ts` uses internally for `computePatchResult` output
 * (its helper is module-private, hence this twin). Schema-decoded pairs are
 * sorted with no duplicate author and carry valid revisions, so the parse
 * cannot fail; the impossible branch throws as an internal invariant
 * violation, the contract `domain/diff.ts`'s `applyEditScript` uses.
 */
const versionOfPairs = (pairs: VersionPairs): Version => {
  const canonical = `(${pairs.map(([id, revision]) => `${id}->${revision}`).join(",")})`;
  const parsed = Version.parse(canonical);
  if (Either.isLeft(parsed)) {
    throw new Error(`canonical version pairs failed to re-parse: ${parsed.left.reason}`);
  }
  return parsed.right;
};

/**
 * Canonically replays `target` over `patches` (SPEC.md §6.1-§6.2): select
 * every patch `(c, n)` where `n <= V[c]`, sequence the selected set by
 * ready-set consumption, and fold `integratePatch` from the empty tree,
 * each patch integrating against its own base tree — the memoized replay
 * of that patch's base version.
 *
 * `textTransform` (optional) is §6.3's seam; without it, any §6.2 case 3
 * the replay reaches fails the whole replay with `OtUnavailableError`
 * rather than guessing a merge — Phase 5 injects the real transform.
 */
export function replay(
  target: Version,
  patches: ReadonlyArray<Patch>,
  textTransform?: TextTransform,
): Either.Either<ReplayOutcome, ReplayError> {
  /** Memoized replays by canonical version string, base versions included. */
  const cache = new Map<string, Either.Either<ReplayOutcome, ReplayError>>();
  /** Versions currently being computed, to fail loudly on base-version recursion cycles. */
  const inProgress = new Set<string>();

  const replayVersion = (version: Version): Either.Either<ReplayOutcome, ReplayError> => {
    const key = version.toCanonicalString();
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // A patch set whose base-version graph cycles (possible only for inputs
    // `replay/validate.ts` rejects — §4.5 point 3's revision formula and
    // point 4's acyclicity) would re-enter a version still being computed;
    // ordering alone cannot always see it, so fail loudly instead of
    // overflowing the stack.
    if (!inProgress.add(key)) {
      throw new Error(`base-version replay re-entered version ${key}: cyclic base graph`);
    }

    const ordered = selectAndOrderPatches(version, patches);
    if (Either.isLeft(ordered)) {
      inProgress.delete(key);
      const failure: Either.Either<ReplayOutcome, ReplayError> = Either.left(ordered.left);
      cache.set(key, failure);
      return failure;
    }

    let tree: Tree = new Map();
    const warnings: WarningPair[] = [];
    for (const patch of ordered.right) {
      // §6.2: "materialize its exact base tree B" — the replay of the
      // patch's base version, not the running canonical tree.
      const base = replayVersion(versionOfPairs(patch.base));
      if (Either.isLeft(base)) {
        inProgress.delete(key);
        cache.set(key, base);
        return base;
      }

      const integrated = integratePatch(base.right.tree, tree, patch, textTransform);
      if (Either.isLeft(integrated)) {
        inProgress.delete(key);
        const failure: Either.Either<ReplayOutcome, ReplayError> = Either.left(integrated.left);
        cache.set(key, failure);
        return failure;
      }

      tree = integrated.right.tree;
      warnings.push(...integrated.right.warnings);
    }

    inProgress.delete(key);
    const outcome: Either.Either<ReplayOutcome, ReplayError> = Either.right({ tree, warnings });
    cache.set(key, outcome);
    return outcome;
  };

  const outcome = replayVersion(target);
  if (Either.isLeft(outcome)) {
    return outcome;
  }
  return Either.right({
    tree: outcome.right.tree,
    warnings: finalizeWarningPairs(outcome.right.warnings),
  });
}
