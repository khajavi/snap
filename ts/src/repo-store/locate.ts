/**
 * Nearest-repository lookup (SPEC.md §7's commands intro paragraph):
 * "Snap locates the nearest repository by walking from the current
 * directory to the filesystem root."
 *
 * Uses the `@effect/platform` `FileSystem` service (a `Context.Tag`, so a
 * real `NodeFileSystem` layer or a fake layer can both be provided) rather
 * than talking to `node:fs` directly, per plan.md §1.1's service-shell
 * pattern — matching `fs/tree-scan.ts`'s convention of a standalone
 * exported function that only *requests* `FileSystem`, rather than a
 * multi-method `Context.Tag` service of its own (this module has exactly
 * one operation).
 */

import { dirname, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect } from "effect";

/** The repository's control directory, checked for at every level walked. */
const SNAP_DIR_NAME = ".snap";

/**
 * No `.snap` directory was found at `startDir` or any of its ancestors, up
 * to and including the filesystem root. `detail` carries SPEC.md's exact,
 * unprefixed pinned text (`tests/14-cli-errors.yaml`: `"snap: not a Snap
 * repository\n"`) — the `snap: ` prefix and trailing newline are added at
 * the CLI-error-rendering boundary (a later phase), per
 * `config/config.ts`'s `ContributorIdRequiredError`/
 * `CONTRIBUTOR_ID_REQUIRED_DETAIL` convention.
 */
export class RepositoryNotFoundError extends Data.TaggedError("RepositoryNotFoundError")<{}> {}

/** SPEC.md's exact pinned detail text for `RepositoryNotFoundError`, unprefixed. */
export const REPOSITORY_NOT_FOUND_DETAIL = "not a Snap repository";

/**
 * Walks from `startDir` upward (`startDir`, its parent, its parent's
 * parent, ...) looking for a `.snap` directory, stopping — successfully —
 * at the first level that has one, or — with `RepositoryNotFoundError` —
 * once the walk reaches the filesystem root without finding one.
 * `startDir` is resolved to an absolute path first, so a relative input
 * (e.g. `"."`) walks from the process's actual working directory.
 *
 * A path that exists but is not a directory (a stray regular file named
 * `.snap`) does not count as finding a repository — the walk continues
 * upward past it, exactly as if nothing were there.
 */
export function locateRepository(
  startDir: string,
): Effect.Effect<string, PlatformError | RepositoryNotFoundError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let current = resolve(startDir);

    for (;;) {
      const snapPath = `${current}/${SNAP_DIR_NAME}`;
      const exists = yield* fs.exists(snapPath);
      if (exists) {
        const info = yield* fs.stat(snapPath);
        if (info.type === "Directory") {
          return current;
        }
      }

      const parent = dirname(current);
      if (parent === current) {
        return yield* Effect.fail(new RepositoryNotFoundError());
      }
      current = parent;
    }
  });
}
