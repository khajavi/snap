/**
 * Installing a target `Tree` onto disk (SPEC.md §6.2's closing paragraph):
 * "Installation removes files that block required directories, creates
 * required directories, writes target files, and removes newly empty
 * directories so the filesystem represents exactly that target path/byte
 * map."
 *
 * `materialize` always diffs the target tree against *actual disk state*
 * under `root` — it takes no "previous tree" parameter — so it stays
 * correct even when called after an unrelated external change (a stray
 * edit, a half-finished previous mutation, etc., per SPEC.md §10's failure
 * model). `.snap` and its contents are never part of the tracked tree
 * (SPEC.md §1.1 invariant 8), so this module never inspects or touches
 * anything under a top-level `.snap` entry.
 *
 * SPEC.md's own bullet list only names one blocking direction (a regular
 * file blocking a required directory), but the reverse is just as
 * reachable in practice — the working tree previously had `a/b` as a
 * file and the new target wants `a` itself to be a file — so writing a
 * target file also removes whatever non-file entry (ordinarily a leftover
 * directory) currently occupies that exact path first. The target tree is
 * prefix-free (SPEC.md §2), so a path can never simultaneously be a
 * target file and a required directory for another target path — the two
 * blocking directions never overlap for the same path.
 *
 * Uses the `@effect/platform` `FileSystem` service (a `Context.Tag`, so a
 * real `NodeFileSystem` layer or a fake layer can both be provided) rather
 * than talking to `node:fs` directly, per plan.md §1.1's service-shell
 * pattern.
 */

import { posix } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";
import type { TrackedPath } from "../domain/path.js";
import type { Tree } from "../replay/integrate.js";
import type { PathState } from "../replay/tiebreak.js";

/**
 * Interprets a raw disk-relative path string (from `readDirectory`) as a
 * `TrackedPath` for the sole purpose of checking membership in a `Tree`.
 * This is an fs-boundary escape hatch, not a grammar re-validation:
 * `materialize` only ever reads back path strings that came from real
 * directory entries actually rooted under `root`, never user input.
 */
const asTrackedPath = (path: string): TrackedPath => path as TrackedPath;

/** Every strict ancestor directory (root-relative, `/`-separated) of `path`, nearest first. */
function ancestorDirsOf(path: string): string[] {
  const dirs: string[] = [];
  let dir = posix.dirname(path);
  while (dir !== "." && dir !== "/") {
    dirs.push(dir);
    dir = posix.dirname(dir);
  }
  return dirs;
}

/** Reconstructs a `PathState`'s exact bytes (text tokens rejoined and UTF-8 encoded, or raw binary bytes). */
function bytesOfPathState(state: PathState): Uint8Array {
  switch (state._tag) {
    case "Text":
      return new TextEncoder().encode(state.tokens.join(""));
    case "Binary":
      return state.bytes;
    case "Absent":
      // A `Tree`'s map values are never `Absent` by construction (SPEC's
      // path/byte map expresses absence as map absence, per
      // `replay/integrate.ts`) — this is an invariant violation in a
      // caller, not a normal failure mode.
      throw new Error("materialize: target tree contains an explicit Absent entry");
  }
}

/**
 * Recursively lists every regular file under `root` (root-relative,
 * `/`-separated paths), skipping the top-level `.snap` entry entirely and
 * skipping any non-regular-file, non-directory entry it encounters (a
 * symlink, say) — detecting and reporting those is `fs/tree-scan.ts`'s
 * job for read-oriented commands, not this write-oriented module's.
 */
