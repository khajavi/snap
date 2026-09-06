/**
 * Working-tree and tree-to-tree operations shared by the Phase 8 writing
 * and diffing commands:
 *
 *   - deterministic unsupported-entry errors (`firstUnsupportedError`),
 *   - SPEC.md §2's clean/dirty working-tree checks (`isWorkingTreeClean`),
 *   - the sorted path union two trees compare against
 *     (`unionPathsSorted`),
 *   - SPEC.md §7.5's change authoring over two trees
 *     (`authorChanges`), and
 *   - the revision-bound check every patch-authoring command needs
 *     (`checkedNextRevision` / `RevisionOverflowError`).
 *
 * The change-authoring classification is SPEC.md §7.5's sentence, shared
 * verbatim by `commit` and `revert`: "Uses a text change when the new
 * content is text and the old path is absent or text. Otherwise it uses
 * `put`; removed paths use `delete`." Both commands author patches that
 * turn one complete tree into another, so one shared authoring function
 * keeps their stored change sets byte-identical in shape.
 *
 * The error classes defined here (`WorkingTreeCleanError`,
 * `WorkingTreeDirtyError`, `RevisionOverflowError`) carry SPEC.md's exact
 * pinned `<detail>` text via their own `*_DETAIL` constants, following the
 * `config/config.ts` convention — the `snap: ` prefix is added at the
 * CLI-error-rendering boundary.
 *
 * Everything here is pure or Effect-free except where noted; the module
 * never talks to the filesystem or to services.
 */

import { Buffer } from "node:buffer";
import { Data, Either } from "effect";
import { diffTokens, type EditOp } from "../domain/diff.js";
import {
  type Change,
  type PatchEditOp,
} from "../domain/patch.js";
import { compareTrackedPaths, type TrackedPath } from "../domain/path.js";
import { MAX_REVISION, type Revision } from "../domain/version.js";
import type { WorkingTreeScan } from "../fs/tree-scan.js";
import {
  UnsupportedWorkingTreeEntryError,
  isCleanAgainstCurrentTree,
} from "../fs/tree-scan.js";
import type { Tree } from "../replay/integrate.js";
import type { PathState } from "../replay/tiebreak.js";
import { pathStatesEqual } from "../replay/tiebreak.js";

/** SPEC.md §7.5's exact clean-tree detail text, unprefixed. */
export const WORKING_TREE_CLEAN_DETAIL = "working tree is clean";

/** SPEC.md §7.7/§7.8's exact dirty-tree detail text, unprefixed. */
export const WORKING_TREE_DIRTY_DETAIL = "working tree is dirty";

/** SPEC.md §7.5/§7.7's revision-overflow detail text (unpinned, so unpinned wording). */
export const REVISION_OVERFLOW_DETAIL = "revision overflow";

/** The state of a path neither tree contains; comparisons against it are no-ops. */
const ABSENT: PathState = { _tag: "Absent" };

/**
 * Re-shapes one §5 working edit operation into §4.4's *schema-decoded*
 * operation shape (`PatchEditOp`): the schema's `insert` is a nonempty
 * array, which `diffTokens`'s coalescing already guarantees (an insert op
 * is only ever created with at least one token), so the only difference is
 * a type-level width — this mapping is the cast that width needs.
 */
const toPatchEditOp = (op: EditOp): PatchEditOp => {
  if ("retain" in op) return { retain: op.retain };
  if ("delete" in op) return { delete: op.delete };
  return { insert: op.insert as readonly [string, ...string[]] };
};

/** §7.5: "A clean tree ... is an error." */
export class WorkingTreeCleanError extends Data.TaggedError("WorkingTreeCleanError")<{}> {}

/** §7.7/§7.8: writing commands "require a clean working tree". */
export class WorkingTreeDirtyError extends Data.TaggedError("WorkingTreeDirtyError")<{}> {}

/** §7.5: "overflow ... is an error" — the configured contributor's next revision past MAX_REVISION. */
export class RevisionOverflowError extends Data.TaggedError("RevisionOverflowError")<{}> {}

/** Unsigned-UTF-8-byte order over a repository-relative path, for the deterministic error pick. */
const byUtf8Bytes = (a: { readonly path: string }, b: { readonly path: string }): number =>
  Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));

