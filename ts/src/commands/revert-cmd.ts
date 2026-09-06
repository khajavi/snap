/**
 * `snap revert <version>` (SPEC.md §7.7, plan.md Phase 8): replace the
 * working tree with an earlier version's tree, keeping the work in the
 * revert patch's authored result so no content is lost.
 *
 * §7.7, verbatim in part: "Diffs the current tree to the target tree and
 * authors one new patch with message `revert to <version>`" and "Installs
 * the target contents, updates the repository, and prints the **new**
 * version." The revert patch therefore has base = the repository's
 * *current* frontier and changes that turn the current tree into the
 * target tree, so the authored result (and the repository's new frontier)
 * is the target version while no history is ever removed.
 *
 * This module's order of operations, per §7.7 and the pinned tests:
 *
 *   1. Parse the operand as §3.2's canonical version syntax
 *      (`invalid version: <reason>` on failure).
 *   2. `locateRepository`; without one, `not a Snap repository`.
 *   3. Load the repository (needed to know *which versions are known*).
 *   4. **Known-version check** (SPEC.md §4.1) — must precede the
 *      contributor-ID requirement: tests/14 pins `revert (unknown@x->1)`
 *      reporting `unknown version` even though nothing is configured.
 *   5. `ConfigService#requireContributorId` — tests/19 pins that a known
 *      version with no configuration reports §8's required-identity error.
 *   6. Scan, failing on the first unsupported entry (SPEC.md §10);
 *   7. Replay the current tree and require it clean — §7.7: "needs a
 *      clean working tree" (`working tree is dirty`, tests/19).
 *   8. Replay the target version's tree and require it *different* from
 *      the working tree — "fails if the target tree is already current"
 *      (`target tree is already current`, tests/07).
 *   9. Author the change set turning the current tree into the target
 *      tree (the revert patch's authored result), check the revision
 *      overflow, patch the repository (base = the current frontier), then
 *      install the target tree and update `.snap/repository.json` —
 *      materialize before save, matching §7.8's named order.
 *   10. Print the new version.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Either } from "effect";
import { Version, type InvalidVersionError } from "../domain/version.js";
import { revisionOfVersionPairs, type Patch } from "../domain/patch.js";
import { ConfigService, type ConfigDecodeError, type ContributorIdRequiredError } from "../config/config.js";
import {
  WorkingTreeDirtyError,
  authorChanges,
  checkedNextRevision,
  firstUnsupportedError,
  isWorkingTreeClean,
  type RevisionOverflowError,
} from "./tree-ops.js";
import { requireKnownVersion, UnknownVersionError } from "./unknown-version.js";
import { repositoryAfterPatch } from "./repo-operand.js";
import type { InvalidPathError } from "../domain/path.js";
import { UnsupportedWorkingTreeEntryError, scanWorkingTree } from "../fs/tree-scan.js";
import { materialize } from "../fs/materialize.js";
import { replay, versionOfPairs, type ReplayError } from "../replay/replay.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";

/** SPEC.md §7.7's exact already-current detail text, unprefixed. */
export const TARGET_TREE_ALREADY_CURRENT_DETAIL = "target tree is already current";

/** §7.7: the target version's tree already equals the working tree. */
export class TargetTreeAlreadyCurrentError extends Data.TaggedError(
  "TargetTreeAlreadyCurrentError",
)<{}> {}

/** Every error `revertCmd` can produce. */
export type RevertError =
  | InvalidVersionError
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | PlatformError
  | ConfigDecodeError
  | ContributorIdRequiredError
  | UnknownVersionError
  | UnsupportedWorkingTreeEntryError
  | InvalidPathError
  | ReplayError
  | WorkingTreeDirtyError
  | TargetTreeAlreadyCurrentError
  | RevisionOverflowError;

/**
 * Runs §7.7 from the process working directory. Returns the exact stdout
 * bytes: the repository's new version — its full canonical frontier — plus
 * LF.
 */
export function revertCmd(
  versionOperand: string,
): Effect.Effect<string, RevertError, FileSystem.FileSystem | ConfigService | RepoStore> {
  return Effect.gen(function* () {
    const target = Version.parse(versionOperand);
    if (Either.isLeft(target)) {
      return yield* Effect.fail(target.left);
    }
    const targetVersion = target.right;

    const repoRoot = yield* locateRepository(".");
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);

    const known = requireKnownVersion(targetVersion, repository.patches);
    if (Either.isLeft(known)) {
      return yield* Effect.fail(known.left);
    }

    const config = yield* ConfigService;
    const author = yield* config.requireContributorId(repoRoot);

    const scan = yield* scanWorkingTree(repoRoot);
    const unsupported = firstUnsupportedError(scan);
    if (unsupported !== undefined) {
      return yield* Effect.fail(unsupported);
    }

    const frontier = versionOfPairs(repository.frontier);
    const current = replay(frontier, repository.patches);
    if (Either.isLeft(current)) {
      return yield* Effect.fail(current.left);
    }
    if (!isWorkingTreeClean(scan, current.right.tree)) {
      return yield* Effect.fail(new WorkingTreeDirtyError());
    }

    const replayed = replay(targetVersion, repository.patches);
    if (Either.isLeft(replayed)) {
      return yield* Effect.fail(replayed.left);
    }
    const targetTree = replayed.right.tree;
    if (isWorkingTreeClean(scan, targetTree)) {
      return yield* Effect.fail(new TargetTreeAlreadyCurrentError());
    }

    const changes = authorChanges(current.right.tree, targetTree);

    const nextRevision = checkedNextRevision(revisionOfVersionPairs(repository.frontier, author));
    if (Either.isLeft(nextRevision)) {
      return yield* Effect.fail(nextRevision.left);
    }

    const patch: Patch = {
      author,
      revision: nextRevision.right,
      // §7.7: "Diffs the current tree to the target tree and authors one
      // new patch" — the revert patch's base is the current frontier, so
      // the authored result (`base` with `author`'s revision bumped) is
      // the target version and the frontier only ever moves forward.
      base: repository.frontier,
      message: `revert to ${targetVersion.toCanonicalString()}`,
      changes,
    };
    const nextRepository = repositoryAfterPatch(repository, patch);

    // §7.7: "It then installs the target version's tree and updates the
    // repository" — materialize the target tree, then save.
    yield* materialize(repoRoot, targetTree);
    yield* store.save(repoRoot, nextRepository);

    return `(${patch.author}->${patch.revision})\n`;
  });
}