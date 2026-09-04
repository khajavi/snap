import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { atomicWriteFile } from "../../src/fs/atomic-write.js";

// SPEC.md §10: "Snap updates working files first and replaces
// `repository.json` through a same-directory temporary file only after
// the working-tree update succeeds." Each test runs against a fresh,
// disposable temp directory created via the `FileSystem` service's own
// `makeTempDirectoryScoped` — see `fs/materialize.test.ts` for the same
// convention.

it.layer(NodeFileSystem.layer)("fs/atomic-write", (it) => {
  it.scoped("creates a file that doesn't exist yet with the right content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = `${dir}/repository.json`;

      yield* atomicWriteFile(target, '{"a":1}');

      expect(yield* fs.readFileString(target)).toBe('{"a":1}');
    }),
  );

  it.scoped("replaces existing different content and leaves no temp file behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = `${dir}/repository.json`;

      yield* fs.writeFileString(target, "old content");
      yield* atomicWriteFile(target, "new content");

      expect(yield* fs.readFileString(target)).toBe("new content");

      const entries = yield* fs.readDirectory(dir);
      expect([...entries]).toEqual(["repository.json"]);
    }),
  );

  it.scoped("round-trips content with a trailing newline exactly (no accidental normalization)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = `${dir}/with-newline.txt`;

      yield* atomicWriteFile(target, "line one\nline two\n");

      const bytes = yield* fs.readFile(target);
      expect(new TextDecoder().decode(bytes)).toBe("line one\nline two\n");
    }),
  );

  it.scoped("round-trips content without a trailing newline exactly (no accidental normalization)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = `${dir}/no-newline.txt`;

      yield* atomicWriteFile(target, "no trailing newline");

      const bytes = yield* fs.readFile(target);
      expect(new TextDecoder().decode(bytes)).toBe("no trailing newline");
    }),
  );

  it.scoped("accepts raw bytes directly and round-trips them byte-for-byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = `${dir}/blob.bin`;
      const data = new Uint8Array([0x00, 0x10, 0xff, 0x0a]);

      yield* atomicWriteFile(target, data);

      const bytes = yield* fs.readFile(target);
      expect(Array.from(bytes)).toEqual(Array.from(data));
    }),
  );
});
