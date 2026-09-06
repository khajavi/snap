/**
 * CLI argument grammar (SPEC.md §7): the pure argv-to-typed-command parser.
 *
 * SPEC.md §7's intro fixes the grammar's defining property: "Options occur
 * exactly in the positions shown below and may appear at most once. Unknown
 * options, extra operands, and missing option values are errors." The
 * grammar is therefore strictly positional — `--global` is legal only
 * immediately after `config` and before the `contributor.id` literal,
 * `--repo` only after `diff <old> <new>` — which is why this parser is
 * hand-rolled per plan.md §3 ("Hand-rolled CLI argument parsing") rather
 * than delegated to `@effect/cli`'s position-independent flag model.
 *
 * This module only parses. It never validates operand *values*: contributor
 * IDs, version syntax, port numbers, and repository URLs/paths belong to
 * the command modules that own those domains. tests/14-cli-errors.yaml
 * pins this boundary explicitly — `snap --serve 65536` must reach the serve
 * command and fail there with `snap: invalid port: 65536`, and
 * `snap revert (unknown@x->1)` must reach revert and fail with the
 * unknown-version detail — so neither may fail at parse time.
 *
 * Failures collapse into exactly the two stderr lines the acceptance suite
 * pins: the generic grammar-failure line (tests/24-cli-grammar-matrix.yaml's
 * `&invalid` anchor, tests/14-cli-errors.yaml, and tests/28's terminal-mode
 * rendering of the same bytes) and the diff-specific usage line shared by
 * every malformed `diff` invocation (tests/24's `&diff_usage`, matching
 * `^snap: usage: snap diff .+\n$`; tests/14 checks it contains
 * "usage: snap diff"). No finer-grained error text is pinned anywhere, so
 * none is produced: each error's `message` carries only the `<detail>` that
 * renders through SPEC.md §10's one-line `snap: <detail>` format.
 *
 * The error types live here (not in `errors/domain-errors.ts`) because CLI
 * grammar failures are a CLI-layer concern, separate from the domain-error
 * hierarchy — the same pattern the domain modules use for their own
 * grammar errors next to their grammars (`InvalidVersionError` in
 * `domain/version.ts`, `InvalidPathError` in `domain/path.ts`).
 *
 * Like those parsers, `parseArgs` is pure and returns `Either`, so the
 * dispatch layer composes it with `Effect.fromEither`.
 */

import { Data, Either } from "effect";

// ---------------------------------------------------------------------------
// Parse errors
// ---------------------------------------------------------------------------

/**
 * A grammar failure outside `diff`: an unknown command word, an unknown or
 * misplaced option, a repeated option, a missing operand, a missing option
 * value, or an extra operand. Renders as the pinned plain-mode line
 * `snap: invalid command or arguments` (SPEC.md §10's `snap: <detail>`
 * with this error's `message` as the detail).
 */
export class InvalidCommandOrArgumentsError extends Data.TaggedError(
  "InvalidCommandOrArgumentsError",
)<{
  readonly message: string;
}> {}

/**
 * A malformed `diff` invocation — one that matches neither of §7.6's two
 * arities. `diff` alone has its own pinned failure line rather than the
 * generic one: `snap: usage: snap diff [<old> <new> [--repo <repository>]]`,
 * constrained by tests/24's `^snap: usage: snap diff .+\n$` and tests/14's
 * "usage: snap diff" containment check.
 */
export class InvalidDiffUsageError extends Data.TaggedError("InvalidDiffUsageError")<{
  readonly message: string;
}> {}

/** Every way `parseArgs` can refuse an argv. */
export type ArgsError = InvalidCommandOrArgumentsError | InvalidDiffUsageError;

const invalidCommandOrArguments = (): InvalidCommandOrArgumentsError =>
  new InvalidCommandOrArgumentsError({ message: "invalid command or arguments" });

const invalidDiffUsage = (): InvalidDiffUsageError =>
  new InvalidDiffUsageError({ message: "usage: snap diff [<old> <new> [--repo <repository>]]" });

// ---------------------------------------------------------------------------
// The typed command value
// ---------------------------------------------------------------------------

/**
 * `snap diff`'s two arities as one typed payload (SPEC.md §7.6): with no
 * operands it compares the current tree with the working tree; with
 * `<old> <new>` it compares two versions, optionally resolving `new` in
 * another repository via a trailing `--repo <repository>`. Keeping the
 * arities as a nested union makes the illegal combinations (an `old`
 * without a `new`, a `--repo` without versions) unrepresentable.
 */
export type DiffTarget =
  | { readonly _tag: "WorkingTree" }
  | {
      readonly _tag: "Versions";
      readonly old: string;
      readonly new: string;
      /** Present only for the `--repo <repository>` form; else undefined. */
      readonly repo: string | undefined;
    };

/**
 * One variant per command in SPEC.md §7, carrying exactly the fields that
 * command's grammar defines. Optional slots are `string | undefined`:
 * `Init.path` (the `init` command applies §7.1's `.` default),
 * `Serve.port` (§7.9's `8765`), and `DiffTarget.Versions.repo`. No variant
 * carries validated values — operand validation belongs to the command
 * modules.
 */
