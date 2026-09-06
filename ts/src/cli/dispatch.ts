/**
 * CLI dispatch (SPEC.md §7/§10, plan.md Phase 8): turn a parsed `Command`
 * (`cli/args.ts`) into the Effect that executes it, and define the
 * plain-mode rendering contract everything downstream of `main.ts`
 * depends on.
 *
 * Three responsibilities, none of which belong to the command modules:
 *
 *   1. **Wiring.** One case per `Command` variant, handing it to its
 *      command module. Every command produces a `CommandOutput` — the
 *      exact stdout bytes (already LF-terminated where the spec shows a
 *      line, `""` for silent success or no output) and the exact stderr
 *      bytes (`""` except for `merge`'s `warning: auto-resolved ...`
 *      lines). The presentation layer is Phase 9, so no ANSI, no
 *      `SNAP_COLOR`, and no styling lives anywhere on this path.
 *   2. **The error union.** Every expected failure any command can
 *      produce, as one type — including the CLI grammar errors from
 *      `cli/args.ts`, so `main.ts` can route a parse failure through the
 *      same rendering as a command failure.
 *   3. **The detail renderer.** `errorDetail` maps each error to its
 *      unprefixed `<detail>` text; SPEC.md §10's one-line
 *      `snap: <detail>` format (prefix and trailing LF) is applied once,
 *      in `renderErrorLine`, at the boundary. Pinned exact texts are
 *      referenced from their modules' `*_DETAIL` constants rather than
 *      restated, so they cannot drift.
 *
 * Exit codes (SPEC.md §10: "Success exits 0, expected errors exit 1, and
 * unexpected internal failures exit 2"): every error in `DispatchError`
 * is an *expected* error → exit 1. Defects (unhandled exceptions, broken
 * invariants) are not values of this union; `main.ts` renders them as
 * `snap: internal error` with exit 2.
 *
 * **Serving stays phased.** `--serve`'s port validation is real (Phase 8,
 * tests/14), but running the HTTP server is Phase 10's `http/serve.ts`;
 * the `Serve` case runs the validation and then fails with
 * `CommandNotImplementedError`, so the server is not faked before its
 * phase. `Serve` is the only remaining `NOT_IMPLEMENTED` entry.
 */

import { FileSystem } from "@effect/platform";
import { isPlatformError, type PlatformError } from "@effect/platform/Error";
import { Data, Effect } from "effect";
import {
  ConfigDecodeError,
  ConfigService,
  ContributorIdRequiredError,
  CONTRIBUTOR_ID_REQUIRED_DETAIL,
  GLOBAL_HOME_UNAVAILABLE_DETAIL,
  GlobalHomeUnavailableError,
} from "../config/config.js";
import type { InvalidContributorIdError } from "../domain/contributor.js";
import { InvalidPathError } from "../domain/path.js";
import { type InvalidVersionError } from "../domain/version.js";
import { versionCmd } from "../commands/version-cmd.js";
import {
  configCmd,
  type ConfigCommandError,
} from "../commands/config-cmd.js";
import {
  initCmd,
  INSIDE_EXISTING_REPOSITORY_DETAIL,
  type InitError,
  InsideExistingRepositoryError,
  REPOSITORY_ALREADY_EXISTS_DETAIL,
  RepositoryAlreadyExistsError,
} from "../commands/init-cmd.js";
import { logCmd, type LogError } from "../commands/log-cmd.js";
import { statusCmd, type StatusError } from "../commands/status-cmd.js";
import { commitCmd, type CommitError, InvalidCommitMessageError, INVALID_COMMIT_MESSAGE_DETAIL } from "../commands/commit-cmd.js";
import { revertCmd, type RevertError, TargetTreeAlreadyCurrentError, TARGET_TREE_ALREADY_CURRENT_DETAIL } from "../commands/revert-cmd.js";
import { mergeCmd, type MergeError } from "../commands/merge-cmd.js";
import { diffCmd, type DiffError } from "../commands/diff-cmd.js";
import { serveCmd, InvalidPortError } from "../commands/serve-cmd.js";
import { WorkingTreeCleanError, WorkingTreeDirtyError, RevisionOverflowError, WORKING_TREE_CLEAN_DETAIL, WORKING_TREE_DIRTY_DETAIL, REVISION_OVERFLOW_DETAIL } from "../commands/tree-ops.js";
import { UnknownVersionError } from "../commands/unknown-version.js";
import { PatchCollisionError } from "../commands/repo-operand.js";
import { UnsupportedWorkingTreeEntryError } from "../fs/tree-scan.js";
import { REPOSITORY_NOT_FOUND_DETAIL, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, RepositoryJsonSyntaxError, type RepoStoreLoadError } from "../repo-store/store.js";
import type { ReplayError } from "../replay/replay.js";
import {
  ChangeBaseConflictError,
  CorruptPatchError,
  CyclicCausalityError,
  DuplicatePatchError,
  IncompleteBaseClosureError,
  InvalidRevisionFormulaError,
  NonContiguousRevisionError,
  OtUnavailableError,
  ReplayNotReadyError,
  SchemaValidationError,
  type DotRef,
  UnknownFrontierDotError,
  UnreachablePatchError,
  UnsortedPatchesError,
} from "../errors/domain-errors.js";
import { InvalidCommandOrArgumentsError, InvalidDiffUsageError, type Command } from "./args.js";

