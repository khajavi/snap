import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { decodeRepository, type Repository } from "../../src/domain/repository.js";
import { encodeRepository, RepoStore, RepoStoreLive, RepositoryJsonSyntaxError } from "../../src/repo-store/store.js";
import { NonContiguousRevisionError, SchemaValidationError } from "../../src/errors/domain-errors.js";

/**
 * Service-level tests (plan.md §4 level 2) for `repo-store/store.ts`,
 * following `fs/tree-scan.test.ts`/`config/config.test.ts`'s established
 * convention: a real, disposable temp directory per test via
 * `FileSystem#makeTempDirectoryScoped`, shared `NodeFileSystem.layer` via
 * `it.layer`.
 */

const TestLayer = RepoStoreLive.pipe(Layer.provideMerge(NodeFileSystem.layer));

/** SPEC.md §4.1's worked example repository value, as raw JSON input. */
const WORKED_EXAMPLE_JSON = {
  format: 1,
  frontier: [["alice@example.com", 1]],
  patches: [
    {
      author: "alice@example.com",
      revision: 1,
      base: [],
      message: "add greeting",
      changes: [{ type: "text", path: "hello.txt", edit: [{ insert: ["hello\n"] }] }],
    },
  ],
};

/**
 * Exactly what `JSON.stringify(value, null, 2) + "\n"` produces for
 * `WORKED_EXAMPLE_JSON`'s structure: SPEC §4.1's worked example is
 * pretty-printed for readability with short arrays inlined onto one line,
 * but `encodeRepository`'s canonical two-space-indent encoding puts every
 * array/object element on its own line, so this fixture is the literal
 * expanded form, hand-verified against SPEC's stated indentation rule
 * rather than assumed.
 */
const EXPECTED_GOLDEN_BYTES = `{
  "format": 1,
  "frontier": [
    [
      "alice@example.com",
      1
    ]
  ],
  "patches": [
    {
      "author": "alice@example.com",
      "revision": 1,
      "base": [],
      "message": "add greeting",
      "changes": [
        {
          "type": "text",
          "path": "hello.txt",
          "edit": [
            {
              "insert": [
                "hello\\n"
              ]
            }
          ]
        }
      ]
    }
  ]
}
`;

const decodeOrThrow = (input: unknown): Repository => {
  const result = decodeRepository(input);
  if (Either.isLeft(result)) {
    throw new Error(`fixture repository failed to decode: ${JSON.stringify(result.left)}`);
  }
  return result.right;
};

describe("repo-store/store", () => {
  describe("encodeRepository (pure core, golden-byte)", () => {
    it("encodes SPEC §4.1's worked example byte-for-byte", () => {
      const repository = decodeOrThrow(WORKED_EXAMPLE_JSON);
      const bytes = encodeRepository(repository);
      expect(bytes).toBe(EXPECTED_GOLDEN_BYTES);
    });

    it("produces two-space indentation and a trailing LF for the empty repository", () => {
      const repository = decodeOrThrow({ format: 1, frontier: [], patches: [] });
      const bytes = encodeRepository(repository);
      expect(bytes).toBe('{\n  "format": 1,\n  "frontier": [],\n  "patches": []\n}\n');
    });
  });

  it.layer(TestLayer)("RepoStore", (it) => {
    it.scoped("save then load round-trips a repository value exactly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        const repository = decodeOrThrow(WORKED_EXAMPLE_JSON);
        yield* store.save(root, repository);

        const text = yield* fs.readFileString(`${root}/.snap/repository.json`);
        expect(text).toBe(EXPECTED_GOLDEN_BYTES);

        const loaded = yield* store.load(root);
        expect(loaded).toEqual(repository);
      }),
    );

    it.scoped("save then load round-trips the empty repository", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        const repository = decodeOrThrow({ format: 1, frontier: [], patches: [] });
        yield* store.save(root, repository);

        const loaded = yield* store.load(root);
        expect(loaded).toEqual(repository);
      }),
    );

    it.scoped("load on a missing repository.json surfaces a PlatformError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        const failure = yield* Effect.flip(store.load(root));

        // @effect/platform's FileSystem errors are `PlatformError`
        // (a `SystemError`/`BadArgument`), not one of this module's own
        // tagged errors.
        expect(failure).not.toBeInstanceOf(RepositoryJsonSyntaxError);
        expect((failure as { _tag?: string })._tag).toBeDefined();
      }),
    );

    it.scoped("load on malformed (non-JSON) text fails with RepositoryJsonSyntaxError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        yield* fs.writeFileString(`${root}/.snap/repository.json`, "not json");

        const failure = yield* Effect.flip(store.load(root));

        expect(failure).toBeInstanceOf(RepositoryJsonSyntaxError);
        expect((failure as RepositoryJsonSyntaxError).detail).toContain("invalid JSON");
      }),
    );

    it.scoped("load on a duplicate top-level JSON key fails with RepositoryJsonSyntaxError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        // Deliberately hand-written (not `JSON.stringify`'d, which cannot
        // produce a duplicate key at all), matching
        // `tests/15-repository-validation.yaml`'s exact fixture.
        yield* fs.writeFileString(
          `${root}/.snap/repository.json`,
          '{"format":1,"format":1,"frontier":[],"patches":[]}',
        );

        const failure = yield* Effect.flip(store.load(root));

        expect(failure).toBeInstanceOf(RepositoryJsonSyntaxError);
        expect((failure as RepositoryJsonSyntaxError).detail).toContain('duplicate JSON key "format"');
      }),
    );

    it.scoped("load on a schema-invalid repository fails with SchemaValidationError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* RepoStore;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/.snap/repository.json`,
          '{"format":1,"frontier":[],"patches":[],"unexpected":true}',
        );

        const failure = yield* Effect.flip(store.load(root));

        expect(failure).toBeInstanceOf(SchemaValidationError);
      }),
    );

    it.scoped(
      "load on a repository failing validateRepository's causal pipeline (a revision gap) surfaces NonContiguousRevisionError",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const store = yield* RepoStore;
          const root = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
          // `tests/15-repository-validation.yaml`'s exact "gap" fixture:
          // the sole patch is revision 2 for a@x with no revision 1
          // preceding it — SPEC.md §3.5's serial-contributor rule
          // ("revision n ... follows n-1"), caught by point 2 of the
          // pipeline (`checkPatchSortingDuplicatesAndContiguity`) before
          // point 3's base-closure check is ever reached.
          yield* fs.writeFileString(
            `${root}/.snap/repository.json`,
            JSON.stringify({
              format: 1,
              frontier: [["a@x", 2]],
              patches: [
                {
                  author: "a@x",
                  revision: 2,
                  base: [["a@x", 1]],
                  message: "gap",
                  changes: [{ type: "text", path: "f", edit: [] }],
                },
              ],
            }),
          );

          const failure = yield* Effect.flip(store.load(root));

          expect(failure).toBeInstanceOf(NonContiguousRevisionError);
        }),
    );
  });
});
