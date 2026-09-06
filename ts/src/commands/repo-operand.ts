/**
 * Reading a *repository operand* — the `<repository>` positional that
 * `snap merge <repository>` and `snap diff <old> <new> --repo <repository>`
 * take — and the cross-repository integrity guarantees the SPEC pins on it.
 *
 * SPEC.md §7's intro: "A repository operand is an explicit `http://` or
 * `https://` URL, or otherwise a local path to a repository root." and
 * "Local repository operands resolve against the process working
 * directory." The HTTP half is Phase 10's job (plan.md Phase 10's
 * `repo-store/http-source.ts`); this module's `loadRepositoryAt` handles
 * the local-path half now and will gain a URL branch in that phase. The
 * two *checks* are complete today because both are pure:
 *
 *  1. **Dot collisions** (SPEC.md §7.6's cross-repository paragraph and
 *     §16): a dot present in both repositories must map to equal parsed
 *     typed patch values or the operation fails as corrupt, before any
 *     local state changes. tests/16 pins the exact detail
 *     `patch collision: <author> revision <revision>` for both `diff
 *     --repo` and `merge`; tests/26 pins the positive case (two JSON
 *     spellings of the same parsed patch are *equal*, so the merge
 *     succeeds).
 *  2. **The joined patch set** stays SPEC.md §4.1's canonical shape:
 *     sorted by author then revision, one value per dot. Both input
 *     repositories validate to that shape, so merging the two sorted
 *     arrays by dot and collapsing identical dots (`unionSortedPatches`)
 *     preserves it without re-sorting.
 *
 * `PatchCollisionError` follows the domain-error convention: structured
 * fields (author, revision), rendered to the pinned detail at the
 * CLI-error-rendering boundary.
 */

