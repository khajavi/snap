/**
 * `snap diff` (SPEC.md §7.6, plan.md Phase 8): render the difference
 * between two trees as SPEC.md §7.6's whole-file unified diff.
 *
 * Two arities (from `DiffTarget`, parsed by `cli/args.ts`):
 *
 *   - **Working-tree**: no operands — compares the current tree with the
 *     working tree. The scan still fails on the first unsupported entry
 *     (SPEC.md §10; tests/08 pins `diff` on a symlinked tree failing),
 *     and a clean tree renders `""` with success.
 *   - **Versions**: `<old> <new>` — both operands parse as §3.2's
 *     canonical version syntax (`invalid version: <reason>` on failure).
 *     With `--repo <repository>`, `old` still resolves against the *local*
 *     repository while `new` resolves in the joined local∪remote patch
 *     set — §7.6's exact split ("resolves the new version in repository
 *     A"), and the padlock runs between the two resolutions.
 *
 * The resolution order §7.6 pins (exercised by tests/16's and /17's
 * `diff --repo` cases):
 *
 *   1. Resolve `old` against the local repository first; report
 *      `unknown version: <old>` if it is not §4.1-known (before any
 *      remote is consulted).
 *   2. Only for `--repo`: load the remote, run the dot-collision padlock
 *      (`patch collision`, failing as corrupt before any output), and
 *      join the patch sets.
 *   3. Resolve `new` against the appropriate set; report
 *      `unknown version: <new>` if unknown.
 *   4. Replay both trees and render.
 *
 * Rendering is `diff-renderer.ts`'s pure `renderTreeDiff`, pinned
 * byte-for-byte by tests/05, /06, and /26 (whole-tree `@@` counts,
 * `/dev/null` labels, CRLF-token preservation, binary lines, no trailing
 * noise when nothing changed).
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Either } from "effect";
import { Version, type InvalidVersionError } from "../domain/version.js";
import type { DiffTarget } from "../cli/args.js";
import { UnknownVersionError, requireKnownVersion } from "./unknown-version.js";
import {
  PatchCollisionError,
  checkDotCollisions,
  loadRepositoryAt,
  unionSortedPatches,
} from "./repo-operand.js";
import { renderTreeDiff } from "./diff-renderer.js";
import { firstUnsupportedError } from "./tree-ops.js";
import type { InvalidPathError } from "../domain/path.js";
import { UnsupportedWorkingTreeEntryError, scanWorkingTree } from "../fs/tree-scan.js";
import { replay, versionOfPairs, type ReplayError } from "../replay/replay.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";
import type { Patch } from "../domain/patch.js";

/** Every error `diffCmd` can produce. */
export type DiffError =
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | PlatformError
  | InvalidVersionError
  | UnsupportedWorkingTreeEntryError
  | InvalidPathError
  | ReplayError
  | UnknownVersionError
  | PatchCollisionError;

/** §7.6's working-tree arity: current tree vs the scan of the working tree. */
function diffWorkingTree(
  repoRoot: string,
): Effect.Effect<string, DiffError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);

    // §7.6's no-operand form compares the replayed current tree with the
    // scanned working tree; unsupported entries fail it (SPEC.md §10).
    const frontier = versionOfPairs(repository.frontier);
    const replayed = replay(frontier, repository.patches);
    if (Either.isLeft(replayed)) {
      return yield* Effect.fail(replayed.left);
    }

    const scan = yield* scanWorkingTree(repoRoot);
    const unsupported = firstUnsupportedError(scan);
    if (unsupported !== undefined) {
      return yield* Effect.fail(unsupported);
    }

    return renderTreeDiff(replayed.right.tree, scan.tree);
  });
}

/** §7.6's versions arity (`<old> <new> [--repo <repository>]`). */
function diffVersions(
  target: Extract<DiffTarget, { readonly _tag: "Versions" }>,
  repoRoot: string,
): Effect.Effect<string, DiffError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);

    const oldVersion = Version.parse(target.old);
    if (Either.isLeft(oldVersion)) {
      return yield* Effect.fail(oldVersion.left);
    }
    const newVersion = Version.parse(target.new);
    if (Either.isLeft(newVersion)) {
      return yield* Effect.fail(newVersion.left);
    }

    // Step 1: §7.6 resolves `old` against the local repository; an
    // unknown `old` is reported before any remote is consulted.
    const oldKnown = requireKnownVersion(oldVersion.right, repository.patches);
    if (Either.isLeft(oldKnown)) {
      return yield* Effect.fail(oldKnown.left);
    }

    // Step 2 + 3: the `--repo` branch diverges the patch set `new`
    // resolves against (and sentence 3's state in §4.1 stays local).
    if (target.repo === undefined) {
      const newKnown = requireKnownVersion(newVersion.right, repository.patches);
      if (Either.isLeft(newKnown)) {
        return yield* Effect.fail(newKnown.left);
      }
      return yield* renderVersions(
        oldVersion.right,
        newVersion.right,
        repository.patches,
        repository.patches,
      );
    }

    const remote = yield* loadRepositoryAt(target.repo);
    const padlock = checkDotCollisions(repository.patches, remote.patches);
    if (padlock !== undefined) {
      return yield* Effect.fail(padlock);
    }
    const joined: ReadonlyArray<Patch> = unionSortedPatches(
      repository.patches,
      remote.patches,
    );
    const newKnown = requireKnownVersion(newVersion.right, joined);
    if (Either.isLeft(newKnown)) {
      return yield* Effect.fail(newKnown.left);
    }
    return yield* renderVersions(oldVersion.right, newVersion.right, repository.patches, joined);
  });
}

/** Replays both known versions and renders the §7.6 difference. */
function renderVersions(
  oldVersion: Version,
  newVersion: Version,
  oldPatches: ReadonlyArray<Patch>,
  newPatches: ReadonlyArray<Patch>,
): Effect.Effect<string, ReplayError> {
  return Effect.gen(function* () {
    const oldTree = replay(oldVersion, oldPatches);
    if (Either.isLeft(oldTree)) {
      return yield* Effect.fail(oldTree.left);
    }
    const newTree = replay(newVersion, newPatches);
    if (Either.isLeft(newTree)) {
      return yield* Effect.fail(newTree.left);
    }
    return renderTreeDiff(oldTree.right.tree, newTree.right.tree);
  });
}

/**
 * Runs §7.6 from the process working directory. Returns the exact stdout
 * bytes of the rendered diff; a tree pair with no differences renders
 * `""` (success).
 */
export function diffCmd(
  diffTarget: DiffTarget,
): Effect.Effect<string, DiffError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const repoRoot = yield* locateRepository(".");
    if (diffTarget._tag === "WorkingTree") {
      return yield* diffWorkingTree(repoRoot);
    }
    return yield* diffVersions(diffTarget, repoRoot);
  });
}