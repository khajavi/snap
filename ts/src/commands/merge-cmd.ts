/**
 * `snap merge <repository>` (SPEC.md §7.8, plan.md Phase 8): fold another
 * repository's history into the local one.
 *
 * §7.8, in its own words and order:
 *
 *   - "loads the local repository, verifies it (unsupported entries fail
 *     it), needs a clean working tree, loads the remote repository,
 *     compares every dot present in both repositories and fails as corrupt
 *     if its parsed patch values differ, joins the patch sets, replays the
 *     joined versions, ... renders the result, installs the result, and
 *     updates `repository.json`."
 *   - The padlock: "A dot present in both repositories must map to equal
 *     parsed typed patch values or the merge fails as corrupt before any
 *     local state changes." (tests/16 pins `patch collision:
 *     <author> revision <revision>` for both `merge` and `diff --repo`.)
 *   - "The merge frontier is §3.3's join of the two frontiers; the patch
 *     set is the union. The merged result may need any validated
 *     repository property, so the merged patch set is itself
 *     re-validated."
 *
 * Themerged repository this module builds is *canonical by construction*:
 * both inputs already validate to §4.1's sorted/unique-dot shape, and
 * §7.8's own requirement (see the doc comment on `unionSortedPatches`) is
 * precisely that the union keeps that shape — so the §4.5 skip is the
 * SPEC's intent, not a shortcut. Warnings (SPEC.md §6.4) print per merged
 * warning §7.8's pinned line `warning: auto-resolved <path>: <reason>`.
 *
 * This module's order of operations:
 *
 *   1. `locateRepository`, load local, scan (first unsupported entry
 *      fails it — the "verifies it" step), replay the current tree, and
 *      require the working tree clean. §7.8's ordering in test 20: the
 *      unsupported-entry failure preempts a dirty-tree failure, and a
 *      dirty tree fails before the remote is ever reached.
 *   2. Load the remote via `repo-operand.ts`'s `loadRepositoryAt`
 *      (local path in Phase 8; the HTTP half lands in Phase 10).
 *   3. Padlock: `checkDotCollisions`.
 *   4. `unionSortedPatches` + §3.3's `Version.join`.
 *   5. Replay the join; the pre-revert local replay's warnings are
 *      *already-known* warnings, so only the joined replay's new warning
 *      pairs print (this makes re-merging an already-merged repository
 *      idempotent in output — tests/09's repeated merges).
 *   6. Install the replayed tree, then save (materialize before
 *      `repository.json`, the §7.8-named order shared with commit/revert).
 *   7. Print the merged frontier on stdout; warnings go to stderr.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Either } from "effect";
import { Version } from "../domain/version.js";
import type { Patch, VersionPairs } from "../domain/patch.js";
import {
  WorkingTreeDirtyError,
  firstUnsupportedError,
  isWorkingTreeClean,
} from "./tree-ops.js";
import {
  PatchCollisionError,
  checkDotCollisions,
  loadRepositoryAt,
  unionSortedPatches,
} from "./repo-operand.js";
import type { HttpRepositoryLoadError } from "../repo-store/http-source.js";
import type { InvalidPathError } from "../domain/path.js";
import { UnsupportedWorkingTreeEntryError, scanWorkingTree } from "../fs/tree-scan.js";
import { materialize } from "../fs/materialize.js";
import { replay, versionOfPairs, type ReplayError } from "../replay/replay.js";
import type { WarningPair } from "../replay/tiebreak.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";

/** One merge's exact stdout + stderr bytes (stderr carries only warning lines). */
export interface MergeResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Every error `mergeCmd` can produce. */
export type MergeError =
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | PlatformError
  | UnsupportedWorkingTreeEntryError
  | InvalidPathError
  | WorkingTreeDirtyError
  | PatchCollisionError
  | HttpRepositoryLoadError
  | ReplayError;

/** §7.8's one warning line for a merged warning pair, `warning: auto-resolved <path>: <reason>`. */
const warningLine = (pair: WarningPair): string =>
  `warning: auto-resolved ${pair.path}: ${pair.reason}`;

/**
 * Runs §7.8 from the process working directory. `repositoryOperand` is the
 * `<repository>` positional verbatim (local path in Phase 8).
 */
export function mergeCmd(
  repositoryOperand: string,
): Effect.Effect<MergeResult, MergeError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const repoRoot = yield* locateRepository(".");
    const store = yield* RepoStore;
    const local = yield* store.load(repoRoot);

    const scan = yield* scanWorkingTree(repoRoot);
    const unsupported = firstUnsupportedError(scan);
    if (unsupported !== undefined) {
      return yield* Effect.fail(unsupported);
    }

    const frontierLocal = versionOfPairs(local.frontier);
    const current = replay(frontierLocal, local.patches);
    if (Either.isLeft(current)) {
      return yield* Effect.fail(current.left);
    }
    if (!isWorkingTreeClean(scan, current.right.tree)) {
      return yield* Effect.fail(new WorkingTreeDirtyError());
    }

    const remote = yield* loadRepositoryAt(repositoryOperand);

    const padlock = checkDotCollisions(local.patches, remote.patches);
    if (padlock !== undefined) {
      return yield* Effect.fail(padlock);
    }

    const joinedPatches: ReadonlyArray<Patch> = unionSortedPatches(local.patches, remote.patches);
    const joinedFrontier: Version = Version.join(
      frontierLocal,
      versionOfPairs(remote.frontier),
    );

    const joinedReplay = replay(joinedFrontier, joinedPatches);
    if (Either.isLeft(joinedReplay)) {
      return yield* Effect.fail(joinedReplay.left);
    }

    // Only *new* warnings print: the pre-merge local replay's warnings are
    // the already-announced set (eliminating them makes a repeated merge
    // as silent as tests/09 expects). `replay` finalizes both sets, so a
    // `(path, reason)` pair is comparable directly.
    const knownWarnings = new Set(
      current.right.warnings.map((pair) => `${pair.path}\u0000${pair.reason}`),
    );
    const newWarnings = joinedReplay.right.warnings.filter(
      (pair) => !knownWarnings.has(`${pair.path}\u0000${pair.reason}`),
    );
    const stderrText =
      newWarnings.length === 0 ? "" : `${newWarnings.map(warningLine).join("\n")}\n`;

    const nextRepository = {
      ...local,
      frontier: joinedFrontier.entries as VersionPairs,
      patches: joinedPatches,
    };

    // §7.8: "installs the result, and updates `repository.json`".
    yield* materialize(repoRoot, joinedReplay.right.tree);
    yield* store.save(repoRoot, nextRepository);

    return {
      stdout: `${joinedFrontier.toCanonicalString()}\n`,
      stderr: stderrText,
    };
  });
}