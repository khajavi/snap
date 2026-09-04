import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  checkPrefixFree,
  compareTrackedPaths,
  parseTrackedPath,
  type TrackedPath,
} from "../../src/domain/path.js";

// Fixtures drawn directly from SPEC.md §2's grammar ("A tracked path is a
// UTF-8 relative path using `/` separators. It MUST be nonempty, contain no
// ASCII control character or backslash, contain no empty, `.` or `..`
// segment, and have no first segment equal to `.snap`.") and cross-checked
// against tests/*.yaml's literal path-related failures: tests/15-repository
// -validation.yaml's ".snap/secret" ("path is invalid") and its "a"/"a/b"
// pair ("tree paths conflict").

describe("parseTrackedPath: accepts SPEC-shaped paths and preserves spelling", () => {
  const valid = [
    "f", // tests/15-repository-validation.yaml, tests/23-strict-validation-matrix.yaml
    "keep.txt", // tests/02-init-paths.yaml
    "a", // tests/15-repository-validation.yaml
    "a/b", // nested path, single segment below "a"
    "a/b/c", // multiple segments deep
    ".snapshot", // first segment merely starts with ".snap", isn't equal to it
    "dir/.snap", // ".snap" is forbidden only as the *first* segment
    "..hidden", // a segment of literal dots plus more isn't the ".." segment
    "café/résumé.txt", // non-ASCII UTF-8 is allowed; only ASCII control chars are forbidden
    "a>b", // '>' has no special meaning in the path grammar
    "a(b)", // '(' and ')' have no special meaning in the path grammar
  ] as const;

  it.each(valid)("%s", (input) => {
    const result = parseTrackedPath(input);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      // Spelling is preserved exactly: "Snap performs no Unicode or case normalization."
      expect(result.right as string).toBe(input);
    }
  });
});

describe("parseTrackedPath: rejects every grammar violation SPEC.md §2 calls out", () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["", "empty string is not nonempty"],
    [".snap", "first (and only) segment equal to \".snap\" (tests/15-repository-validation.yaml)"],
    [".snap/secret", "first segment equal to \".snap\" (tests/15-repository-validation.yaml)"],
    ["a//b", "empty segment between two slashes"],
    ["/a", "leading slash produces a leading empty segment"],
    ["a/", "trailing slash produces a trailing empty segment"],
    ["a/./b", "\".\" segment"],
    [".", "sole segment is \".\""],
    ["a/../b", "\"..\" segment"],
    ["..", "sole segment is \"..\""],
    ["a\\b", "contains a backslash"],
    ["a\tb", "contains a tab (ASCII control character)"],
    ["a\nb", "contains a newline (ASCII control character)"],
    ["a\u0000b", "contains a NUL control character"],
    ["a\u007fb", "contains DEL"],
  ];

  it.each(invalid)("%s (%s)", (input) => {
    const result = parseTrackedPath(input);
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("compareTrackedPaths: unsigned UTF-8 byte order (SPEC.md §2)", () => {
  it("orders simple ASCII paths lexicographically", () => {
    const a = "a" as TrackedPath;
    const b = "b" as TrackedPath;
    expect(compareTrackedPaths(a, b)).toBe(-1);
    expect(compareTrackedPaths(b, a)).toBe(1);
    expect(compareTrackedPaths(a, a)).toBe(0);
  });

  it("compares by byte value, not by locale collation", () => {
    // '/' (0x2F) sorts before any letter, so "a" precedes "a/b" precedes "ab".
    const a = "a" as TrackedPath;
    const aSlashB = "a/b" as TrackedPath;
    const ab = "ab" as TrackedPath;
    expect(compareTrackedPaths(a, aSlashB)).toBe(-1);
    expect(compareTrackedPaths(aSlashB, ab)).toBe(-1);
    expect(compareTrackedPaths(a, ab)).toBe(-1);
  });
});

describe("checkPrefixFree: SPEC.md §2's 'prefix-free by path segment' invariant", () => {
  it("accepts a set with no ancestor/descendant relationship", () => {
    const paths = ["a", "b", "c/d"].map((p) => p as TrackedPath);
    expect(Either.isRight(checkPrefixFree(paths))).toBe(true);
  });

  it("accepts an empty tree", () => {
    expect(Either.isRight(checkPrefixFree([]))).toBe(true);
  });

  it("accepts siblings that merely share a string prefix but not a path segment", () => {
    // "a" is not a segment-prefix of "ab" (SPEC.md: "if `a` is a file, no
    // `a/...` path is present" — the descendant must start with "a/").
    const paths = ["a", "ab"].map((p) => p as TrackedPath);
    expect(Either.isRight(checkPrefixFree(paths))).toBe(true);
  });

  it("rejects a file path with a descendant path (tests/15-repository-validation.yaml's 'a'/'a/b')", () => {
    const paths = ["a", "a/b"].map((p) => p as TrackedPath);
    const result = checkPrefixFree(paths);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.ancestorPath).toBe("a");
      expect(result.left.descendantPath).toBe("a/b");
    }
  });

  it("rejects a conflict several segments deep", () => {
    const paths = ["x/y", "x/y/z/w"].map((p) => p as TrackedPath);
    const result = checkPrefixFree(paths);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.ancestorPath).toBe("x/y");
      expect(result.left.descendantPath).toBe("x/y/z/w");
    }
  });

  it("detects the conflict regardless of the set's ordering", () => {
    const paths = ["a/b", "a"].map((p) => p as TrackedPath);
    expect(Either.isLeft(checkPrefixFree(paths))).toBe(true);
  });
});
