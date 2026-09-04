/**
 * The vector-clock version type (SPEC.md §3.2-§3.4): canonical syntax
 * parse/print, four-way causal comparison, join, and Snap order.
 *
 * A version is an immutable map from contributor ID to revision, with an
 * absent contributor implicitly at revision 0. `Version` values are only
 * ever produced by `Version.empty`, `Version.parse`, or `Version.join` —
 * the constructor is private so every instance in circulation is known to
 * satisfy the canonical-form invariant (sorted, deduplicated, all
 * revisions in `[1, MAX_REVISION]`).
 */

import { Data, Either } from "effect";
import {
  compareContributorIds,
  parseContributorId,
  type ContributorId,
} from "./contributor.js";

/**
 * A vector-clock revision (SPEC.md §3.1): a positive integer no greater
 * than JavaScript's maximum safe integer. Zero means "no revision" and is
 * never stored as an explicit entry.
 */
export type Revision = number;

/** SPEC.md §3.1: "a positive integer no greater than JavaScript's maximum safe integer". */
export const MAX_REVISION: Revision = Number.MAX_SAFE_INTEGER; // 9007199254740991

const MAX_REVISION_DIGITS = String(MAX_REVISION);

export class InvalidVersionError extends Data.TaggedError("InvalidVersionError")<{
  readonly input: string;
  readonly reason: string;
}> {}

/** The four causal outcomes SPEC.md §3.3 requires a version type to preserve. */
export type VersionOrdering = "equal" | "before" | "after" | "concurrent";

type Entry = readonly [ContributorId, Revision];

/** True iff `digits` (a nonempty string of ASCII digits) exceeds `MAX_REVISION`. */
function digitsOverflowMaxRevision(digits: string): boolean {
  if (digits.length !== MAX_REVISION_DIGITS.length) {
    return digits.length > MAX_REVISION_DIGITS.length;
  }
  // Equal length: for same-length nonnegative-integer digit strings,
  // lexicographic order and numeric order agree.
  return digits > MAX_REVISION_DIGITS;
}

/** Looks up `id`'s revision in canonically-sorted `entries`, defaulting to 0. */
function revisionOfEntries(entries: ReadonlyArray<Entry>, id: ContributorId): Revision {
  for (const [entryId, revision] of entries) {
    if (entryId === id) return revision;
  }
  return 0;
}

/** The sorted union (by unsigned UTF-8 bytes) of two entry lists' contributor IDs. */
function unionContributorIds(
  a: ReadonlyArray<Entry>,
  b: ReadonlyArray<Entry>,
): ReadonlyArray<ContributorId> {
  const seen = new Set<ContributorId>();
  for (const [id] of a) seen.add(id);
  for (const [id] of b) seen.add(id);
  return Array.from(seen).sort(compareContributorIds);
}

export class Version {
  private constructor(readonly entries: ReadonlyArray<Entry>) {}

  /** SPEC.md §3.2: "The empty version is `()`." */
  static readonly empty: Version = new Version([]);

