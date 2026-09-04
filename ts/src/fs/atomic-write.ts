/**
 * Same-directory temp-file-then-rename replacement for `repository.json`,
 * per SPEC.md §10's write ordering: "Snap updates working files first and
 * replaces `repository.json` through a same-directory temporary file only
 * after the working-tree update succeeds." §10 also requires that "an I/O
 * failure or process interruption during a multi-file update may leave a
 * dirty, partially updated working tree with the old `repository.json`" —
 * meaning the metadata file itself must never be observed half-written:
 * either the old bytes are still there, or the new ones are, never a
 * partial mix. Writing to a same-directory sibling and then renaming it
 * over the target gives that guarantee, since a rename within one
 * filesystem is atomic.
 *
 * Uses the `@effect/platform` `FileSystem` service (a `Context.Tag`, so a
 * real `NodeFileSystem` layer or a fake layer can both be provided) rather
 * than talking to `node:fs` directly, per plan.md §1.1's service-shell
 * pattern.
 */

import { randomUUID } from "node:crypto";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";

/**
 * Writes `content` to `path` by first writing it to a same-directory
 * sibling temporary file (`<path>.tmp-<random>`), then renaming that
 * temporary file over `path`. A rename within the same directory is an
 * atomic filesystem operation, so `path` is never observed in a
 * half-written state: a reader sees either the previous complete content
 * or the new complete content.
 *
 * On any failure — the initial write or the rename — the temporary file is
 * removed (best-effort; its own removal failure is ignored) before the
 * original error is re-raised, so a failed `atomicWriteFile` never leaves
 * a stray `<path>.tmp-*` sibling behind.
 */
export function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempPath = `${path}.tmp-${randomUUID()}`;
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;

    const writeThenRename = fs.writeFile(tempPath, data).pipe(
      Effect.andThen(() => fs.rename(tempPath, path)),
    );

    yield* writeThenRename.pipe(
      Effect.catchAll((error) =>
        fs.remove(tempPath, { force: true }).pipe(
          Effect.ignore,
          Effect.andThen(() => Effect.fail(error)),
        ),
      ),
    );
  });
}
