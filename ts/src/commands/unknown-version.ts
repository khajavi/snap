/**
 * The "locally known version" check SPEC.md §7.7/§7.6 impose on version
 * operands (`revert <version>`, `diff <old> <new>`), and the
 * cross-repository variant §7.6's `--repo` adds for `new`.
 *
 * "Known" is SPEC.md §4.1's definition of a version a repository knows:
 * every patch `(c, n)` selected by `n <= V[c]` exists, and the selected
 * set contains the complete base of every selected patch. `selectPatches`
 * (via `selectAndOrderPatches`) enforces the second half but not the
 * first — a `V` naming a nonexistent dot simply excludes it, silently —
 * so this module also checks every entry of `V` names a patch that
 * actually exists (`indexPatchesByDot`). Both halves failing map to the
 * same user-visible error, SPEC.md's pinned `unknown version: <version>`
 * (tests/19 pin the exact line `snap: unknown version: (a@x->2)\n`;
 * tests/14 pin "unknown version" for a version whose author has no
 * configured contributor at all).
 */

import { Data, Either } from "effect";
import { dotKey, indexPatchesByDot, type DotKey } from "../domain/repository.js";
import { type Patch } from "../domain/patch.js";
import { type Version } from "../domain/version.js";
import { selectAndOrderPatches } from "../replay/select.js";

/**
 * The version is valid spec syntax but is not a version the repository
 * knows (SPEC.md §4.1). `detail` carries the exact, unprefixed pinned text
 * `unknown version: <canonical>`, prefixed with `snap: ` at the
 * CLI-error-rendering boundary.
 */
export class UnknownVersionError extends Data.TaggedError("UnknownVersionError")<{
  readonly detail: string;
}> {}

/** Whether any of the dots a version names is missing from `byDot`. */
function hasMissingDot(version: Version, byDot: ReadonlyMap<DotKey, Patch>): boolean {
  for (const [author, revision] of version.entries) {
    if (!byDot.has(dotKey(author, revision))) {
      return true;
    }
  }
  return false;
}

/**
 * Fails with `UnknownVersionError` unless every dot `V` names exists as a
 * patch and every selected patch's base is itself selected (SPEC.md §4.1)
 * — the "locally known target version" §7.7 requires, and the reason
 * `diff` reports `unknown version: <old>` before consulting any base
 * trees. Pure: `Either` over `patches`, no services.
 */
export function requireKnownVersion(
  version: Version,
  patches: ReadonlyArray<Patch>,
): Either.Either<void, UnknownVersionError> {
  const byDot = indexPatchesByDot(patches);
  if (hasMissingDot(version, byDot)) {
    return Either.left(
      new UnknownVersionError({ detail: `unknown version: ${version.toCanonicalString()}` }),
    );
  }
  const selected = selectAndOrderPatches(version, patches);
  if (Either.isLeft(selected)) {
    return Either.left(
      new UnknownVersionError({ detail: `unknown version: ${version.toCanonicalString()}` }),
    );
  }
  return Either.right(undefined);
}