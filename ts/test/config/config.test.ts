import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Option } from "effect";
import {
  CONTRIBUTOR_ID_REQUIRED_DETAIL,
  ConfigDecodeError,
  ConfigService,
  ConfigServiceLive,
  ContributorIdRequiredError,
  decodeConfig,
} from "../../src/config/config.js";
import { InvalidContributorIdError } from "../../src/domain/contributor.js";

/**
 * Service-level tests for SPEC.md §8's local/global contributor
 * configuration, following `fs/tree-scan.test.ts`'s established
 * convention: a real, disposable temp directory per test via
 * `FileSystem#makeTempDirectoryScoped`, rather than an in-memory fake —
 * this module's whole job is reading and writing real files at two fixed
 * paths (`.snap/config.json`, `$HOME/.snapconfig.json`), which only a real
 * filesystem backend can exercise honestly.
 *
 * Deliberately NOT `describe.concurrent`: several tests mutate the
 * process-global `process.env.HOME` (there is no `Env` service yet for
 * `ConfigService` to depend on instead — see config.ts's module doc
 * comment), and concurrent tests sharing that global would race. Each such
 * test restores `HOME` via a scoped finalizer (`withHome` below) so a
 * test failure never leaks a mutated `HOME` into later tests.
 */

const TestLayer = ConfigServiceLive.pipe(Layer.provideMerge(NodeFileSystem.layer));

/** Sets `process.env.HOME` to `value` (or deletes it) for the duration of the enclosing scope. */
const withHome = (value: string | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env["HOME"];
      if (value === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = value;
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = previous;
        }
      }),
  );

const writeFile = (fs: FileSystem.FileSystem, path: string, text: string) =>
  Effect.gen(function* () {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      yield* fs.makeDirectory(path.slice(0, slash), { recursive: true });
    }
    yield* fs.writeFileString(path, text);
  });

