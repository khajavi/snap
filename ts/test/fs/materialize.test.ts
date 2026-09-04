import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { materialize } from "../../src/fs/materialize.js";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import type { Tree } from "../../src/replay/integrate.js";
import type { PathState } from "../../src/replay/tiebreak.js";

// SPEC.md §6.2's closing paragraph: "Installation removes files that block
// required directories, creates required directories, writes target
// files, and removes newly empty directories so the filesystem represents
// exactly that target path/byte map." `materialize` diffs the target tree
// against real disk state under a fresh, disposable temp directory per
// test — created via the `FileSystem` service's own
// `makeTempDirectoryScoped` (cleaned up automatically when the `it.scoped`
// test's scope closes) — the convention this module establishes for
// fs-service tests, since no sibling module had one yet.

/** Builds a validated `TrackedPath` fixture (fails loudly on a bad fixture). */
const path = (raw: string): TrackedPath => {
  const result = parseTrackedPath(raw);
  if (Either.isLeft(result)) {
    throw new Error(`fixture path is not a valid tracked path: ${raw}`);
  }
  return result.right;
};

/** A text `PathState` fixture. Content is kept as one token — `materialize` only ever rejoins tokens, never inspects boundaries. */
const text = (content: string): PathState => ({
  _tag: "Text",
  tokens: content.length === 0 ? [] : [content],
});

const binary = (bytes: Uint8Array): PathState => ({ _tag: "Binary", bytes });

const tree = (entries: ReadonlyArray<readonly [TrackedPath, PathState]>): Tree => new Map(entries);

it.layer(NodeFileSystem.layer)("fs/materialize", (it) => {
  it.scoped("installs onto a completely empty target directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const target = tree([
        [path("a.txt"), text("hello\n")],
        [path("dir/nested/b.txt"), text("world\n")],
      ]);

      yield* materialize(root, target);

      expect(yield* fs.readFileString(`${root}/a.txt`)).toBe("hello\n");
      expect(yield* fs.readFileString(`${root}/dir/nested/b.txt`)).toBe("world\n");
      const dirInfo = yield* fs.stat(`${root}/dir/nested`);
      expect(dirInfo.type).toBe("Directory");
    }),
  );

  it.scoped("removes a file blocking a required directory, then creates it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      // Disk has a regular file at `a`.
      yield* fs.writeFileString(`${root}/a`, "i am a file\n");

      // Target wants `a/b` — `a` must become a directory.
      const target = tree([[path("a/b"), text("inside\n")]]);

      yield* materialize(root, target);

      const info = yield* fs.stat(`${root}/a`);
      expect(info.type).toBe("Directory");
      expect(yield* fs.readFileString(`${root}/a/b`)).toBe("inside\n");
    }),
  );

  it.scoped("removes files no longer in the target tree and prunes directories left empty, but not past root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      yield* fs.writeFileString(`${root}/keep.txt`, "keep\n");
      yield* fs.makeDirectory(`${root}/old/nested`, { recursive: true });
      yield* fs.writeFileString(`${root}/old/nested/leaf.txt`, "gone\n");

      const target = tree([[path("keep.txt"), text("keep\n")]]);

      yield* materialize(root, target);

      expect(yield* fs.readFileString(`${root}/keep.txt`)).toBe("keep\n");
      expect(yield* fs.exists(`${root}/old/nested/leaf.txt`)).toBe(false);
      expect(yield* fs.exists(`${root}/old/nested`)).toBe(false);
      expect(yield* fs.exists(`${root}/old`)).toBe(false);
      // Pruning must stop at (not include) the root itself.
      expect(yield* fs.exists(root)).toBe(true);
    }),
  );

  it.scoped("re-materializing an already-correct tree is a no-op in effect", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const target = tree([
        [path("a.txt"), text("hello\n")],
        [path("dir/b.txt"), text("world\n")],
      ]);

      yield* materialize(root, target);
      yield* materialize(root, target);

      expect(yield* fs.readFileString(`${root}/a.txt`)).toBe("hello\n");
      expect(yield* fs.readFileString(`${root}/dir/b.txt`)).toBe("world\n");
      const rootEntries = yield* fs.readDirectory(root);
      expect([...rootEntries].sort()).toEqual(["a.txt", "dir"]);
      const dirEntries = yield* fs.readDirectory(`${root}/dir`);
      expect([...dirEntries].sort()).toEqual(["b.txt"]);
    }),
  );

  it.scoped("binary content round-trips byte-for-byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0a]);
      const target = tree([[path("blob.bin"), binary(bytes)]]);

      yield* materialize(root, target);

      const roundTripped = yield* fs.readFile(`${root}/blob.bin`);
      expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
    }),
  );
});