// ---------------------------------------------------------------------------
// The command output value
// ---------------------------------------------------------------------------

/**
 * A command's exact output bytes: SPEC.md §7's stdout per command, plus the
 * stderr a command legitimately produces well short of an *error* —
 * today only `merge`'s `warning: auto-resolved ...` lines (SPEC.md §7.8).
 * Errors are not "output": they flow through `DispatchError` and render as
 * one `snap: <detail>` line on stderr, never through this value.
 */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** Lifts a command module's stdout-only result into a full `CommandOutput`. */
const asOutput = (stdout: string): CommandOutput => ({ stdout, stderr: "" });

// ---------------------------------------------------------------------------
// Phase-boundary error (the serve HTTP server lands in Phase 10)
// ---------------------------------------------------------------------------

/**
 * The command parsed and dispatched successfully, but its implementation
 * belongs to a later sub-job. The only command still on this path is
 * `--serve` (valid port → the server is Phase 10's `http/serve.ts`);
 * `main.ts` renders it like any other expected error (exit 1).
 */
export class CommandNotImplementedError extends Data.TaggedError("CommandNotImplementedError")<{
  readonly command: string;
}> {}

/** The commands whose real modules do not exist yet, by dispatch tag. */
const NOT_IMPLEMENTED: ReadonlySet<string> = new Set(["Serve"]);

/** Display names for the not-yet-implemented commands, by dispatch tag. */
const COMMAND_LABELS: Readonly<Record<string, string>> = {
  Serve: "--serve",
};

// ---------------------------------------------------------------------------
// The dispatch error union
// ---------------------------------------------------------------------------

/**
 * Every expected failure the CLI can render: the two grammar errors, the
 * phase-boundary error, and each command module's error union (plus the
 * service-level errors those unions already include, restated here so
 * `errorDetail`'s switch is exhaustive over what can actually arrive).
 */
export type DispatchError =
  | InvalidCommandOrArgumentsError
  | InvalidDiffUsageError
  | CommandNotImplementedError
  | InitError
  | ConfigCommandError
  | StatusError
  | LogError
  | CommitError
  | RevertError
  | MergeError
  | DiffError
  // Service-level errors, reached through the command unions above:
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | ConfigDecodeError
  | ContributorIdRequiredError
  | GlobalHomeUnavailableError
  | InvalidContributorIdError
  | InvalidPathError
  | InvalidVersionError
  | ReplayError
  | SchemaValidationError
  | UnsortedPatchesError
  | DuplicatePatchError
  | CorruptPatchError
  | NonContiguousRevisionError
  | IncompleteBaseClosureError
  | InvalidRevisionFormulaError
  | CyclicCausalityError
  | ChangeBaseConflictError
  | UnknownFrontierDotError
  | UnreachablePatchError
  | ReplayNotReadyError
  | OtUnavailableError
  | UnsupportedWorkingTreeEntryError
  | WorkingTreeCleanError
  | WorkingTreeDirtyError
  | RevisionOverflowError
  | UnknownVersionError
  | TargetTreeAlreadyCurrentError
  | PatchCollisionError
  | InvalidCommitMessageError
  | InvalidPortError
  | PlatformError;

