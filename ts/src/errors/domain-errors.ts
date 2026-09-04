/**
 * Shared tagged-error hierarchy (plan.md §1.2), grouped by the five broad
 * categories every failure mode in SPEC.md falls into:
 *
 *   - Parse/grammar errors already live next to their grammars
 *     (`InvalidContributorIdError` in `domain/contributor.ts`,
 *     `InvalidVersionError` in `domain/version.ts`, `InvalidPathError` and
 *     `PathPrefixConflictError` in `domain/path.ts`) and are re-exported by
 *     nothing here — this file does not duplicate them.
 *   - Validation errors (repository/patch JSON schema violations and the
 *     causal-validation failures they feed into) are defined below, since
 *     `domain/patch.ts`, `domain/repository.ts`, and `replay/validate.ts`
 *     are the first modules that need them.
 *   - Corruption errors (`CorruptPatchError`) are defined below per
 *     SPEC.md §3.5/§4.2/§1.1 invariant 7.
 *   - Precondition and Transport errors belong to later phases' commands,
 *     config, repo-store, and HTTP work — not added here, so this file
 *     stays additive rather than guessing their shape prematurely.
 *
 * This file is deliberately additive: later phases will keep adding error
 * variants here as they build the Precondition/Transport categories and
 * whatever further Validation/Corruption cases replay/select/integrate
 * need — nothing here should be treated as an exhaustive final union.
 */

import { Data } from "effect";

