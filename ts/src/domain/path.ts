/**
 * Tracked-path grammar validation and prefix-free tree invariant checks
 * (SPEC.md §2).
 *
 * "A tracked path is a UTF-8 relative path using `/` separators. It MUST be
 * nonempty, contain no ASCII control character or backslash, contain no
 * empty, `.` or `..` segment, and have no first segment equal to `.snap`.
 * Snap performs no Unicode or case normalization. Paths sort by unsigned
 * lexicographic UTF-8 bytes."
 *
 * "Every tracked tree is prefix-free by path segment: if `a` is a file, no
 * `a/...` path is present. This is validated for every patch's authored
 * result [...]." The concurrent-replay enforcement mentioned alongside that
 * sentence is a separate mechanism (see `replay/integrate.ts`, a later
 * phase) — this module only validates one patch's authored result tree.
 */

import { Buffer } from "node:buffer";
import { Data, Either } from "effect";

/**
 * A tracked path that has passed `parseTrackedPath`. Branded so a bare
 * `string` can't be mistaken for one elsewhere in the domain.
 */
export type TrackedPath = string & { readonly __brand: "TrackedPath" };

export class InvalidPathError extends Data.TaggedError("InvalidPathError")<{
  readonly input: string;
  readonly reason: string;
}> {}

/**
 * Two distinct paths where one is a strict path-segment prefix of the
 * other, violating SPEC.md §2's "prefix-free by path segment" invariant.
 */
export class PathPrefixConflictError extends Data.TaggedError("PathPrefixConflictError")<{
  readonly ancestorPath: string;
  readonly descendantPath: string;
}> {}

/** ASCII control characters: 0x00-0x1F and 0x7F (DEL). */
function isAsciiControlCharacter(codePoint: number): boolean {
  return codePoint <= 0x1f || codePoint === 0x7f;
}

/**
 * Validates a tracked path against SPEC.md §2's grammar: nonempty, UTF-8,
 * `/`-separated, no ASCII control character or backslash anywhere, no
 * empty, `.`, or `..` segment, and no first segment equal to `.snap`.
 * Preserves the input's exact spelling on success (no Unicode or case
 * normalization, per SPEC.md §2).
 */
export function parseTrackedPath(input: string): Either.Either<TrackedPath, InvalidPathError> {
  const fail = (reason: string): Either.Either<TrackedPath, InvalidPathError> =>
    Either.left(new InvalidPathError({ input, reason }));

  if (input === "") {
    return fail("must be nonempty");
  }

  for (const char of input) {
    const codePoint = char.codePointAt(0);
    // `char` is a single code point yielded by string iteration, so this is defined.
    if (codePoint === undefined) {
      return fail("contains an invalid character");
    }
    if (isAsciiControlCharacter(codePoint)) {
      return fail("must not contain an ASCII control character");
    }
    if (char === "\\") {
      return fail("must not contain a backslash");
    }
  }

  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return fail("must not contain an empty segment");
    }
    if (segment === ".") {
      return fail('must not contain a "." segment');
    }
    if (segment === "..") {
      return fail('must not contain a ".." segment');
    }
  }

  // `segments` is nonempty because `input` is nonempty and none of its
  // segments are empty, so `segments[0]` is always defined here.
  if (segments[0] === ".snap") {
    return fail('first segment must not be ".snap"');
  }

  return Either.right(input as TrackedPath);
}

/**
 * Compares two tracked paths by unsigned UTF-8 bytes (SPEC.md §2: "Paths
 * sort by unsigned lexicographic UTF-8 bytes").
 */
export function compareTrackedPaths(a: TrackedPath, b: TrackedPath): -1 | 0 | 1 {
  const cmp = Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
}

/**
 * Checks that `paths` is prefix-free by path segment (SPEC.md §2): no path
 * in the set may be a strict segment-prefix of another (i.e. if `a` is
 * present, no `a/...` path may also be present). This validates a single
 * patch's authored result tree, per §2's "validated for every patch's
 * authored result" — it does not perform the separate concurrent-replay
 * enforcement §2 also mentions, which belongs to a later replay phase.
 */
export function checkPrefixFree(
  paths: ReadonlyArray<TrackedPath>,
): Either.Either<void, PathPrefixConflictError> {
  const pathSet = new Set<string>(paths);

  for (const path of paths) {
    const segments = path.split("/");
    let ancestor = segments[0] as string;
    for (let i = 1; i < segments.length; i++) {
      if (pathSet.has(ancestor)) {
        return Either.left(
          new PathPrefixConflictError({ ancestorPath: ancestor, descendantPath: path }),
        );
      }
      ancestor = `${ancestor}/${segments[i]}`;
    }
  }

  return Either.right(undefined);
}
