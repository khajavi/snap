/**
 * Patch and change-variant value shapes (SPEC.md §4.2-§4.4), declared via
 * Effect `Schema` so decoding a patch (standalone, or as one element of a
 * repository's `patches` array) surfaces SPEC §4.5 point 1's "unknown
 * fields, non-integer numbers, and invalid typed values are errors" as
 * structured decode failures, plus the patch-identity helpers (dot,
 * result) SPEC §4.2 defines on top of the decoded shape.
 *
 * What this module validates (all purely structural — no cross-patch or
 * base-tree information is needed):
 *   - `author`/`base`'s contributor IDs (`domain/contributor.ts`'s
 *     grammar) and `changes[].path` (`domain/path.ts`'s grammar);
 *   - `revision` and every `base` entry's revision: `Schema.Int` plus a
 *     `[1, MAX_REVISION]` range refinement (plan.md §3's Schema bullet);
 *   - `base` and, when reused by `domain/repository.ts`, `frontier`: an
 *     "ordered array of `[id, revision]` pairs" per SPEC §3.2 — sorted by
 *     unsigned UTF-8 bytes, no duplicate author;
 *   - `message`: nonempty, tab/LF allowed, no other ASCII control
 *     character (SPEC §4.2). SPEC's 4096-byte cap is stated as a
 *     `snap commit` limit specifically ("`snap commit` limits
 *     user-supplied messages to 4096 bytes; generated revert messages may
 *     be longer") — a CLI-time constraint on user input, not a
 *     repository-format invariant every decoded patch must satisfy (a
 *     revert-generated message is explicitly allowed to exceed it). This
 *     module therefore does NOT enforce the byte cap; `commands/
 *     commit.ts` (a later phase) is where it belongs, checked against the
 *     user-supplied message before a patch is even constructed.
 *   - `changes`: nonempty, sorted by path, at most one change per path
 *     (`domain/path.ts`'s `compareTrackedPaths`), and prefix-free by path
 *     segment across the whole `changes` array (`domain/path.ts`'s
 *     `checkPrefixFree` — SPEC §2: "prefix-free by path segment ... is
 *     validated for every patch's authored result");
 *   - each change variant's own shape (§4.3) and, for `text`, its edit
 *     script's structural rules (§4.4): one-key operations, positive safe
 *     integer counts, nonempty insert tokens, no two adjacent operations
 *     of the same kind. The script's *semantic* rules that need the old
 *     token sequence (consumes it completely; result is canonical) are
 *     NOT checked here — they need the base tree's actual content, which
 *     is `replay/validate.ts` point 5's job (see its `// TODO(Phase 4)`).
 */

import { Either, ParseResult, Schema } from "effect";
import { SchemaValidationError } from "../errors/domain-errors.js";
import {
  compareContributorIds,
  parseContributorId,
  type ContributorId,
} from "./contributor.js";
import { checkPrefixFree, compareTrackedPaths, parseTrackedPath, type TrackedPath } from "./path.js";
import { MAX_REVISION, type Revision } from "./version.js";

// ---------------------------------------------------------------------------
// Shared scalar schemas
// ---------------------------------------------------------------------------

/** SPEC §3.1's contributor-ID grammar, decoded to the branded `ContributorId`. */
export const ContributorIdSchema: Schema.Schema<ContributorId, string> = Schema.String.pipe(
  Schema.filter(
    (s: string): s is ContributorId => Either.isRight(parseContributorId(s)),
    {
      message: (issue) => {
        const result = parseContributorId(issue.actual as string);
        return Either.isLeft(result) ? `invalid contributor id: ${result.left.reason}` : "invalid contributor id";
      },
    },
  ),
);

/** SPEC §2's tracked-path grammar, decoded to the branded `TrackedPath`. */
export const TrackedPathSchema: Schema.Schema<TrackedPath, string> = Schema.String.pipe(
  Schema.filter(
    (s: string): s is TrackedPath => Either.isRight(parseTrackedPath(s)),
    {
      message: (issue) => {
        const result = parseTrackedPath(issue.actual as string);
        return Either.isLeft(result) ? `invalid path: ${result.left.reason}` : "invalid path";
      },
    },
  ),
);