/** The services a dispatched command may request. */
export type DispatchServices = FileSystem.FileSystem | ConfigService | RepoStore;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Formats a dot the way the validation diagnostics name one, `(id->n)`. */
const formatDot = (dot: DotRef): string => `(${dot.author}->${dot.revision})`;

/** Formats a dot list for `CyclicCausalityError`/`ReplayNotReadyError` diagnostics. */
const formatDots = (dots: ReadonlyArray<DotRef>): string => dots.map(formatDot).join(", ");

/**
 * The unprefixed `<detail>` for one expected error — the exact text
 * between `snap: ` and the trailing newline of SPEC.md §10's one-line
 * error format. Texts pinned byte-for-byte by the acceptance suite come
 * from their modules' `*_DETAIL` constants; the repository-validation
 * diagnostics are composed from each variant's structured fields
 * (tests/15 pins substrings of these, the exact full-suite wording
 * convergence belongs to the hardening phase).
 */
export function errorDetail(error: DispatchError): string {
  // `PlatformError` is `@effect/platform`'s abstract error superclass
  // (concrete `SystemError`/`BadArgument`/`UnknownException` instances,
  // each with its own `_tag`), not a member of this module's discriminated
  // union — so it is recognized structurally here, before the `_tag`
  // switch, and its own `message` (which already names module, method, and
  // cause) is used verbatim.
  if (isPlatformError(error)) {
    return error.message;
  }
  switch (error._tag) {
    case "InvalidCommandOrArgumentsError":
    case "InvalidDiffUsageError":
      return error.message;
    case "CommandNotImplementedError":
      return `${COMMAND_LABELS[error.command] ?? error.command} is not implemented yet`;
    case "RepositoryNotFoundError":
      return REPOSITORY_NOT_FOUND_DETAIL;
    case "RepositoryJsonSyntaxError":
      return error.detail;
    case "SchemaValidationError":
      return error.message;
    case "UnsortedPatchesError":
      return `patches are not sorted by author and revision: ${formatDot(error.dot)} is out of order`;
    case "DuplicatePatchError":
      return `duplicate patch at dot ${formatDot(error.dot)}`;
    case "CorruptPatchError":
      return `different patch values at dot ${formatDot(error.dot)}`;
    case "NonContiguousRevisionError":
      // Names the missing dot so the diagnostic doubles as the gap report
      // (tests/15-repository-validation.yaml pins the `missing a@x` shape).
      return `revisions are not contiguous for ${error.dot.author}: missing ${error.dot.author}->${error.expectedRevision} before ${error.dot.revision}`;
    case "IncompleteBaseClosureError":
      return `patch ${formatDot(error.patch)} has an incomplete base: missing ${error.missingBaseDot.author}->${error.missingBaseDot.revision}`;
    case "InvalidRevisionFormulaError":
      return `patch ${formatDot(error.patch)} must have revision ${error.expectedRevision} (base contributor revision + 1)`;
    case "CyclicCausalityError":
      return `cyclic or incomplete patch history: cycle through ${formatDots(error.cycle)}`;
    case "ChangeBaseConflictError":
      // Each raise site composes its complete diagnostic (path placement
      // varies per the suite's pins: e.g. the exactly-pinned
      // `delete of absent path: f`, tests/23, vs the end-anchored
      // `.+consumes beyond old content`), so the reason is printed bare.
      return error.reason;
    case "UnknownFrontierDotError":
      return `frontier names unknown dot ${formatDot(error.dot)}`;
    case "UnreachablePatchError":
      // `unreachable patch: ...` is the suite's pinned shape
      // (tests/23-strict-validation-matrix.yaml); the dot naming follows.
      return `unreachable patch: ${formatDot(error.dot)} is not part of the frontier's causal closure`;
    case "ReplayNotReadyError":
      return `cyclic or incomplete patch history: cannot reach ${formatDots(error.unreachable)}`;
    case "OtUnavailableError":
      return `operational transform unavailable for path ${error.path} in patch ${formatDot(error.patch)}`;
    case "ConfigDecodeError":
      return error.detail;
    case "ContributorIdRequiredError":
      return CONTRIBUTOR_ID_REQUIRED_DETAIL;
    case "GlobalHomeUnavailableError":
      return GLOBAL_HOME_UNAVAILABLE_DETAIL;
    case "InvalidContributorIdError":
      return `invalid contributor id: ${error.reason}`;
    case "RepositoryAlreadyExistsError":
      return REPOSITORY_ALREADY_EXISTS_DETAIL;
    case "InsideExistingRepositoryError":
      return INSIDE_EXISTING_REPOSITORY_DETAIL;
    case "UnsupportedWorkingTreeEntryError":
      return `unsupported working tree entry: ${error.path}`;
    case "InvalidPathError":
      return `invalid path: ${error.reason}`;
    case "InvalidVersionError":
      return `invalid version: ${error.reason}`;
    case "WorkingTreeCleanError":
      return WORKING_TREE_CLEAN_DETAIL;
    case "WorkingTreeDirtyError":
      return WORKING_TREE_DIRTY_DETAIL;
    case "RevisionOverflowError":
      return REVISION_OVERFLOW_DETAIL;
    case "InvalidCommitMessageError":
      return INVALID_COMMIT_MESSAGE_DETAIL;
    case "TargetTreeAlreadyCurrentError":
      return TARGET_TREE_ALREADY_CURRENT_DETAIL;
    case "UnknownVersionError":
      return error.detail;
    case "PatchCollisionError":
      return `patch collision: ${error.author} revision ${error.revision}`;
    case "InvalidPortError":
      return `invalid port: ${error.port}`;
  }
}