/**
 * The error for the first unsupported entry in a scan (SPEC.md §10: any
 * command that scans the working tree "fails on a symlink or other
 * unsupported entry"). Picks the lexicographically lowest offending path
 * so the failure is deterministic when a tree contains several.
 */
export function firstUnsupportedError(
  scan: WorkingTreeScan,
): UnsupportedWorkingTreeEntryError | undefined {
  if (scan.unsupported.length === 0) {
    return undefined;
  }
  const first = [...scan.unsupported].sort(byUtf8Bytes)[0]!;
  return new UnsupportedWorkingTreeEntryError({ path: first.path });
}

/** SPEC.md §2's clean/dirty definition against the current tree, unsupported entries included. */
export function isWorkingTreeClean(scan: WorkingTreeScan, currentTree: Tree): boolean {
  return isCleanAgainstCurrentTree(scan.tree, scan.unsupported, currentTree);
}

/** Every path present in either tree, in §2's unsigned-UTF-8-byte path order. */
export function unionPathsSorted(
  a: ReadonlyMap<TrackedPath, PathState>,
  b: ReadonlyMap<TrackedPath, PathState>,
): ReadonlyArray<TrackedPath> {
  const seen = new Set<TrackedPath>();
  for (const path of a.keys()) seen.add(path);
  for (const path of b.keys()) seen.add(path);
  return Array.from(seen).sort(compareTrackedPaths);
}

/** A `PathState`'s exact bytes (text tokens rejoined and UTF-8 encoded, or raw binary bytes). */
function bytesOfPathState(state: PathState): Uint8Array {
  switch (state._tag) {
    case "Text":
      return new TextEncoder().encode(state.tokens.join(""));
    case "Binary":
      return state.bytes;
    case "Absent":
      throw new Error("authorChanges: tree contains an explicit Absent entry");
  }
}

/**
 * SPEC.md §7.5's change classification, applied per changed path (old
 * state from `oldTree`, new state from `newTree`): a removed path is a
 * `delete`; a new Text state whose old state is absent or Text is a
 * `text` change carrying §5's canonical script; everything else is a
 * `put` carrying the new content as padded RFC 4648 base64. Changes come
 * out sorted by path (the input's sorted path union) with at most one
 * change per path, satisfying §4.2's `changes` schema prerequisites.
 */
export function authorChanges(
  oldTree: ReadonlyMap<TrackedPath, PathState>,
  newTree: ReadonlyMap<TrackedPath, PathState>,
): readonly [Change, ...Change[]] {
  const changes: Change[] = [];
  for (const path of unionPathsSorted(oldTree, newTree)) {
    const old = oldTree.get(path) ?? ABSENT;
    const next = newTree.get(path) ?? ABSENT;
    if (pathStatesEqual(old, next)) {
      continue;
    }
    if (next._tag === "Absent") {
      changes.push({ type: "delete", path });
    } else if (next._tag === "Text" && (old._tag === "Absent" || old._tag === "Text")) {
      const oldTokens = old._tag === "Text" ? old.tokens : [];
      changes.push({
        type: "text",
        path,
        edit: diffTokens(oldTokens, next.tokens).map(toPatchEditOp),
      });
    } else {
      changes.push({ type: "put", path, content: Buffer.from(bytesOfPathState(next)).toString("base64") });
    }
  }
  if (changes.length === 0) {
    // §4.2 requires a nonempty `changes` array. The callers (commit
    // against the working tree, revert against the target tree) only ever
    // author changes for an unequal tree pair — the clean/target-current
    // checks upstream guarantee a difference — so an empty result here is
    // an invariant violation in the caller, not a normal failure mode.
    throw new Error("authorChanges: no changes for an unequal tree pair");
  }
  return changes as [Change, ...Change[]];
}

/**
 * The revision §4.2's formula assigns `author`'s next patch, or
 * `RevisionOverflowError` when the current frontier revision is already
 * `MAX_REVISION` and the increment would leave the safe-integer range
 * (SPEC.md §3.1 bounds revisions at JavaScript's maximum safe integer;
 * §7.5 names "overflow" as an error).
 */
export function checkedNextRevision(
  frontierRevisionOfAuthor: Revision,
): Either.Either<Revision, RevisionOverflowError> {
  if (frontierRevisionOfAuthor >= MAX_REVISION) {
    return Either.left(new RevisionOverflowError());
  }
  return Either.right((frontierRevisionOfAuthor + 1) as Revision);
}