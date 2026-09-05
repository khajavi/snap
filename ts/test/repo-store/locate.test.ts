import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { locateRepository, RepositoryNotFoundError } from "../../src/repo-store/locate.js";

/**
 * Service-level tests (plan.md §4 level 2) for `repo-store/locate.ts`,
 * following `fs/tree-scan.test.ts`/`config/config.test.ts`'s established
 * convention: a real, disposable temp directory per test via
 * `FileSystem#makeTempDirectoryScoped`, shared `NodeFileSystem.layer` via
 * `it.layer`.
 */
describe.concurrent("repo-store/locate", () => {
  it.layer(NodeFileSystem.layer)("locateRepository", (it) => {
    it.scoped("finds a .snap directory at the starting point immediately", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        const found = yield* locateRepository(root);

        expect(found).toBe(root);
      }),
    );

    it.scoped("finds a .snap directory several levels up by walking upward", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        yield* fs.makeDirectory(`${root}/a/b/c`, { recursive: true });

        const found = yield* locateRepository(`${root}/a/b/c`);

        expect(found).toBe(root);
      }),
    );

    it.scoped("stops at the first ancestor with .snap, not a more distant one", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outer = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${outer}/.snap`, { recursive: true });
        yield* fs.makeDirectory(`${outer}/inner/deeper`, { recursive: true });
        yield* fs.makeDirectory(`${outer}/inner/.snap`, { recursive: true });

        const found = yield* locateRepository(`${outer}/inner/deeper`);

        expect(found).toBe(`${outer}/inner`);
      }),
    );

    it.scoped(
      "a stray non-directory .snap entry does not count; the walk continues past it",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outer = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(`${outer}/.snap`, { recursive: true });
          yield* fs.makeDirectory(`${outer}/inner`, { recursive: true });
          // A plain file named `.snap`, not a directory, one level below
          // the real repository root.
          yield* fs.writeFileString(`${outer}/inner/.snap`, "not a directory");

          const found = yield* locateRepository(`${outer}/inner`);

          expect(found).toBe(outer);
        }),
    );

    it.scoped(
      "no .snap anywhere up to the filesystem root fails with RepositoryNotFoundError",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();

          const failure = yield* Effect.flip(locateRepository(root));

          expect(failure).toBeInstanceOf(RepositoryNotFoundError);
        }),
    );
  });
});
