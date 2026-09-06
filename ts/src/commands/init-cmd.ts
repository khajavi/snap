/**
 * `snap init [path]` (SPEC.md §7.1, plan.md Phase 8): create the target
 * directory if absent, then an empty `.snap/repository.json` inside it.
 *
 * §7.1's two rejection rules are checked *before anything is created* —
 * tests/02-init-paths.yaml asserts `repo/child/.snap` does not exist after
 * a nested-init failure, so the precondition walk must never leave
 * partial filesystem state behind:
 *
 *   1. **Reinitializing a repository is an error.** The target itself
 *      already contains a `.snap` directory → "repository already exists".
 *   2. **Initializing a target inside an existing repository is an
 *      error.** Any *strict ancestor* of the target contains a `.snap`
 *      directory → "cannot initialize inside repository". (Splitting the
 *      two is what makes the pinned tests' messages line up: `init` run
 *      twice in one directory hits rule 1, `init` in a subdirectory of a
 *      repository hits rule 2.)
 *
 * Like `repo-store/locate.ts`, a `.snap` that exists but is not a
 * directory does not count as finding a repository — only a real
 * directory marks a repository root, matching `locateRepository`'s walk
 * so `init`'s preconditions and every other command's lookup agree on
 * what a repository is.
 *
 * The repository file itself is written through `RepoStore.save`, so the
 * empty repository's bytes come from the one canonical encoder in
 * `repo-store/store.ts` and can never drift from what the other commands
 * (and a later phase's `--serve`) read and emit.
 *
 * Output is the empty version, `()` plus LF (tests/01 pins `"()\n"`).
 */

import { dirname, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect } from "effect";
import type { Repository } from "../domain/repository.js";
import { RepoStore } from "../repo-store/store.js";

/** SPEC.md §7.1's exact reinitialization detail text, unprefixed. */
export const REPOSITORY_ALREADY_EXISTS_DETAIL = "repository already exists";

/** SPEC.md §7.1's exact nested-initialization detail text, unprefixed. */
export const INSIDE_EXISTING_REPOSITORY_DETAIL = "cannot initialize inside repository";

/** §7.1: "Reinitializing a repository is an error." */
export class RepositoryAlreadyExistsError extends Data.TaggedError("RepositoryAlreadyExistsError")<{}> {}

/** §7.1: "Initializing a target inside an existing repository is an error." */
export class InsideExistingRepositoryError extends Data.TaggedError("InsideExistingRepositoryError")<{}> {}

/** Every error `initCmd` can produce. */
export type InitError =
  | RepositoryAlreadyExistsError
  | InsideExistingRepositoryError
  | PlatformError;

/** §7.1: "Creates an empty `.snap/repository.json`" — the empty frontier and patch set. */
const EMPTY_REPOSITORY: Repository = { format: 1, frontier: [], patches: [] };

/** True iff `path` exists and is a directory (a stray file named `.snap` is not a repository). */
const isDirectory = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(path);
    if (!exists) {
      return false;
    }
    const info = yield* fs.stat(path);
    return info.type === "Directory";
  });

/**
 * Runs §7.1 against the operand `path` (undefined = the grammar's `.`
 * default, resolved against the process working directory like every
 * local path). Returns the exact stdout bytes: `()\n`.
 */
export function initCmd(
  path: string | undefined,
): Effect.Effect<string, InitError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = resolve(path ?? ".");
    const targetSnap = `${target}/.snap`;

    if (yield* isDirectory(fs, targetSnap)) {
      return yield* Effect.fail(new RepositoryAlreadyExistsError());
    }

    // Walk the strict ancestors up to (and including) the filesystem root;
    // the target itself was already ruled out above.
    let ancestor = dirname(target);
    for (;;) {
      if (yield* isDirectory(fs, `${ancestor}/.snap`)) {
        return yield* Effect.fail(new InsideExistingRepositoryError());
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }

    // Preconditions held; only now is anything created. The recursive
    // mkdir also creates the operand's intermediate directories
    // (tests/02's `init new/repository`).
    yield* fs.makeDirectory(targetSnap, { recursive: true });
    const store = yield* RepoStore;
    yield* store.save(target, EMPTY_REPOSITORY);
    return "()\n";
  });
}
