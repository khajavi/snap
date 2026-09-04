import { describe, expect, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { FileSystem } from "@effect/platform/FileSystem";
import { NodeFileSystem } from "@effect/platform-node";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import type { PathState } from "../../src/replay/tiebreak.js";
import type { Tree } from "../../src/replay/integrate.js";
import { isCleanAgainstCurrentTree, scanWorkingTree } from "../../src/fs/tree-scan.js";

/**
 * Service-level tests (plan.md §4 level 2) for the first module that
 * touches real filesystem I/O. Convention established here for later
 * `fs/*` modules: share one `FileSystem` layer (`NodeFileSystem.layer`)
 * across the file via `it.layer`, and inside each test use `it.scoped`
 * with `FileSystem#makeTempDirectoryScoped` to get a real, disposable
 * temp directory that is automatically removed when the test's `Scope`
 * closes — no manual `mkdtemp`/cleanup bookkeeping, and no in-memory fake:
 * this module's whole job is walking a real directory tree and telling
 * symlinks apart from regular files, which only a real filesystem backend
 * can exercise honestly.
 */

const path = (raw: string): TrackedPath => {
  const result = parseTrackedPath(raw);
  if (Either.isLeft(result)) {
    throw new Error(`fixture path is not a valid tracked path: ${raw}`);
  }
  return result.right;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe.concurrent("fs/tree-scan", () => {
  it.layer(NodeFileSystem.layer)("scanWorkingTree", (it) => {
    it.scoped("an empty working tree (just .snap/) scans to an empty tree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        yield* fs.writeFile(`${root}/.snap/repository.json`, utf8("{}"));

        const result = yield* scanWorkingTree(root);

        expect(result.tree.size).toBe(0);
        expect(result.unsupported).toEqual([]);
      }),
    );

    it.scoped("nested files scan correctly, excluding .snap and its contents", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();

        yield* fs.makeDirectory(`${root}/.snap`, { recursive: true });
        yield* fs.writeFile(`${root}/.snap/repository.json`, utf8("should not be scanned"));

        yield* fs.makeDirectory(`${root}/a/b`, { recursive: true });
        yield* fs.writeFile(`${root}/top.txt`, utf8("top"));
        yield* fs.writeFile(`${root}/a/mid.txt`, utf8("mid"));
        yield* fs.writeFile(`${root}/a/b/deep.txt`, utf8("deep"));

        const result = yield* scanWorkingTree(root);

        expect(result.unsupported).toEqual([]);
        expect([...result.tree.keys()].sort()).toEqual(["a/b/deep.txt", "a/mid.txt", "top.txt"]);
        expect(result.tree.get(path("top.txt"))).toEqual({ _tag: "Text", tokens: ["top"] });
        expect(result.tree.get(path("a/mid.txt"))).toEqual({ _tag: "Text", tokens: ["mid"] });
        expect(result.tree.get(path("a/b/deep.txt"))).toEqual({ _tag: "Text", tokens: ["deep"] });
      }),
    );

    it.scoped(
      "a .snap directory containing something that would otherwise look trackable is still excluded",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();

          yield* fs.makeDirectory(`${root}/.snap/nested`, { recursive: true });
          yield* fs.writeFile(`${root}/.snap/nested/looks-trackable.txt`, utf8("nope"));
          yield* fs.writeFile(`${root}/real.txt`, utf8("real"));

          const result = yield* scanWorkingTree(root);

          expect(result.unsupported).toEqual([]);
          expect([...result.tree.keys()]).toEqual(["real.txt"]);
        }),
    );

    it.scoped(
      "a symlink is reported as unsupported, not followed, and other files still scan",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const root = yield* fs.makeTempDirectoryScoped();

          yield* fs.writeFile(`${root}/target.txt`, utf8("target contents"));
          yield* fs.writeFile(`${root}/other.txt`, utf8("other"));
          yield* fs.symlink(`${root}/target.txt`, `${root}/link.txt`);

          const result = yield* scanWorkingTree(root);

          expect(result.unsupported).toEqual([{ path: "link.txt", kind: "SymbolicLink" }]);
          expect([...result.tree.keys()].sort()).toEqual(["other.txt", "target.txt"]);
        }),
    );

    it.scoped("a broken symlink (dangling target) is still reported as unsupported, not an error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();

        yield* fs.symlink(`${root}/does-not-exist.txt`, `${root}/dangling.txt`);
        yield* fs.writeFile(`${root}/ok.txt`, utf8("ok"));

        const result = yield* scanWorkingTree(root);

        expect(result.unsupported).toEqual([{ path: "dangling.txt", kind: "SymbolicLink" }]);
        expect([...result.tree.keys()]).toEqual(["ok.txt"]);
      }),
    );

    it.scoped("text vs binary classification round-trips through the scan", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();

        yield* fs.writeFile(`${root}/text.txt`, utf8("line one\nline two"));
        yield* fs.writeFile(`${root}/binary.bin`, new Uint8Array([0x41, 0x00, 0x42]));

        const result = yield* scanWorkingTree(root);

        expect(result.tree.get(path("text.txt"))).toEqual({
          _tag: "Text",
          tokens: ["line one\n", "line two"],
        });
        const binaryState = result.tree.get(path("binary.bin"));
        expect(binaryState?._tag).toBe("Binary");
        if (binaryState?._tag === "Binary") {
          expect([...binaryState.bytes]).toEqual([0x41, 0x00, 0x42]);
        }
      }),
    );
  });
});

describe("isCleanAgainstCurrentTree", () => {
  const textState = (tokens: ReadonlyArray<string>): PathState => ({ _tag: "Text", tokens });

  it("is true when the scan has no unsupported entries and matches the current tree exactly", () => {
    const tree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);
    const currentTree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);

    expect(isCleanAgainstCurrentTree(tree, [], currentTree)).toBe(true);
  });

  it("is false when content differs at a shared path (dirty)", () => {
    const tree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);
    const currentTree: Tree = new Map([[path("a.txt"), textState(["goodbye"])]]);

    expect(isCleanAgainstCurrentTree(tree, [], currentTree)).toBe(false);
  });

  it("is false when the key sets differ, even if all shared content matches", () => {
    const tree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);
    const currentTree: Tree = new Map([
      [path("a.txt"), textState(["hello"])],
      [path("b.txt"), textState(["extra"])],
    ]);

    expect(isCleanAgainstCurrentTree(tree, [], currentTree)).toBe(false);
  });

  it("is false when an unsupported entry is present, even with matching content", () => {
    const tree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);
    const currentTree: Tree = new Map([[path("a.txt"), textState(["hello"])]]);

    expect(isCleanAgainstCurrentTree(tree, [{ path: "link.txt", kind: "SymbolicLink" }], currentTree)).toBe(
      false,
    );
  });
});
