/**
 * `snap status` (SPEC.md §7.3, plan.md Phase 8): print the current version
 * and the working changes sorted by path.
 *
 * The "current version" is the repository frontier; its tree is §6.1's
 * canonical replay of exactly the patches the frontier selects. The
 * working side is `fs/tree-scan.ts`'s scan of the repository root.
 * Changed paths are the per-path differences between the two trees,
 * classified with §7.3's three codes — `A` (absent→present), `D`
 * (present→absent), `M` (present, bytes changed) — and sorted by §2's
 * unsigned-UTF-8-byte path order (`domain/path.ts`'s
 * `compareTrackedPaths`; tests/25 pins `nested/file`, `z`, `é`, `😀` in
 * exactly that order). A clean tree prints only the version line.
 *
 * An unsupported entry (symlink, FIFO, ...) anywhere in the scan fails
 * the command before any status is printed (SPEC.md §10), reporting the
 * lowest-path offending entry so the message is deterministic when a
 * tree contains several.
 *
 * Status requires no contributor configuration (SPEC.md §8: only `commit`
 * and `revert` need an ID) and mutates nothing.
 */

import { Buffer } from "node:buffer";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Either } from "effect";
import type { InvalidPathError, TrackedPath } from "../domain/path.js";
import { compareTrackedPaths } from "../domain/path.js";
import { UnsupportedWorkingTreeEntryError, scanWorkingTree } from "../fs/tree-scan.js";
import { replay, versionOfPairs, type ReplayError } from "../replay/replay.js";
import type { PathState } from "../replay/tiebreak.js";
import { pathStatesEqual } from "../replay/tiebreak.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";

/** Every error `statusCmd` can produce. */
export type StatusError =
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | UnsupportedWorkingTreeEntryError
  | InvalidPathError
  | ReplayError
  | PlatformError;

/** The state of a path neither tree contains; comparisons against it are no-ops. */
const ABSENT: PathState = { _tag: "Absent" };

/** Unsigned-UTF-8-byte order over a repository-relative path, for the deterministic error pick. */
const byUtf8Bytes = (a: { readonly path: string }, b: { readonly path: string }): number =>
  Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));

/**
 * Runs §7.3 from the process working directory. Returns the exact stdout
 * bytes: the `version <canonical>` line plus one `<code> <path>` line per
 * changed path, LF-terminated (an empty repository prints only
 * `version ()\n`).
 */
export function statusCmd(): Effect.Effect<string, StatusError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const repoRoot = yield* locateRepository(".");
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);
    const frontier = versionOfPairs(repository.frontier);

    // Validation (§4.5 point 6) already replayed the frontier when the
    // repository was loaded, so this fold cannot fail for a repository
    // that loaded successfully — the branch exists to keep the failure
    // total rather than to be reachable.
    const replayed = replay(frontier, repository.patches);
    if (Either.isLeft(replayed)) {
      return yield* Effect.fail(replayed.left);
    }
    const currentTree = replayed.right.tree;

    const scan = yield* scanWorkingTree(repoRoot);
    if (scan.unsupported.length > 0) {
      const first = [...scan.unsupported].sort(byUtf8Bytes)[0]!;
      return yield* Effect.fail(new UnsupportedWorkingTreeEntryError({ path: first.path }));
    }

    const paths = unionPathsSorted(currentTree, scan.tree);
    const lines: string[] = [`version ${frontier.toCanonicalString()}`];
    for (const path of paths) {
      const current = currentTree.get(path) ?? ABSENT;
      const working = scan.tree.get(path) ?? ABSENT;
      if (current._tag === "Absent" && working._tag !== "Absent") {
        lines.push(`A ${path}`);
      } else if (current._tag !== "Absent" && working._tag === "Absent") {
        lines.push(`D ${path}`);
      } else if (
        current._tag !== "Absent" &&
        working._tag !== "Absent" &&
        !pathStatesEqual(current, working)
      ) {
        lines.push(`M ${path}`);
      }
    }
    return `${lines.join("\n")}\n`;
  });
}

/** Every path present in either tree, in §2's unsigned-UTF-8-byte path order. */
function unionPathsSorted(
  a: ReadonlyMap<TrackedPath, PathState>,
  b: ReadonlyMap<TrackedPath, PathState>,
): ReadonlyArray<TrackedPath> {
  const seen = new Set<TrackedPath>();
  for (const path of a.keys()) seen.add(path);
  for (const path of b.keys()) seen.add(path);
  return Array.from(seen).sort(compareTrackedPaths);
}
