/**
 * Integrating one patch into the canonical tree (SPEC.md §6.2): the patch's
 * authored per-path results materialized against its exact base tree, the
 * namespace-conflict precheck that runs before any per-path rule, and the
 * four-case dispatch that settles every changed path the precheck leaves
 * alone — with SPEC.md §6.3's text transform deliberately left as an
 * injected seam (`TextTransform`) for Phase 5.
 *
 * A canonical tree here is `replay/tiebreak.ts`'s `PathState` keyed by
 * tracked path: a path absent from the map is absent from the tree (SPEC
 * §2's path/byte map, minus the filesystem materialization §6.2's closing
 * paragraph assigns to a later phase). Trees are values: `integratePatch`
 * never mutates its inputs, and the same `(baseTree, canonicalTree, patch)`
 * always yields the same outcome — SPEC §6.5's same-bytes guarantee is
 * pure-function determinism at this layer.
 *
 * Pure and synchronous, like `replay/select.ts`: exactly one typed failure
 * mode (`OtUnavailableError` — the §6.2 case 3 / §6.3 seam), `Either`
 * returns, no services, no filesystem. `replay/replay.ts` (this phase's
 * orchestrator) computes each patch's base tree and folds this over the
 * §6.1 sequence.
 */

import { Buffer } from "node:buffer";
import { Either } from "effect";
import { applyEditScript, type EditScript } from "../domain/diff.js";
import type { TrackedPath } from "../domain/path.js";
import { dotOf, type Change, type Patch } from "../domain/patch.js";
import type { Token } from "../domain/text.js";
import { OtUnavailableError } from "../errors/domain-errors.js";
import {
  pathStateFromBytes,
  pathStatesEqual,
  tiebreakPath,
  type PathState,
  type WarningPair,
} from "./tiebreak.js";

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * A canonical tree: every present tracked path mapped to its state, with
 * absence expressed by map absence (SPEC §2's path/byte map in
 * `replay/tiebreak.ts`'s `PathState` form). A tree built by replay is
 * prefix-free by path segment: §6.2's namespace precheck removes any
 * current path that would block an incoming path, and §4.3's change set
 * (one change per path, prefix-free authored results) keeps one patch from
 * introducing a conflict within itself.
 */
export type Tree = ReadonlyMap<TrackedPath, PathState>;

/** The state of a path a tree does not contain. */
const ABSENT: PathState = { _tag: "Absent" };

/** A path's state in `tree`, or absence if the map does not contain it. */
const stateOf = (tree: Tree, path: TrackedPath): PathState => tree.get(path) ?? ABSENT;

// ---------------------------------------------------------------------------
// The §6.3 seam (Phase 5)
// ---------------------------------------------------------------------------

/**
 * The Phase 5 seam for SPEC.md §6.2 case 3: `B`, `C`, and `T` are all text
 * and the incoming change is a text edit, so the path resolves by
 * transforming the incoming edit through the aggregate context edit
 * `Q = diff(B, C)` per SPEC.md §6.3 and applying the transformed script to
 * `C` — the OT Phase 4 does not implement.
 *
 * A transform receives the path, the base tokens (`B`), the current
 * canonical tokens (`C`), and the incoming change's authored edit script,
 * and returns the resolved state for that path (a faithful §6.3 transform
 * returns `Text`: `applyEditScript(C, transform(P.edit, diffTokens(B, C)))`).
 * Phase 5's `replay/ot.ts` wires the real transform in; until then the case
 * is detected, not guessed at — without a transform `integratePatch` fails
 * with `OtUnavailableError` rather than silently mis-merging.
 */
export type TextTransform = (
  path: TrackedPath,
  baseTokens: ReadonlyArray<Token>,
  currentTokens: ReadonlyArray<Token>,
  incomingEdit: EditScript,
) => PathState;

// ---------------------------------------------------------------------------
// Prefix-freedom, pairwise
// ---------------------------------------------------------------------------

/**
 * True iff `ancestor` is a strict path-segment prefix of `descendant` —
 * `ancestor`'s `/`-separated segments are a proper prefix of `descendant`'s
 * (SPEC §2: "if `a` is a file, no `a/...` path is present"). Byte-prefix
 * equality is not enough: `"ab"` is not an ancestor of `"abc"`, and no path
 * is its own ancestor.
 *
 * A local twin of the segment walk inside `domain/path.ts`'s
 * `checkPrefixFree` (which validates a whole array and reports the first
 * conflict, so it is not reusable as this pairwise predicate): for two
 * grammar-valid paths, `descendant` starts with `ancestor` and its next
 * byte is the separator exactly when the first `ancestor.length` bytes are
 * the complete path `ancestor` and a new segment follows — no valid path
 * has an empty segment, so the byte test and the segment walk agree.
 */
const isStrictSegmentPrefix = (ancestor: TrackedPath, descendant: TrackedPath): boolean =>
  descendant.length > ancestor.length &&
  descendant.startsWith(ancestor) &&
  descendant.charAt(ancestor.length) === "/";

// ---------------------------------------------------------------------------
// Authored results (SPEC.md §6.2's T)
// ---------------------------------------------------------------------------

/**
 * Materializes one change's authored result `T` by applying the change to
 * the path's state in the patch's exact base tree (SPEC.md §6.2: "let `T`
 * be the authored result of applying that change to `B`"):
 *
 *   - `text` — apply the edit script to the base path's text tokens
 *     (`domain/diff.ts`'s `applyEditScript`). A create has no base tokens;
 *     §4.4 then requires the script to consume zero old tokens, which
 *     `applyEditScript` enforces. A `text` change whose base path is
 *     present but binary is a change/base inconsistency
 *     (`replay/validate.ts` point 5's `ChangeBaseConflictError`) that
 *     validated repositories never contain; it materializes against zero
 *     tokens here, so an edit that consumes tokens trips the same
 *     `applyEditScript` invariant rather than failing silently.
 *   - `put` — `pathStateFromBytes` of the decoded content: §4.4's
 *     classification decides text-vs-binary in one place.
 *   - `delete` — absence, §4.3: applying a delete removes the path.
 */
const authoredResultOf = (baseTree: Tree, change: Change): PathState => {
  switch (change.type) {
    case "text": {
      const base = stateOf(baseTree, change.path);
      const baseTokens = base._tag === "Text" ? base.tokens : [];
      return { _tag: "Text", tokens: applyEditScript(baseTokens, change.edit) };
    }
    case "put":
      return pathStateFromBytes(Buffer.from(change.content, "base64"));
    case "delete":
      return ABSENT;
  }
};

/** One change paired with its materialized authored result. */
interface AuthoredChange {
  readonly change: Change;
  readonly result: PathState;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/** One patch's integration: the next canonical tree plus its warning pairs. */
export interface PatchIntegration {
  /** `C` with every resolved change of this patch applied together (§6.2). */
  readonly tree: Tree;
  /**
   * This patch's warning pairs: one per namespace-precheck removal
   * (`namespace-wins`) plus whatever §6.4 rule 2-6 the per-path dispatch
   * reached. Cases 1-3 and §6.4 rule 1 emit none. `replay/replay.ts`
   * finalizes the union over all patches.
   */
  readonly warnings: ReadonlyArray<WarningPair>;
}

/**
 * Integrates one patch `P` per SPEC.md §6.2, given `P`'s exact base tree
 * `B` and the canonical tree built so far `C` ("It contains `B` plus only
 * earlier concurrent effects" — the caller, `replay/replay.ts`, computes
 * `B` by replaying `P`'s base version, not by reading the running tree):
 *
 *   1. Materialize `T` for every change in `P.changes` against `B`.
 *   2. Namespace precheck, before any per-path rule: `S` is every path
 *      present in `P`'s authored result — every path `P` creates, edits,
 *      or replaces, not only paths absent from `B` — and `C'` is `C` with
 *      every path `P` authored as a deletion removed. A path in `S` with a
 *      different current ancestor or descendant in `C'` installs as its
 *      authored result `T`, and every such conflicting current path is
 *      removed with a `namespace-wins` warning. These decisions override
 *      the per-path dispatch. The authored result is prefix-free, so two
 *      paths in `S` cannot conflict; duplicate removals and warnings
 *      collapse.
 *   3. Four-case dispatch for each changed path not settled by the
 *      namespace rule — (1) `B` and `C` identical: apply the authored
 *      change directly; (2) `C` and `T` identical: keep `C`; (3) `B`, `C`,
 *      and `T` all text with a text change: the §6.3 OT case, resolved
 *      through the injected `textTransform` seam or failed with
 *      `OtUnavailableError`; (4) otherwise `tiebreakPath` (§6.4).
 *   4. Apply everything together: remove the namespace-marked current
 *      paths, then install the namespace-marked authored results and the
 *      per-path outcomes. Unchanged paths carry over untouched.
 *
 * `B` and `C` are never mutated; the result tree is a fresh map.
 */
export function integratePatch(
  baseTree: Tree,
  canonicalTree: Tree,
  patch: Patch,
  textTransform?: TextTransform,
): Either.Either<PatchIntegration, OtUnavailableError> {
  // Step 1: authored results. §4.2 guarantees at most one change per path.
  const authored: ReadonlyArray<AuthoredChange> = patch.changes.map((change) => ({
    change,
    result: authoredResultOf(baseTree, change),
  }));

  // Step 2: namespace precheck (SPEC.md §6.2's first paragraph).
  const presentAuthored = authored.filter((entry) => entry.result._tag !== "Absent");
  const deletedAuthored = new Set<TrackedPath>(
    authored.filter((entry) => entry.change.type === "delete").map((entry) => entry.change.path),
  );
  // C' = C with every path P authored as a deletion removed. P's own
  // deletions resolve their own namespace conflicts inside its authored
  // result, so they must not read as conflicts against C here.
  const currentAfterDeletions: TrackedPath[] = [];
  for (const path of canonicalTree.keys()) {
    if (!deletedAuthored.has(path)) {
      currentAfterDeletions.push(path);
    }
  }

  const installs = new Map<TrackedPath, PathState>();
  const removals = new Map<TrackedPath, WarningPair>();
  for (const { change, result } of presentAuthored) {
    for (const currentPath of currentAfterDeletions) {
      if (
        isStrictSegmentPrefix(change.path, currentPath) ||
        isStrictSegmentPrefix(currentPath, change.path)
      ) {
        installs.set(change.path, result);
        removals.set(currentPath, { path: currentPath, reason: "namespace-wins" });
      }
    }
  }

  // Step 4's tree, seeded with the patch's namespace decisions: remove the
  // union of marked current paths, then install every marked authored
  // result. Paths in S, paths P authored as deletions, and marked current
  // paths are pairwise disjoint (marked current paths are in C', which
  // excludes P's deletions, and a path in S conflicts with no path in S),
  // so no later step can undo a namespace decision.
  const next = new Map<TrackedPath, PathState>(canonicalTree);
  const warnings: WarningPair[] = [];
  for (const [removedPath, warning] of removals) {
    next.delete(removedPath);
    warnings.push(warning);
  }
  for (const [installedPath, state] of installs) {
    next.set(installedPath, state);
  }

  // Step 3: the four-case dispatch, per changed path not already settled.
  for (const entry of authored) {
    const { change, result: incoming } = entry;
    const path = change.path;
    if (installs.has(path)) {
      // Settled by the namespace rule, which overrides the per-path rules.
      continue;
    }

    const base = stateOf(baseTree, path);
    const current = stateOf(canonicalTree, path);

    if (pathStatesEqual(base, current)) {
      // Case 1: "If the path is identical in B and C, apply the authored
      // change directly."
      setOrDelete(next, path, incoming);
      continue;
    }

    if (pathStatesEqual(current, incoming)) {
      // Case 2: "If the path is identical in C and T, keep it unchanged."
      continue;
    }

    if (
      base._tag === "Text" &&
      current._tag === "Text" &&
      incoming._tag === "Text" &&
      change.type === "text"
    ) {
      // Case 3: "If B, C, and T are text and P is a text change, derive the
      // aggregate context edit Q = diff(B, C) with §5, transform P through
      // Q by §6.3, and apply it to C."
      // TODO(Phase 5): implement §6.3's transform (transform P's edit
      // against Q = diffTokens(baseTokens, currentTokens), then
      // applyEditScript(currentTokens, transformed)) in replay/ot.ts and
      // inject it through this seam.
      if (textTransform === undefined) {
        return Either.left(new OtUnavailableError({ patch: dotOf(patch), path }));
      }
      setOrDelete(
        next,
        path,
        textTransform(path, base.tokens, current.tokens, change.edit),
      );
      continue;
    }

    // Case 4: "Otherwise use §6.4's path-level rules."
    const resolved = tiebreakPath({
      path,
      base,
      current,
      incoming,
      incomingVariant: change.type,
    });
    if (resolved.warning !== undefined) {
      warnings.push(resolved.warning);
    }
    setOrDelete(next, path, resolved.state);
  }

  return Either.right({ tree: next, warnings });
}

/** Writes `state` into `tree`, with absence expressed by removal. */
function setOrDelete(tree: Map<TrackedPath, PathState>, path: TrackedPath, state: PathState): void {
  if (state._tag === "Absent") {
    tree.delete(path);
  } else {
    tree.set(path, state);
  }
}
