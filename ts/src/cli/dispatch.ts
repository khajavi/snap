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
 * **Serving is Phase 10's `http/serve.ts`.** The `Serve` case runs the
 * validated-port command module, then hands the port to `serveRepository`:
 * bind loopback, print the plain startup URL (§7.11: it stays plain in
 * both presentations), and block until SIGINT/SIGTERM — whose handlers
 * close the server and exit 0 per §7.9. The URL callback is injected so
 * dispatch stays stream-agnostic.
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
import { serveRepository, type ServeHandle } from "../http/serve.js";
import { HttpRepositoryStatusError } from "../repo-store/http-source.js";
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
import type { FamilyOutput, OutputFamily } from "../presentation/render.js";

// ---------------------------------------------------------------------------
// The command output value
// ---------------------------------------------------------------------------

/**
 * A command's exact output bytes: SPEC.md §7's stdout per command, plus the
 * stderr a command legitimately produces well short of an *error* —
 * today only `merge`'s `warning: auto-resolved ...` lines (SPEC.md §7.8).
 * Errors are not "output": they flow through `DispatchError` and render as
 * one `snap: <detail>` line on stderr, never through this value.
 *
 * The stdout bytes are always **plain-mode** (§7.11: presentation must not
 * change command execution), tagged with the §7.11 output family the
 * presentation layer restyles in terminal mode — see `FamilyOutput`.
 */
export type CommandOutput = FamilyOutput;

/** Lifts a command module's stdout-only result into a family-tagged output. */
const asOutput = (stdout: string, family: OutputFamily): CommandOutput => ({ stdout, stderr: "", family });

/**
 * §7.10a's help text: one synopsis line per command in §7.1–§7.9, then
 * `--version` and `--help`, in that order. Kept next to `dispatch`'s
 * Version case, which consumes it for both output families.
 */
const HELP_TEXT = [
  "usage: snap init [path]",
  "usage: snap config [--global] contributor.id <id>",
  "usage: snap status",
  "usage: snap log",
  "usage: snap commit <message>",
  "usage: snap diff [<old> <new> [--repo <repository>]]",
  "usage: snap revert <version>",
  "usage: snap merge <repository>",
  "usage: snap --serve [port]",
  "usage: snap --version",
  "usage: snap --help",
].join("\n").concat("\n");

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
  | InvalidPortError
  | HttpRepositoryStatusError
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
    case "HttpRepositoryStatusError":
      // §9's non-200 detail, pinned by tests/13's `HTTP 302` redirect case.
      return `HTTP ${error.status}`;
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
/**
 * Injected by `main.ts`: writes (and flushes) the `--serve` startup URL
 * line. Plain bytes in both presentations, per §7.11.
 */
export type PrintUrl = (url: string) => void;

/** Module-level seam for the `--serve` URL printer (see `dispatch`). */
let printUrl: PrintUrl = () => undefined;

/** Installs the `--serve` URL printer; called once from `main.ts`. */
export function setPrintUrl(impl: PrintUrl): void {
  printUrl = impl;
}

/**
 * Injected by `main.ts`: installs §7.9's signal shutdown for a *ready*
 * serve handle — on SIGINT/SIGTERM, close the server (its `close`
 * resolves after the in-flight response finishes) and exit 0.
 */
export type RegisterServeShutdown = (handle: ServeHandle) => void;

/** Module-level seam for the `--serve` shutdown installer. */
let registerServeShutdown: RegisterServeShutdown = () => undefined;

/** Installs the `--serve` shutdown installer; called once from `main.ts`. */
export function setServeShutdown(impl: RegisterServeShutdown): void {
  registerServeShutdown = impl;
}

export function dispatch(
  command: Command,
): Effect.Effect<CommandOutput, DispatchError, DispatchServices> {
  switch (command._tag) {
    case "Init":
      // §7.11: init's plain `()` becomes the "Initialized repository" banner.
      return Effect.map(initCmd(command.path), (out) => asOutput(out, { kind: "banner", label: "Initialized repository" }));
    case "Config":
      // §7.11: config remains silent in both presentations.
      return Effect.map(configCmd(command.global, command.id), (out) => asOutput(out, { kind: "silent" }));
    case "Status":
      return Effect.map(statusCmd(), (out) => asOutput(out, { kind: "status" }));
    case "Log":
      return Effect.map(logCmd(), (out) => asOutput(out, { kind: "log" }));
    case "Commit":
      return Effect.map(commitCmd(command.message), (out) => asOutput(out, { kind: "banner", label: "Committed" }));
    case "Revert":
      return Effect.map(revertCmd(command.version), (out) => asOutput(out, { kind: "banner", label: "Reverted" }));
    case "Diff":
      return Effect.map(diffCmd(command.target), (out) => asOutput(out, { kind: "diff" }));
    case "Merge":
      return Effect.map(mergeCmd(command.repository), (out) => ({ ...out, family: { kind: "banner", label: "Merged" } as const }));
    case "Version":
      // §7.10's `snap <semver>` line; version-cmd supplies the semver.
      return Effect.map(versionCmd, (result) => asOutput(`snap ${result.version}\n`, { kind: "version" }));
    case "Help":
      // §7.10a's synopsis block; like `--version`, never locates a
      // repository and touches nothing.
      return Effect.succeed(asOutput(HELP_TEXT, { kind: "help" }));
    case "Serve":
      // §7.9: validate the port, then serve the startup snapshot. Startup
      // failures (invalid port already filtered by `serveCmd`; missing or
      // invalid repository) fail this Effect normally and render as the
      // standard one-line error. On success the URL has been printed and
      // the shutdown handler installed; the Effect deliberately never
      // completes — the process's own SIGINT/SIGTERM handler closes the
      // server (finishing any in-flight response) and exits 0.
      return Effect.flatMap(serveCmd(command.port), (port) =>
        Effect.flatMap(serveRepository(port, printUrl), (handle) => {
          registerServeShutdown(handle);
          return Effect.never;
        }),
      );
  }
}