  /**
   * Parses SPEC.md §3.2's canonical syntax: `()` for the empty version, or
   * `(id->revision,...)` with contributors sorted by unsigned UTF-8 bytes
   * and no spaces. Duplicate IDs, explicit zeroes, leading zeroes,
   * overflow, invalid IDs, whitespace, and noncanonical ordering are all
   * rejected, matching SPEC.md §3.2's exhaustive error list.
   */
  static parse(input: string): Either.Either<Version, InvalidVersionError> {
    const fail = (reason: string): Either.Either<Version, InvalidVersionError> =>
      Either.left(new InvalidVersionError({ input, reason }));

    if (!input.startsWith("(") || !input.endsWith(")") || input.length < 2) {
      return fail("must be enclosed in parentheses");
    }
    const inner = input.slice(1, -1);
    if (inner === "") {
      return Either.right(Version.empty);
    }

    const parts = inner.split(",");
    const entries: Entry[] = [];
    let previousId: ContributorId | undefined;

    for (const part of parts) {
      if (part === "") {
        return fail("contains an empty entry");
      }
      const sepIndex = part.indexOf("->");
      if (sepIndex === -1) {
        return fail(`entry is missing "->": ${part}`);
      }
      const idText = part.slice(0, sepIndex);
      const revisionText = part.slice(sepIndex + 2);

      const idResult = parseContributorId(idText);
      if (Either.isLeft(idResult)) {
        return fail(`invalid contributor id "${idText}": ${idResult.left.reason}`);
      }
      const id = idResult.right;

      if (!/^[0-9]+$/.test(revisionText)) {
        return fail(`revision is not a plain positive-integer literal: ${revisionText}`);
      }
      if (revisionText.startsWith("0")) {
        return fail(
          revisionText === "0"
            ? `revision is explicitly zero for ${id}`
            : `revision has a leading zero: ${revisionText}`,
        );
      }
      if (digitsOverflowMaxRevision(revisionText)) {
        return fail(`revision overflows the maximum safe integer: ${revisionText}`);
      }
      const revision: Revision = Number(revisionText);

      if (previousId !== undefined) {
        const cmp = compareContributorIds(previousId, id);
        if (cmp === 0) {
          return fail(`duplicate contributor id: ${id}`);
        }
        if (cmp > 0) {
          return fail(`contributors are not in canonical order: ${id} follows ${previousId}`);
        }
      }
      previousId = id;
      entries.push([id, revision]);
    }

    return Either.right(new Version(entries));
  }

  /**
   * `join(V, W)[c] = max(V[c], W[c])` (SPEC.md §3.3), the vector-clock
   * merge Snap performs whenever it learns of another repository's
   * frontier.
   */
  static join(v: Version, w: Version): Version {
    const merged = new Map<ContributorId, Revision>();
    for (const [id, revision] of v.entries) {
      merged.set(id, revision);
    }
    for (const [id, revision] of w.entries) {
      const existing = merged.get(id) ?? 0;
      merged.set(id, Math.max(existing, revision));
    }
    const entries = Array.from(merged.entries()).sort((a, b) =>
      compareContributorIds(a[0], b[0]),
    );
    return new Version(entries);
  }

  /** This contributor's revision in this version, or 0 if absent. */
  revisionOf(id: ContributorId): Revision {
    return revisionOfEntries(this.entries, id);
  }

  /** Prints SPEC.md §3.2's canonical syntax. Round-trips through `Version.parse`. */
  toCanonicalString(): string {
    if (this.entries.length === 0) {
      return "()";
    }
    const body = this.entries.map(([id, revision]) => `${id}->${revision}`).join(",");
    return `(${body})`;
  }
}

/**
 * The four-way causal comparison of SPEC.md §3.3: an absent component is
 * zero; `V < W` iff every component is `<=` and at least one is strict;
 * `V || W` (concurrent) iff neither is before the other and they're
 * unequal. Concurrency is a distinct outcome, never conflated with
 * "before" or "after".
 */
export function compareVersions(v: Version, w: Version): VersionOrdering {
  let vBeforeOrEqualW = true;
  let wBeforeOrEqualV = true;

  for (const id of unionContributorIds(v.entries, w.entries)) {
    const vRevision = revisionOfEntries(v.entries, id);
    const wRevision = revisionOfEntries(w.entries, id);
    if (vRevision > wRevision) vBeforeOrEqualW = false;
    if (wRevision > vRevision) wBeforeOrEqualV = false;
  }

  if (vBeforeOrEqualW && wBeforeOrEqualV) return "equal";
  if (vBeforeOrEqualW) return "before";
  if (wBeforeOrEqualV) return "after";
  return "concurrent";
}

/**
 * Snap order (SPEC.md §3.4): take the sorted union of contributor IDs and
 * lexicographically compare the counter at each ID; the first unequal
 * counter decides. An arbitrary-but-fixed total order that extends causal
 * order, used only to break ties among concurrent versions — it carries no
 * chronological or authorship meaning.
 */
export function compareSnapOrder(v: Version, w: Version): -1 | 0 | 1 {
  for (const id of unionContributorIds(v.entries, w.entries)) {
    const vRevision = revisionOfEntries(v.entries, id);
    const wRevision = revisionOfEntries(w.entries, id);
    if (vRevision !== wRevision) {
      return vRevision < wRevision ? -1 : 1;
    }
  }
  return 0;
}