describe("config/config", () => {
  describe("decodeConfig (pure core)", () => {
    it("decodes the exact SPEC.md §8 shape", () => {
      const result = decodeConfig('{"contributor":{"id":"alice@example.com"}}');
      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.contributor?.id).toBe("alice@example.com");
      }
    });

    it("decodes an entirely empty object to no contributor", () => {
      const result = decodeConfig("{}");
      expect(result).toEqual(Either.right({ contributor: undefined }));
    });

    it("decodes a contributor object with no id to no contributor (falls through, not an error)", () => {
      const result = decodeConfig('{"contributor":{}}');
      expect(result).toEqual(Either.right({ contributor: undefined }));
    });

    it("rejects malformed JSON with a message containing \"invalid JSON\"", () => {
      const result = decodeConfig("not json");
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ConfigDecodeError);
        expect(result.left.detail).toContain("invalid JSON");
      }
    });

    it("rejects an unbalanced-but-partially-valid document as malformed JSON", () => {
      const result = decodeConfig('{"contributor":{"id":"a@x"}}}}');
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.detail).toContain("invalid JSON");
      }
    });

    it("rejects a duplicate object key, even with the textually-first value structurally valid", () => {
      // Deliberately hand-written (not JSON.stringify'd, which cannot
      // produce a duplicate key at all) so the raw text really does
      // contain "id" twice, the way a hand-edited config file could.
      const result = decodeConfig('{"contributor":{"id":"a@x","id":"b@x"}}');
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.detail).toContain('duplicate JSON key "id"');
      }
    });

    it("rejects an unknown top-level field", () => {
      const result = decodeConfig('{"contributor":{"id":"a@x"},"unexpected":true}');
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.detail).toContain("unknown field");
      }
    });

    it("rejects an unknown nested contributor field", () => {
      const result = decodeConfig('{"contributor":{"id":"a@x","nickname":"a"}}');
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.detail).toContain("unknown field");
      }
    });

    it("rejects an invalid contributor id, naming the reason", () => {
      const result = decodeConfig('{"contributor":{"id":"not-an-id"}}');
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.detail).toContain("invalid contributor id:");
      }
    });
  });

  it.layer(TestLayer)("ConfigService", (it) => {
    it.scoped("no local config and no $HOME set resolves to no ID, not an error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        const resolved = yield* config.resolveContributorId(root);

        expect(Option.isNone(resolved)).toBe(true);
      }),
    );

    it.scoped("$HOME unset entirely means global is unavailable, even with no local file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        const resolved = yield* config.resolveContributorId(root);

        expect(resolved).toEqual(Option.none());
      }),
    );

    it.scoped("a valid local ID is used and global is never consulted, even if global is malformed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"local@example.com"}}');
        // Malformed global content: if this were ever read, resolution
        // would fail. Local providing an ID must prevent that read.
        yield* writeFile(fs, `${home}/.snapconfig.json`, "not json");

        const resolved = yield* config.resolveContributorId(root);

        expect(resolved).toEqual(Option.some("local@example.com"));
      }),
    );

    it.scoped("a valid local ID wins over a different, well-formed global ID", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"local@example.com"}}');
        yield* writeFile(fs, `${home}/.snapconfig.json`, '{"contributor":{"id":"global@example.com"}}');

        const resolved = yield* config.resolveContributorId(root);

        expect(resolved).toEqual(Option.some("local@example.com"));
      }),
    );

    it.scoped(
      "a local config with no contributor.id falls through to a valid global ID",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ConfigService;
          const root = yield* fs.makeTempDirectoryScoped();
          const home = yield* fs.makeTempDirectoryScoped();
          yield* withHome(home);

          yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{}}');
          yield* writeFile(fs, `${home}/.snapconfig.json`, '{"contributor":{"id":"global@example.com"}}');

          const resolved = yield* config.resolveContributorId(root);

          expect(resolved).toEqual(Option.some("global@example.com"));
        }),
    );

    it.scoped("no local config file at all falls through to a valid global ID", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        yield* writeFile(fs, `${home}/.snapconfig.json`, '{"contributor":{"id":"global@example.com"}}');

        const resolved = yield* config.resolveContributorId(root);

        expect(resolved).toEqual(Option.some("global@example.com"));
      }),
    );

    it.scoped("no local config file and $HOME pointing at a directory with no global file is no ID, no error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        const resolved = yield* config.resolveContributorId(root);

        expect(resolved).toEqual(Option.none());
      }),
    );

    it.scoped("a malformed local config file is an error, regardless of global", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        yield* writeFile(fs, `${root}/.snap/config.json`, "not json");
        yield* writeFile(fs, `${home}/.snapconfig.json`, '{"contributor":{"id":"global@example.com"}}');

        const failure = yield* Effect.flip(config.resolveContributorId(root));

        expect(failure).toBeInstanceOf(ConfigDecodeError);
        expect((failure as ConfigDecodeError).detail).toContain("invalid JSON");
      }),
    );

    it.scoped("a malformed global config file is an error when local doesn't provide an ID", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = yield* fs.makeTempDirectoryScoped();
        yield* withHome(home);

        yield* writeFile(fs, `${home}/.snapconfig.json`, "not json");

        const failure = yield* Effect.flip(config.resolveContributorId(root));

        expect(failure).toBeInstanceOf(ConfigDecodeError);
        expect((failure as ConfigDecodeError).detail).toContain("invalid JSON");
      }),
    );

    it.scoped("a duplicate JSON key in the local config file is an error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"a@x","id":"b@x"}}');

        const failure = yield* Effect.flip(config.resolveContributorId(root));

        expect(failure).toBeInstanceOf(ConfigDecodeError);
        expect((failure as ConfigDecodeError).detail).toContain('duplicate JSON key "id"');
      }),
    );

    it.scoped("an unknown field in the local config file is an error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"a@x"},"extra":1}');

        const failure = yield* Effect.flip(config.resolveContributorId(root));

        expect(failure).toBeInstanceOf(ConfigDecodeError);
        expect((failure as ConfigDecodeError).detail).toContain("unknown field");
      }),
    );

    it.scoped("an invalid contributor id in the local config file is an error naming the reason", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"not-an-id"}}');

        const failure = yield* Effect.flip(config.resolveContributorId(root));

        expect(failure).toBeInstanceOf(ConfigDecodeError);
        expect((failure as ConfigDecodeError).detail).toContain("invalid contributor id:");
      }),
    );

    it.scoped("requireContributorId fails with SPEC.md §8's exact required-identity detail when absent everywhere", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        const failure = yield* Effect.flip(config.requireContributorId(root));

        expect(failure).toBeInstanceOf(ContributorIdRequiredError);
        expect(CONTRIBUTOR_ID_REQUIRED_DETAIL).toBe(
          "contributor.id is required; configure it locally or globally",
        );
      }),
    );

    it.scoped("requireContributorId resolves normally when an ID is available", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);

        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"a@x"}}');

        const id = yield* config.requireContributorId(root);

        expect(id).toBe("a@x");
      }),
    );

    it.scoped("writing a valid local contributor id then reading it back round-trips", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* withHome(undefined);
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        yield* config.writeLocalContributorId(root, "roundtrip@example.com");

        const text = yield* fs.readFileString(`${root}/.snap/config.json`);
        expect(text).toBe('{"contributor":{"id":"roundtrip@example.com"}}');

        const resolved = yield* config.resolveContributorId(root);
        expect(resolved).toEqual(Option.some("roundtrip@example.com"));
      }),
    );

    it.scoped("writing an invalid local contributor id fails and writes nothing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });

        const failure = yield* Effect.flip(config.writeLocalContributorId(root, "not an id"));

        expect(failure).toBeInstanceOf(InvalidContributorIdError);
        const exists = yield* fs.exists(`${root}/.snap/config.json`);
        expect(exists).toBe(false);
      }),
    );

    it.scoped("writing local config overwrites any previous content, unread and unvalidated", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ConfigService;
        const root = yield* fs.makeTempDirectoryScoped();

        // The previous file is malformed enough to fail decodeConfig, but
        // a write must never read (let alone validate) it first.
        yield* writeFile(fs, `${root}/.snap/config.json`, '{"contributor":{"id":"old@x"},"unexpected":true}');

        yield* config.writeLocalContributorId(root, "new@x");

        const text = yield* fs.readFileString(`${root}/.snap/config.json`);
        expect(text).toBe('{"contributor":{"id":"new@x"}}');
      }),
    );
  });
});