/**
 * SPEC §3.1's revision grammar: "a positive integer no greater than
 * JavaScript's maximum safe integer." `Schema.Int` (not a bare
 * `Schema.Number`) rejects `2.5`; the `between` refinement rejects `0`,
 * negatives, and anything past `MAX_REVISION` (plan.md §3's Schema
 * bullet).
 */
export const RevisionSchema: Schema.Schema<Revision, number> = Schema.Int.pipe(
  Schema.between(1, MAX_REVISION, { message: () => `revision must be between 1 and ${MAX_REVISION}` }),
);

// ---------------------------------------------------------------------------
// Version-as-JSON: an "ordered array of [id, revision] pairs" (SPEC §3.2)
// ---------------------------------------------------------------------------

/** One `[id, revision]` pair, SPEC §3.2's repository-JSON version encoding. */
export const VersionPairSchema = Schema.Tuple(ContributorIdSchema, RevisionSchema);

export type VersionPair = Schema.Schema.Type<typeof VersionPairSchema>;

/** An "ordered array of `[id, revision]` pairs": SPEC §3.2's version-JSON shape. */
export type VersionPairs = ReadonlyArray<VersionPair>;

/** True iff `pairs` is sorted by unsigned UTF-8 bytes with no duplicate author. */
function isSortedUniqueVersionPairs(pairs: ReadonlyArray<VersionPair>): boolean {
  for (let i = 1; i < pairs.length; i++) {
    const previous = pairs[i - 1]!;
    const current = pairs[i]!;
    if (compareContributorIds(previous[0], current[0]) >= 0) {
      return false;
    }
  }
  return true;
}

/**
 * SPEC §3.2: "a version is an ordered array of `[id, revision]` pairs."
 * Shared by `base` (this module) and `frontier` (`domain/repository.ts`),
 * since both are instances of the same version-JSON shape — well-formed
 * independent of any causal-graph information, so validated structurally
 * here rather than deferred to `replay/validate.ts`.
 */
export const VersionPairsSchema: Schema.Schema<VersionPairs, ReadonlyArray<readonly [string, number]>> =
  Schema.Array(VersionPairSchema).pipe(
    Schema.filter(isSortedUniqueVersionPairs, {
      message: () => "version pairs must be sorted by contributor id with no duplicate author",
    }),
  );

/** Looks up `author`'s revision in `pairs`, defaulting to 0 (SPEC §3.3: "An absent component is zero."). */
export function revisionOfVersionPairs(pairs: VersionPairs, author: ContributorId): Revision {
  for (const [entryAuthor, revision] of pairs) {
    if (entryAuthor === author) return revision;
  }
  return 0;
}

/**
 * Inserts or replaces `author`'s entry in `pairs`, keeping the result
 * sorted by contributor id (SPEC §4.2: "result = B with result[author] =
 * revision"). Used by `computePatchResult` below.
 */
function upsertVersionPair(
  pairs: VersionPairs,
  author: ContributorId,
  revision: Revision,
): VersionPairs {
  const withoutAuthor = pairs.filter(([entryAuthor]) => entryAuthor !== author);
  const inserted: VersionPair[] = [...withoutAuthor, [author, revision]];
  inserted.sort((a, b) => compareContributorIds(a[0], b[0]));
  return inserted;
}

// ---------------------------------------------------------------------------
// Message (SPEC §4.2)
// ---------------------------------------------------------------------------

/**
 * SPEC §4.2: "`message` is a nonempty UTF-8 string. It may contain tab
 * and LF but no other ASCII control character." Deliberately does NOT
 * enforce the 4096-byte cap — see this module's top comment.
 */