/** A `(author, revision)` dot, used across the errors below to name a patch. */
export interface DotRef {
  readonly author: string;
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// Validation errors — structural (schema) layer
// ---------------------------------------------------------------------------

/**
 * A repository or patch value failed Effect `Schema` decoding: an unknown
 * field, a non-integer number where an integer was required, an
 * out-of-range value, or any other structurally invalid typed value per
 * SPEC.md §4.1/§4.5 point 1 ("Unknown fields, non-integer numbers, and
 * invalid typed values are errors"). `message` carries the formatted
 * decode-failure tree (`ParseResult.TreeFormatter`), not a paraphrase, so
 * callers and tests can see exactly what Schema rejected and why.
 */
export class SchemaValidationError extends Data.TaggedError("SchemaValidationError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Validation errors — causal layer (SPEC.md §4.5 points 2-4, 6)
// ---------------------------------------------------------------------------

/**
 * `patches` is not sorted by author and then numeric revision (SPEC.md
 * §4.1: "sorted by author and then numeric revision"). Names the first
 * dot found out of order.
 */
export class UnsortedPatchesError extends Data.TaggedError("UnsortedPatchesError")<{
  readonly dot: DotRef;
}> {}

/**
 * The same dot `(author, revision)` appears more than once in `patches`
 * with structurally equal parsed values. SPEC.md §4.1's "exactly the
 * causal closure" is a set — any repeat, even a byte-identical one,
 * violates it.
 */
export class DuplicatePatchError extends Data.TaggedError("DuplicatePatchError")<{
  readonly dot: DotRef;
}> {}

/**
 * A contributor's revisions in `patches` skip a number: revision `n` is
 * present without `n-1` immediately preceding it (SPEC.md §4.5 point 2,
 * §3.5's serial-contributor rule: "revision `n` ... follows `n-1`").
 */
export class NonContiguousRevisionError extends Data.TaggedError("NonContiguousRevisionError")<{
  readonly dot: DotRef;
  readonly expectedRevision: number;
}> {}

/**
 * A patch's `base` names a dot `(author, revision)` for which no patch
 * exists in the repository's `patches` set (SPEC.md §4.5 point 3: "every
 * patch's complete base closure"; §1.1 invariant 3: "A patch's complete
 * causal base is present and immutable").
 */
export class IncompleteBaseClosureError extends Data.TaggedError("IncompleteBaseClosureError")<{
  readonly patch: DotRef;
  readonly missingBaseDot: DotRef;
}> {}

/**
 * A patch's `revision` does not equal `base[author] + 1` (SPEC.md §4.2's
 * patch-identity formula, checked at the repository level per §4.5
 * point 3).
 */
export class InvalidRevisionFormulaError extends Data.TaggedError("InvalidRevisionFormulaError")<{
  readonly patch: DotRef;
  readonly expectedRevision: number;
}> {}

/**
 * The base-dependency graph over `patches` contains a cycle (SPEC.md
 * §4.5 point 4: "acyclic causality"). `cycle` names one witnessing cycle,
 * dot-by-dot.
 */
export class CyclicCausalityError extends Data.TaggedError("CyclicCausalityError")<{
  readonly cycle: ReadonlyArray<DotRef>;
}> {}

/**
 * A frontier entry `(author, revision)` names a dot for which no patch
 * exists in `patches` (SPEC.md §4.1's known/materializable-version
 * definition: "every patch `(c, n)` selected by `n <= V[c]` exists").
 */
export class UnknownFrontierDotError extends Data.TaggedError("UnknownFrontierDotError")<{
  readonly dot: DotRef;
}> {}

/**
 * A patch in `patches` is not part of the causal closure of `frontier`
 * (SPEC.md §4.1: "`patches` contains exactly the causal closure of
 * `frontier` ... with no unreachable patches").
 */
export class UnreachablePatchError extends Data.TaggedError("UnreachablePatchError")<{
  readonly dot: DotRef;
}> {}

/**
 * SPEC.md §4.5 point 6: replay of the declared frontier stalled — the
 * ready set (patches whose complete base is already integrated) emptied
 * before every patch in the closure was consumed. Per SPEC.md's closing
 * §4.5 paragraph, this always indicates a cycle or a missing dependency
 * — the same two conditions `CyclicCausalityError` and
 * `IncompleteBaseClosureError`/`UnknownFrontierDotError` already name at
 * the single-patch level; this error names the *set* of patches replay
 * could never reach.
 */
export class ReplayNotReadyError extends Data.TaggedError("ReplayNotReadyError")<{
  readonly unreachable: ReadonlyArray<DotRef>;
}> {}

/**
 * SPEC.md §4.5 point 5: a change's effect on path existence is
 * inconsistent with its patch's materialized exact base — a text/put
 * creation where the path is already present, or an edit/replacement/
 * delete where the path is absent, or a change that alters neither
 * existence nor bytes (except an empty text edit creating an empty
 * file).
 *
 * NOT YET RAISED by this phase's `replay/validate.ts` — see the
 * `// TODO(Phase 4)` there. Defined here now so `replay/validate.ts`'s
 * point-5 slot and its future Phase 4 completion share one error type
 * from the start, and so this file's shape doesn't need to change again
 * once Phase 4 lands.
 */
export class ChangeBaseConflictError extends Data.TaggedError("ChangeBaseConflictError")<{
  readonly patch: DotRef;
  readonly path: string;
  readonly reason: string;
}> {}

// ---------------------------------------------------------------------------
// Replay errors — integration-time (SPEC.md §6.2 case 3 / §6.3)
// ---------------------------------------------------------------------------

/**
 * SPEC.md §6.2 case 3 arose while integrating a patch — `B`, `C`, and `T`
 * are all text and the incoming change is a text edit — so resolving the
 * path requires transforming the incoming edit through the aggregate
 * context edit `Q = diff(B, C)` per SPEC.md §6.3, but no transform was
 * injected through replay's `textTransform` seam. This is the Phase 4 /
 * Phase 5 boundary made explicit: Phase 4 detects the case and refuses to
 * guess a merge, Phase 5's OT module wires the real §6.3 transform in
 * through the seam. Carries the offending path and the dot of the patch
 * that hit the case, so a caller can name both in a diagnostic.
 */
export class OtUnavailableError extends Data.TaggedError("OtUnavailableError")<{
  readonly patch: DotRef;
  readonly path: string;
}> {}

// ---------------------------------------------------------------------------
// Corruption errors (SPEC.md §1.1 invariant 7, §3.5, §4.2)
// ---------------------------------------------------------------------------

/**
 * The same dot `(author, revision)` appears more than once in `patches`
 * with structurally *different* parsed values — SPEC.md §4.2: "Different
 * values at one dot are corruption"; §1.1 invariant 7: "The same dot with
 * different patch values is corruption, not a merge conflict."
 */
export class CorruptPatchError extends Data.TaggedError("CorruptPatchError")<{
  readonly dot: DotRef;
}> {}