function listFiles(
  fs: FileSystem.FileSystem,
  root: string,
  relDir: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> {
  return Effect.gen(function* () {
    const dirFullPath = relDir === "" ? root : posix.join(root, relDir);
    const entries = yield* fs.readDirectory(dirFullPath);
    const results: string[] = [];
    for (const entry of entries) {
      if (relDir === "" && entry === ".snap") {
        continue;
      }
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      const fullPath = posix.join(root, relPath);
      const info = yield* fs.stat(fullPath);
      if (info.type === "Directory") {
        const nested = yield* listFiles(fs, root, relPath);
        results.push(...nested);
      } else if (info.type === "File") {
        results.push(relPath);
      }
    }
    return results;
  });
}

/**
 * Installs `target` onto disk under `root`, so the filesystem (excluding
 * `.snap`) ends up representing exactly `target`'s path/byte map:
 *
 * 1. Removes any on-disk non-directory entry that blocks a required
 *    directory for some target path.
 * 2. Creates every required directory.
 * 3. For every target path, removes whatever non-file entry currently
 *    occupies that exact path (the reverse blocking direction — see this
 *    module's doc comment), then writes its exact target bytes.
 * 4. Removes every on-disk file (outside `.snap`) that `target` does not
 *    contain.
 * 5. Prunes directories left empty by step 4's removals, recursively up
 *    to (but not including) `root`.
 */
export function materialize(
  root: string,
  target: Tree,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // Snapshot current disk state before any mutation below, so later
    // steps diff against what was actually there when `materialize` was
    // called, not against a tree passed in by the caller.
    const currentFiles = yield* listFiles(fs, root, "");

    // Every required ancestor directory for every target path, shallowest
    // first (so a shallow blocking file is removed before a deeper
    // descendant path is even considered).
    const requiredDirs = new Set<string>();
    for (const path of target.keys()) {
      for (const dir of ancestorDirsOf(path)) {
        requiredDirs.add(dir);
      }
    }
    const dirsShallowFirst = Array.from(requiredDirs).sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );

    // Step 1: remove any on-disk non-directory entry blocking a required directory.
    for (const dir of dirsShallowFirst) {
      const fullPath = posix.join(root, dir);
      const exists = yield* fs.exists(fullPath);
      if (exists) {
        const info = yield* fs.stat(fullPath);
        if (info.type !== "Directory") {
          yield* fs.remove(fullPath, { recursive: true, force: true });
        }
      }
    }

    // Step 2: create every required directory.
    for (const dir of dirsShallowFirst) {
      yield* fs.makeDirectory(posix.join(root, dir), { recursive: true });
    }

    // Step 3: write every target file, first clearing the reverse
    // blocking direction (a leftover directory occupying a target file's
    // exact path).
    for (const [path, state] of target) {
      const fullPath = posix.join(root, path);
      const exists = yield* fs.exists(fullPath);
      if (exists) {
        const info = yield* fs.stat(fullPath);
        if (info.type !== "File") {
          yield* fs.remove(fullPath, { recursive: true, force: true });
        }
      }
      yield* fs.writeFile(fullPath, bytesOfPathState(state));
    }

    // Step 4: remove on-disk files (outside `.snap`) absent from `target`.
    // A path from the step-0 snapshot that is now a required directory
    // (step 1 already removed it as a blocking file, and step 2 recreated
    // it as a directory to hold some target path underneath it) is not an
    // obsolete file — skip it here, or this would delete the directory
    // step 1-3 just legitimately (re)built.
    const removedPaths: string[] = [];
    for (const relPath of currentFiles) {
      if (!target.has(asTrackedPath(relPath)) && !requiredDirs.has(relPath)) {
        // `recursive: true` even though this was a plain file in the
        // step-0 snapshot: an earlier step in *this same* materialize
        // call (e.g. step 3's reverse-direction blocking-entry removal)
        // may have turned its path into a directory since then. Node's
        // `rm` requires `recursive: true` to remove any directory, even
        // an empty one.
        yield* fs.remove(posix.join(root, relPath), { recursive: true, force: true });
        removedPaths.push(relPath);
      }
    }

    // Step 5: prune directories left empty by step 4, deepest first, so a
    // parent that becomes empty only once its child is pruned is itself
    // reconsidered — never pruning past (or including) `root`.
    const dirsToRecheck = new Set<string>();
    for (const relPath of removedPaths) {
      for (const dir of ancestorDirsOf(relPath)) {
        dirsToRecheck.add(dir);
      }
    }
    const dirsDeepestFirst = Array.from(dirsToRecheck).sort(
      (a, b) => b.split("/").length - a.split("/").length,
    );
    for (const dir of dirsDeepestFirst) {
      const fullPath = posix.join(root, dir);
      const exists = yield* fs.exists(fullPath);
      if (!exists) {
        continue;
      }
      const info = yield* fs.stat(fullPath);
      if (info.type !== "Directory") {
        continue;
      }
      const entries = yield* fs.readDirectory(fullPath);
      if (entries.length === 0) {
        // Node's `rm` requires `recursive: true` to remove a directory
        // even when it is empty (plain `rm` on a directory is EISDIR).
        yield* fs.remove(fullPath, { recursive: true, force: true });
      }
    }
  });
}