function isValidMessage(message: string): boolean {
  if (message.length === 0) {
    return false;
  }
  for (const char of message) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    if (codePoint === 0x09 || codePoint === 0x0a) {
      continue;
    }
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

export const MessageSchema: Schema.Schema<string, string> = Schema.String.pipe(
  Schema.filter(isValidMessage, {
    message: () => 'message must be nonempty and contain no ASCII control character other than tab or LF',
  }),
);

// ---------------------------------------------------------------------------
// Change variants (SPEC §4.3)
// ---------------------------------------------------------------------------

/** SPEC §4.3: "`content` is standard padded RFC 4648 base64." */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const Base64ContentSchema: Schema.Schema<string, string> = Schema.String.pipe(
  Schema.filter((s) => BASE64_PATTERN.test(s), {
    message: () => "content must be standard padded RFC 4648 base64",
  }),
);

/** SPEC §4.4: "Counts are positive safe integers." Reuses `RevisionSchema`'s bound for "safe integer". */
const PositiveSafeIntegerSchema: Schema.Schema<number, number> = Schema.Int.pipe(
  Schema.between(1, MAX_REVISION, { message: () => `count must be between 1 and ${MAX_REVISION}` }),
);

/** SPEC §4.4: `insert` operations "insert one or more nonempty text tokens." */
const NonEmptyTextTokenSchema: Schema.Schema<string, string> = Schema.String.pipe(
  Schema.filter((s) => s.length > 0, { message: () => "an inserted token must be nonempty" }),
);

const RetainOpSchema = Schema.Struct({ retain: PositiveSafeIntegerSchema });
const DeleteOpSchema = Schema.Struct({ delete: PositiveSafeIntegerSchema });
const InsertOpSchema = Schema.Struct({ insert: Schema.NonEmptyArray(NonEmptyTextTokenSchema) });

/**
 * SPEC §4.4's edit-script operation shapes. Deliberately shaped to match
 * `domain/diff.ts`'s `EditOp` exactly (`{retain:n}`/`{delete:n}`/
 * `{insert:[...]}`) so a decoded patch's edit script can be handed
 * directly to `diffTokens`/`applyEditScript` without re-shaping — this is
 * still its own `Schema`-decoded type (not a reuse of `diff.ts`'s
 * internal working type), since decoding needs the structural rules
 * (positive-safe-integer counts, nonempty insert tokens, one key per
 * operation) that `diff.ts`'s pure, always-succeeds functions don't
 * check.
 */
export const EditOpSchema = Schema.Union(RetainOpSchema, DeleteOpSchema, InsertOpSchema);

export type PatchEditOp = Schema.Schema.Type<typeof EditOpSchema>;

/** True iff no two adjacent operations share the same kind (SPEC §4.4). */
function opKind(op: PatchEditOp): "retain" | "delete" | "insert" {
  if ("retain" in op) return "retain";
  if ("delete" in op) return "delete";
  return "insert";
}

function hasNoAdjacentSameKindOps(ops: ReadonlyArray<PatchEditOp>): boolean {
  for (let i = 1; i < ops.length; i++) {
    if (opKind(ops[i - 1]!) === opKind(ops[i]!)) {
      return false;
    }
  }
  return true;
}

/**
 * SPEC §4.4: "An edit script is an array of these one-key operations."
 * "Adjacent operations of the same kind are forbidden." The empty array
 * is schema-legal (SPEC: "An empty script is valid only when creating an
 * empty text file" — the "only when creating" half needs the base tree,
 * so it's `replay/validate.ts` point 5's job, not checked here).
 */
export const EditScriptSchema = Schema.Array(EditOpSchema).pipe(
  Schema.filter(hasNoAdjacentSameKindOps, {
    message: () => "adjacent edit-script operations must not share the same kind",
  }),
);

const TextChangeSchema = Schema.Struct({
  type: Schema.Literal("text"),
  path: TrackedPathSchema,
  edit: EditScriptSchema,
});

const PutChangeSchema = Schema.Struct({
  type: Schema.Literal("put"),
  path: TrackedPathSchema,
  content: Base64ContentSchema,
});

const DeleteChangeSchema = Schema.Struct({
  type: Schema.Literal("delete"),
  path: TrackedPathSchema,
});

/** SPEC §4.3's three change variants: text create/edit, atomic put, delete. */
export const ChangeSchema = Schema.Union(TextChangeSchema, PutChangeSchema, DeleteChangeSchema);

export type Change = Schema.Schema.Type<typeof ChangeSchema>;

function changePath(change: Change): TrackedPath {
  return change.path;
}

/** True iff `changes` is sorted by path with no duplicate path. */
function isSortedUniqueChanges(changes: ReadonlyArray<Change>): boolean {
  for (let i = 1; i < changes.length; i++) {
    if (compareTrackedPaths(changePath(changes[i - 1]!), changePath(changes[i]!)) >= 0) {
      return false;
    }
  }
  return true;
}

/**
 * SPEC §2: "Every tracked tree is prefix-free by path segment ... This is
 * validated for every patch's authored result." The *complete* authored
 * result tree is `patch.base`'s materialized tree with `changes` applied
 * — checking that in full needs the base tree's other paths too (a
 * later, base-dependent step; see `replay/validate.ts` point 5's
 * `TODO(Phase 4)`). What's checkable here, purely structurally, is the
 * subset of the result this patch's own non-`delete` changes guarantee
 * present: a `text` or `put` change always leaves its path present
 * afterward, so two such paths in a prefix relationship (e.g. `a` and
 * `a/b` both created by this same patch) are a real conflict regardless
 * of base content. A `delete` change leaves its path absent afterward,
 * so it can never itself be one side of a conflict, and is excluded here
 * — `delete "a"` alongside `text`/`put` on `a/b` is not a structural
 * conflict (it may validly turn a file into a directory), and whether
 * it's actually consistent with the base tree is point 5's job, not
 * this one's.
 */
function isPrefixFreeChanges(changes: ReadonlyArray<Change>): boolean {
  const presentAfterPaths = changes.filter((change) => change.type !== "delete").map(changePath);
  return Either.isRight(checkPrefixFree(presentAfterPaths));
}

/**
 * SPEC §4.2: "`changes` is nonempty, sorted by path, and contains at most
 * one change per path."
 */
export const ChangesSchema = Schema.NonEmptyArray(ChangeSchema).pipe(
  Schema.filter(isSortedUniqueChanges, {
    message: () => "changes must be sorted by path with at most one change per path",
  }),
  Schema.filter(isPrefixFreeChanges, {
    message: () => "changes' tree paths conflict (one path is a segment-prefix of another)",
  }),
);

// ---------------------------------------------------------------------------
// Patch (SPEC §4.2)
// ---------------------------------------------------------------------------

export const PatchSchema = Schema.Struct({
  author: ContributorIdSchema,
  revision: RevisionSchema,
  base: VersionPairsSchema,
  message: MessageSchema,
  changes: ChangesSchema,
});

export type Patch = Schema.Schema.Type<typeof PatchSchema>;

/** A patch's dot (SPEC §4.2: "A patch's dot is `(author, revision)`."). */
export interface Dot {
  readonly author: ContributorId;
  readonly revision: Revision;
}

/** Extracts a patch's dot. */
export function dotOf(patch: Patch): Dot {
  return { author: patch.author, revision: patch.revision };
}

/**
 * SPEC §4.2: for base `B`, `result = B with result[author] = revision`
 * ("One patch therefore increments one contributor.").
 */
export function computePatchResult(patch: Patch): VersionPairs {
  return upsertVersionPair(patch.base, patch.author, patch.revision);
}

/**
 * SPEC §4.2's patch-identity formula: `revision = base[author] + 1`.
 */
export function expectedRevisionFor(patch: Patch): Revision {
  return revisionOfVersionPairs(patch.base, patch.author) + 1;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Formats a Schema `ParseError` as a single human-readable string via
 * `ParseResult.TreeFormatter`, the text `SchemaValidationError` carries.
 * Shared by `domain/repository.ts` so a repository-level decode failure
 * (which may originate from deep inside one element of `patches`) is
 * rendered the same way as a standalone patch decode failure.
 */
export function formatParseError(error: ParseResult.ParseError): string {
  return ParseResult.TreeFormatter.formatErrorSync(error);
}

/**
 * Decodes one patch value from unknown JSON input, applying SPEC §4.5
 * point 1's schema layer: unknown top-level or nested fields, non-integer
 * numbers, and invalid typed values are all surfaced as one
 * `SchemaValidationError`.
 */
export function decodePatch(input: unknown): Either.Either<Patch, SchemaValidationError> {
  return Schema.decodeUnknownEither(PatchSchema, { onExcessProperty: "error" })(input).pipe(
    Either.mapLeft((error) => new SchemaValidationError({ message: formatParseError(error) })),
  );
}