import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect } from "effect";
import { type Patch, computePatchResult } from "../domain/patch.js";
import { type Repository, dotKey, indexPatchesByDot } from "../domain/repository.js";
import { compareContributorIds } from "../domain/contributor.js";
import { RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";
import {
  isHttpOperand,
  loadHttpRepository,
  type HttpRepositoryLoadError,
} from "../repo-store/http-source.js";

/**
 * A dot present in both repositories maps to structurally unequal parsed
 * patch values (SPEC.md §7.6's "compare every dot present in both
 * repositories and fail as corrupt if its parsed patch values differ").
 * Rendering adds the `snap: ` prefix to the pinned detail
 * `patch collision: <author> revision <revision>`.
 */
export class PatchCollisionError extends Data.TaggedError("PatchCollisionError")<{
  readonly author: string;
  readonly revision: number;
}> {}

/** SPEC.md §3.1/§4.2's patch ordering: by author (unsigned UTF-8), then numeric revision. */
function comparePatchDots(a: Patch, b: Patch): -1 | 0 | 1 {
  const cmp = compareContributorIds(a.author, b.author);
  if (cmp !== 0) {
    return cmp;
  }
  return a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0;
}

/**
 * The first cross-repository dot collision, or `undefined` when every dot
 * present in both repositories maps to equal parsed patch values
 * (SPEC.md §7.6). Reads in `a`'s order, so the offending dot is
 * deterministic for a pair of validated (sorted) repositories.
 */
export function checkDotCollisions(
  a: ReadonlyArray<Patch>,
  b: ReadonlyArray<Patch>,
): PatchCollisionError | undefined {
  const byDotB = indexPatchesByDot(b);
  for (const patch of a) {
    const other = byDotB.get(dotKey(patch.author, patch.revision));
    if (other !== undefined && !isDeepStrictEqual(patch, other)) {
      return new PatchCollisionError({ author: patch.author, revision: patch.revision });
    }
  }
  return undefined;
}

/**
 * The union of two validated patch sets: SPEC.md §4.1's sorted-by-dot
 * shape with one value per dot preserved. Both inputs are already sorted
 * with unique dots, so a two-pointer merge by dot collapses identical
 * dots (equal parsed values by construction — `checkDotCollisions` ran
 * first) without disturbing the sorted order.
 */
export function unionSortedPatches(
  a: ReadonlyArray<Patch>,
  b: ReadonlyArray<Patch>,
): ReadonlyArray<Patch> {
  const out: Patch[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const cmp = comparePatchDots(a[i]!, b[j]!);
    if (cmp < 0) {
      out.push(a[i]!);
      i++;
    } else if (cmp > 0) {
      out.push(b[j]!);
      j++;
    } else {
      out.push(a[i]!);
      i++;
      j++;
    }
  }
  while (i < a.length) {
    out.push(a[i]!);
    i++;
  }
  while (j < b.length) {
    out.push(b[j]!);
    j++;
  }
  return out;
}

/**
 * Inserts one patch into a validated (dot-sorted, unique-dot) patch list at
 * its §4.1 position, preserving the invariants: `commit`/`revert` reuse
 * this so the repository stays in §4.1's canonical shape "by construction"
 * rather than by re-sorting. The caller's `revision = base[author] + 1`
 * guarantees the dot is absent from `patches` (the revision is greater than
 * everything this author has in the list), so this is a plain insertion,
 * not a merge — it runs a linear scan for clarity over a binary search's
 * complexity, consistent with the diff engine's simplicity stance.
 */
export function insertPatchSorted(
  patches: ReadonlyArray<Patch>,
  patch: Patch,
): ReadonlyArray<Patch> {
  const out = [...patches];
  let index = 0;
  while (index < out.length && comparePatchDots(out[index]!, patch) < 0) {
    index++;
  }
  out.splice(index, 0, patch);
  return out;
}

/**
 * A validated `Repository` with one new authored patch applied: fronts the
 * patch list with the inserted patch and sets `frontier` to §4.2's
 * `result = base with result[author] = revision` (`computePatchResult`).
 * Shared by `commit` and `revert`, whose write shape is otherwise
 * identical: base = the current frontier (commit) or the reverted-to
 * version (revert), then materialize and save via the command.
 */
export function repositoryAfterPatch(
  repository: Repository,
  patch: Patch,
): Repository {
  return {
    ...repository,
    frontier: computePatchResult(patch),
    patches: insertPatchSorted(repository.patches, patch),
  };
}
/**
 * Loads and fully validates the repository a local-path operand names
 * (SPEC.md §7: a repository operand resolves against the process working
 * directory, and "a `.snap` that exists but is not a directory does not
 * count"), mirroring `repo-store/locate.ts`'s rule so operand lookup and
 * nearest-repository lookup agree on what a repository is, then runs its
 * `repository.json` through the full `RepoStore#load` validation pipeline
 * (SPEC.md §4.5), so a malformed remote fails exactly like a malformed
 * local repository and never mutates anything (tests/26 pins both).
 *
 * HTTP/HTTPS operands are Phase 10's `repo-store/http-source.ts`; until
 * that phase this function treats any operand as a local path.
 */
/**
 * Loads the repository at `operand` (SPEC.md §9): an `http://`/`https://`
 * URL performs §9's one exact-URL validated GET (`http-source.ts`);
 * anything else is a local repository-root path resolved against the
 * process working directory. Both sources feed the same validated
 * `Repository` value; HTTP is read-only.
 */
export function loadRepositoryAt(
  operand: string,
): Effect.Effect<
  Repository,
  RepositoryNotFoundError | RepoStoreLoadError | HttpRepositoryLoadError | PlatformError,
  FileSystem.FileSystem | RepoStore
> {
  if (isHttpOperand(operand)) {
    return loadHttpRepository(operand);
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absolute = resolve(operand);
    const snapPath = `${absolute}/.snap`;
    const exists = yield* fs.exists(snapPath);
    if (!exists) {
      return yield* Effect.fail(new RepositoryNotFoundError());
    }
    const info = yield* fs.stat(snapPath);
    if (info.type !== "Directory") {
      return yield* Effect.fail(new RepositoryNotFoundError());
    }
    const store = yield* RepoStore;
    return yield* store.load(absolute);
  });
}