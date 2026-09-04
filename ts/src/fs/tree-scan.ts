/**
 * Working-tree scan (SPEC.md §2): walks the repository root, excluding the
 * top-level `.snap` directory entirely, and builds a path/byte map of every
 * tracked regular file plus the list of unsupported filesystem entries
 * (symlinks, FIFOs, etc.) it finds along the way.
 *
 * "Snap tracks every regular file below the repository root except `.snap/`
 * and its contents. ... Directories are implicit; empty directories are not
 * tracked. Symlinks and other non-regular filesystem entries are
 * unsupported. Snap MUST report them and MUST NOT follow them."
 *
 * This is the first module in the codebase to touch real filesystem I/O and
 * the first real Effect service consumer (plan.md §1.1): it only *requests*
 * `@effect/platform`'s `FileSystem` service (a `Context.Tag`) rather than
 * importing `node:fs` directly, so it is swappable onto any `FileSystem`
 * layer (real Node backend in production, a fake/no-op layer in a unit
 * test that doesn't need real I/O).
 *
 * Symlink detection deliberately avoids `FileSystem#stat`: the Node backend
 * implements `stat` with `fs.stat` (which follows symlinks to the target),
 * not `fs.lstat`, and `@effect/platform`'s `FileSystem` service exposes no
 * `lstat` method at all. `FileSystem#readLink` is used instead — it reads a
 * symlink's own target text without opening or following it to the target's
 * content, and it fails (anything other than success is treated as "not a
 * symlink") for every non-symlink entry, at which point `stat` is safe to
 * call because there is no link left to follow.
 */

import { Effect, Either } from "effect";
import type { PlatformError } from "@effect/platform/Error";
import { FileSystem } from "@effect/platform/FileSystem";
import type { File } from "@effect/platform/FileSystem";
import { InvalidPathError, parseTrackedPath, type TrackedPath } from "../domain/path.js";
import type { Tree } from "../replay/integrate.js";
import { pathStateFromBytes, pathStatesEqual, type PathState } from "../replay/tiebreak.js";

/** The repository's control directory, excluded at the working-tree root only. */
const SNAP_DIR_NAME = ".snap";

/**
 * A non-regular, non-directory filesystem entry's kind, per whatever
 * `FileSystem#stat` reports beyond `"File"`/`"Directory"` (`File.Info`'s
 * `type` discriminant) — plus `"SymbolicLink"`, which this module detects
 * itself via `readLink` rather than via `stat` (see the module doc comment).
 */
export type UnsupportedKind = Exclude<File.Type, "File" | "Directory">;

/**
 * One unsupported entry found during a scan: its path relative to the
 * repository root (using `/` separators, matching a tracked path's shape,
 * though it is a plain `string` here rather than a validated `TrackedPath`
 * — SPEC.md never requires an unsupported entry's path to satisfy the
 * tracked-path grammar, only that it be reported) and the kind of entry it
 * is.
 */
export interface UnsupportedEntry {
  readonly path: string;
  readonly kind: UnsupportedKind;
}

/** The result of scanning a working tree: its supported and unsupported contents. */
export interface WorkingTreeScan {
  /** Every tracked regular file found, as a `replay/integrate.ts`-shaped `Tree`. */
  readonly tree: Tree;
  /** Every symlink or other non-regular entry found; the scan does not stop at the first one. */
  readonly unsupported: ReadonlyArray<UnsupportedEntry>;
}

/** Joins a tracked-path-shaped relative path with one more segment, `/`-separated. */
const joinRelative = (parent: string, name: string): string =>
  parent === "" ? name : `${parent}/${name}`;

/** Resolves a working-tree-relative path against the scan's disk root. */
const joinDisk = (root: string, relativePath: string): string =>
  relativePath === "" ? root : `${root}/${relativePath}`;

/**
 * Scans the working tree rooted at `root` (SPEC.md §2), returning the
 * path/byte map of every tracked regular file (classified text/binary via
 * `replay/tiebreak.ts`'s `pathStateFromBytes`, which itself goes through
 * `domain/text.ts`'s `classify`) and the full list of unsupported entries
 * encountered. The scan:
 *
 *   - Never descends into the top-level `.snap` directory and never reports
 *     anything inside it.
 *   - Does not stop at the first unsupported entry: every symlink or other
 *     non-regular entry is recorded and the walk continues past it.
 *   - Never follows a symlink (see the module doc comment for how that's
 *     achieved without a `lstat` method on `FileSystem`).
 *   - Treats directories as implicit: only file contents are reported, and
 *     an empty directory contributes nothing to either list.
 *
 * Every regular file's relative path must parse as a `TrackedPath`
 * (`domain/path.ts`'s `parseTrackedPath`); one that does not fails the
 * whole scan with the same `InvalidPathError` that grammar validation uses
 * elsewhere; a path on disk that fails this is presumably impossible on
 * most filesystems (SPEC.md's tracked-path grammar excludes only ASCII
 * control characters, backslash, and a few reserved segment spellings), but
 * this is a reportable condition, not a silently dropped entry.
 */
export function scanWorkingTree(
  root: string,
): Effect.Effect<WorkingTreeScan, PlatformError | InvalidPathError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const tree = new Map<TrackedPath, PathState>();
    const unsupported: UnsupportedEntry[] = [];

    const walk = (relativeDir: string, isRoot: boolean): Effect.Effect<void, PlatformError | InvalidPathError> =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(joinDisk(root, relativeDir));

        for (const name of names) {
          if (isRoot && name === SNAP_DIR_NAME) {
            continue;
          }

          const relativePath = joinRelative(relativeDir, name);
          const diskPath = joinDisk(root, relativePath);

          // A symlink is detected by successfully reading its own target
          // text, never by `stat`ing it (that would follow it). Any failure
          // here (including "not a symlink") is treated as "not a
          // symlink" and falls through to `stat` below.
          const linkTarget = yield* Effect.option(fs.readLink(diskPath));
          if (linkTarget._tag === "Some") {
            unsupported.push({ path: relativePath, kind: "SymbolicLink" });
            continue;
          }

          const info = yield* fs.stat(diskPath);
          if (info.type === "Directory") {
            yield* walk(relativePath, false);
            continue;
          }
          if (info.type === "File") {
            const parsed = parseTrackedPath(relativePath);
            if (Either.isLeft(parsed)) {
              return yield* Effect.fail(parsed.left);
            }
            const bytes = yield* fs.readFile(diskPath);
            tree.set(parsed.right, pathStateFromBytes(bytes));
            continue;
          }
          unsupported.push({ path: relativePath, kind: info.type });
        }
      });

    yield* walk("", true);

    return { tree, unsupported };
  });
}

/**
 * SPEC.md §2's exact clean/dirty definition: "The working tree is clean
 * when its path/byte map exactly equals the current tree and contains no
 * unsupported entry. Otherwise it is dirty." `scanned` and `currentTree`
 * are compared structurally, per path, via `replay/tiebreak.ts`'s
 * `pathStatesEqual` — same key sets (checked by size plus per-key presence)
 * and, for every shared key, the same text/binary content.
 */
export function isCleanAgainstCurrentTree(
  scanned: Tree,
  unsupported: ReadonlyArray<UnsupportedEntry>,
  currentTree: Tree,
): boolean {
  if (unsupported.length > 0) {
    return false;
  }
  if (scanned.size !== currentTree.size) {
    return false;
  }
  for (const [path, state] of scanned) {
    const currentState = currentTree.get(path);
    if (currentState === undefined || !pathStatesEqual(state, currentState)) {
      return false;
    }
  }
  return true;
}