/** SPEC.md §10's one-line plain-mode error format: `snap: <detail>` plus LF. */
export function renderErrorLine(error: DispatchError): string {
  return `snap: ${errorDetail(error)}\n`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Executes one parsed command and returns its `CommandOutput` (exact
 * stdout and stderr bytes). Locating the nearest repository happens inside
 * the command modules that need it (`--version` in particular never
 * locates one, per SPEC.md §7.10), so this function carries no filesystem
 * work of its own.
 */
export function dispatch(
  command: Command,
): Effect.Effect<CommandOutput, DispatchError, DispatchServices> {
  switch (command._tag) {
    case "Init":
      return Effect.map(initCmd(command.path), asOutput);
    case "Config":
      return Effect.map(configCmd(command.global, command.id), asOutput);
    case "Status":
      return Effect.map(statusCmd(), asOutput);
    case "Log":
      return Effect.map(logCmd(), asOutput);
    case "Commit":
      return Effect.map(commitCmd(command.message), asOutput);
    case "Revert":
      return Effect.map(revertCmd(command.version), asOutput);
    case "Diff":
      return Effect.map(diffCmd(command.target), asOutput);
    case "Merge":
      return mergeCmd(command.repository);
    case "Version":
      // §7.10's `snap <semver>` line; version-cmd supplies the semver.
      return Effect.map(versionCmd, (result) => asOutput(`snap ${result.version}\n`));
    case "Serve":
      // §7.9's port validation is real (Phase 8); the server is Phase 10.
      return Effect.flatMap(serveCmd(command.port), () =>
        Effect.fail(new CommandNotImplementedError({ command: "Serve" })),
      );
  }
}