export type Command =
  | { readonly _tag: "Init"; readonly path: string | undefined }
  | { readonly _tag: "Config"; readonly global: boolean; readonly id: string }
  | { readonly _tag: "Status" }
  | { readonly _tag: "Log" }
  | { readonly _tag: "Commit"; readonly message: string }
  | { readonly _tag: "Diff"; readonly target: DiffTarget }
  | { readonly _tag: "Revert"; readonly version: string }
  | { readonly _tag: "Merge"; readonly repository: string }
  | { readonly _tag: "Serve"; readonly port: string | undefined }
  | { readonly _tag: "Version" };

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Every option in §7's grammar is `--`-prefixed (`--global`, `--repo`,
 * `--serve`, `--version`), so a `--` prefix is what makes a token an
 * option. An option token in a slot the grammar fills with an operand is
 * an unknown option — tests/24 pins `init --unknown` and `log --unknown`
 * as failures even though both could otherwise read as operand values.
 */
const isOption = (token: string): boolean => token.startsWith("--");

/**
 * Parses argv (as `main.ts` receives it: `process.argv.slice(2)`) into a
 * typed command value, per SPEC.md §7's positional grammar as pinned by
 * tests/24-cli-grammar-matrix.yaml and tests/14-cli-errors.yaml. A missing
 * command word (empty argv) is itself a grammar failure; no pinned test
 * exercises a bare `snap` with no arguments.
 */
export function parseArgs(argv: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return parseInit(rest);
    case "config":
      return parseConfig(rest);
    case "status":
      return parseStatus(rest);
    case "log":
      return parseLog(rest);
    case "commit":
      return parseCommit(rest);
    case "diff":
      return parseDiff(rest);
    case "revert":
      return parseRevert(rest);
    case "merge":
      return parseMerge(rest);
    case "--serve":
      return parseServe(rest);
    case "--version":
      return parseVersion(rest);
    default:
      return Either.left(invalidCommandOrArguments());
  }
}

/** `snap init [path]` (§7.1). */
function parseInit(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [path, ...extra] = rest;
  if (extra.length > 0) return Either.left(invalidCommandOrArguments());
  if (path === undefined) return Either.right({ _tag: "Init", path: undefined });
  if (isOption(path)) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Init", path });
}

/** `snap config [--global] contributor.id <id>` (§7.2). */
function parseConfig(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const global = rest[0] === "--global";
  const afterGlobal = global ? rest.slice(1) : rest;
  const [literal, id, ...extra] = afterGlobal;
  // The literal operand is fixed by the grammar; anything else — including
  // a second `--global` (tests/24) — is a misplaced token.
  if (literal !== "contributor.id") return Either.left(invalidCommandOrArguments());
  if (id === undefined || isOption(id)) return Either.left(invalidCommandOrArguments());
  if (extra.length > 0) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Config", global, id });
}

/** `snap status` (§7.3). */
function parseStatus(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  if (rest.length > 0) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Status" });
}

/** `snap log` (§7.4). */
function parseLog(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  if (rest.length > 0) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Log" });
}

/** `snap commit <message>` (§7.5). */
function parseCommit(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [message, ...extra] = rest;
  if (extra.length > 0 || message === undefined || isOption(message)) {
    return Either.left(invalidCommandOrArguments());
  }
  return Either.right({ _tag: "Commit", message });
}

/**
 * `snap diff` or `snap diff <old> <new> [--repo <repository>]` (§7.6).
 * Every other `diff` shape — one operand, a third operand that is not
 * `--repo`, a missing `--repo` value, a repeated `--repo`, an unknown
 * option anywhere — shares the pinned usage line (tests/24's `&diff_usage`,
 * tests/14's two `usage: snap diff` cases).
 */
function parseDiff(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  if (rest.length === 0) {
    return Either.right({ _tag: "Diff", target: { _tag: "WorkingTree" } });
  }
  const [oldVersion, newVersion, third, fourth, ...extra] = rest;
  if (extra.length > 0) return Either.left(invalidDiffUsage());
  if (oldVersion === undefined || isOption(oldVersion)) return Either.left(invalidDiffUsage());
  if (newVersion === undefined || isOption(newVersion)) return Either.left(invalidDiffUsage());
  if (third === undefined) {
    return Either.right({
      _tag: "Diff",
      target: { _tag: "Versions", old: oldVersion, new: newVersion, repo: undefined },
    });
  }
  if (third !== "--repo") return Either.left(invalidDiffUsage());
  if (fourth === undefined || isOption(fourth)) return Either.left(invalidDiffUsage());
  return Either.right({
    _tag: "Diff",
    target: { _tag: "Versions", old: oldVersion, new: newVersion, repo: fourth },
  });
}

/** `snap revert <version>` (§7.7). */
function parseRevert(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [version, ...extra] = rest;
  if (extra.length > 0 || version === undefined || isOption(version)) {
    return Either.left(invalidCommandOrArguments());
  }
  return Either.right({ _tag: "Revert", version });
}

/** `snap merge <repository>` (§7.8). */
function parseMerge(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [repository, ...extra] = rest;
  if (extra.length > 0 || repository === undefined || isOption(repository)) {
    return Either.left(invalidCommandOrArguments());
  }
  return Either.right({ _tag: "Merge", repository });
}

/** `snap --serve [port]` (§7.9); port-number validation is serve's. */
function parseServe(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  const [port, ...extra] = rest;
  if (extra.length > 0) return Either.left(invalidCommandOrArguments());
  if (port === undefined) return Either.right({ _tag: "Serve", port: undefined });
  if (isOption(port)) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Serve", port });
}

/** `snap --version` (§7.10). */
function parseVersion(rest: ReadonlyArray<string>): Either.Either<Command, ArgsError> {
  if (rest.length > 0) return Either.left(invalidCommandOrArguments());
  return Either.right({ _tag: "Version" });
}
