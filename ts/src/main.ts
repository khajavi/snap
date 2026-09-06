/**
 * `snap` process entry point (SPEC.md §7/§10, plan.md §1.2/§1.3): parse
 * argv, dispatch to a command's Effect, run it against the production
 * service layers, write its exact stdout/stderr bytes, and exit per
 * SPEC.md §10's codes.
 *
 * The pipeline:
 *
 *   - `parseArgs(process.argv.slice(2))` → a typed `Command`, or an
 *     `ArgsError` (both grammar failures render as expected errors).
 *   - `dispatch` → `CommandOutput { stdout, stderr }`, in the `snap/...'
 *     service context (filesystem, config, repository store).
 *   - `Effect.exit` turns the program's typed channel into a `Cause`, then
 *     `toRunResult` folds it: a success writes the command's bytes (exit
 *     0); a *fail* cause is a value of `DispatchError` and writes SPEC.md
 *     §10's one line `snap: <detail>` on stderr (exit 1); any other
 *     cause — an invariant violation, a thrown exception, a defect —
 *     writes `snap: internal error` (exit 2), SPEC.md §10's "unexpected
 *     internal failures exit 2".
 *   - The layers: `NodeFileSystem.layer` for `@effect/platform`'s
 *     `FileSystem` service, then `ConfigServiceLive` and `RepoStoreLive`
 *     for `snap/ConfigService` and `snap/RepoStore`.
 *
 * Runtime-entry policy (plan.md §1.2, "Process lifecycle"): option (b) —
 * drive the top-level Effect with `Effect.runPromise` and own
 * SIGINT/SIGTERM handling manually, bypassing `@effect/platform-node`'s
 * `NodeRuntime.runMain` defaults entirely. SIGINT exits 130, SIGTERM 143
 * (the shell's convention), per the plan.
 */

import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Either, Exit, Layer } from "effect";
import { parseArgs } from "./cli/args.js";
import { fromEither } from "./cli/from-either.js";
import {
  dispatch,
  renderErrorLine,
  setPrintUrl,
  setServeShutdown,
  type CommandOutput,
  type DispatchError,
} from "./cli/dispatch.js";
import { ConfigServiceLive } from "./config/config.js";
import { RepoStoreLive } from "./repo-store/store.js";
import { resolveStreamModes, type StreamModes } from "./presentation/mode.js";
import { errorLine, renderFamilyOutput } from "./presentation/render.js";

/**
 * Process-lifecycle signals (plan.md §1.2): the default exits follow the
 * shell convention — SIGINT 130, SIGTERM 143. When `--serve` is running,
 * its installed shutdown handler *replaces* these: §7.9 requires serving
 * "until SIGINT or SIGTERM, then exits 0", closing the server after the
 * in-flight response finishes. The indirection is a single slot so the
 * serve path can swap the behavior without touching Effect's runtime.
 */
let exitOnSignal = (code: 130 | 143): void => process.exit(code);

process.on("SIGINT", () => exitOnSignal(130));
process.on("SIGTERM", () => exitOnSignal(143));

// `--serve` swaps the signal behavior and captures the plain URL printer
// (§7.11: the startup URL stays plain in both presentations).
setPrintUrl((url) => process.stdout.write(url));
setServeShutdown((handle) => {
  exitOnSignal = () => {
    void handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  };
});

/** The bytes to write to each stream, with the process's exit code. */
interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0 | 1 | 2;
}

/**
 * §7.11's per-stream presentation selection, resolved once from the real
 * environment *before command execution* — an invalid `SNAP_COLOR` must
 * fail before any command runs. The harness's redirected streams are
 * non-TTY, so `auto` resolves plain there; unit tests exercise the TTY
 * combinations directly against `resolveStreamModes` (SPEC.md §11's
 * per-implementation requirement).
 */
const selectedModes = resolveStreamModes(
  process.env["SNAP_COLOR"],
  "NO_COLOR" in process.env,
  process.stdout.isTTY === true,
  process.stderr.isTTY === true,
);

if (Either.isLeft(selectedModes)) {
  // §7.11: this error itself is plain, because no valid presentation was
  // selected. It is emitted instead of running any command.
  process.stderr.write(`snap: ${selectedModes.left}\n`);
  process.exitCode = 1;
} else {
  const effective = selectedModes.right;
  const renderError = (line: string): string => (effective.stderr === "terminal" ? errorLine(line) : line);

  /**
   * Folds a run's `Cause` into the concrete `RunResult` to write out. A
   * `Fail` cause is a value of the program's error channel
   * (`DispatchError`, since parse and dispatch share it); any other cause
   * shape is an internal failure and is never printed as a diagnostic.
   */
  const toRunResult = (exit: Exit.Exit<CommandOutput, DispatchError>): RunResult => {
    if (Exit.isSuccess(exit)) {
      return { ...renderFamilyOutput(exit.value, effective), exitCode: 0 };
    }
    const cause = exit.cause;
    if (Cause.isFailType(cause)) {
      const plain = renderErrorLine(cause.error as DispatchError);
      return { stdout: "", stderr: renderError(plain), exitCode: 1 };
    }
    return { stdout: "", stderr: renderError("snap: internal error\n"), exitCode: 2 };
  };

  // Effects are lazy; build the whole pipeline before running it.
  const handled = Effect.flatMap(fromEither(parseArgs(process.argv.slice(2))), dispatch).pipe(
    Effect.exit,
    Effect.map(toRunResult),
  );

  // `RepoStoreLive` reads the config, which reads the filesystem: feed
  // each inner layer into the next with `provideMerge`, so the merged
  // layer's output carries every service the program can require.
  const AppLayer = RepoStoreLive.pipe(
    Layer.provideMerge(ConfigServiceLive),
    Layer.provideMerge(NodeFileSystem.layer),
  );

  const result = await Effect.runPromise(Effect.provide(handled, AppLayer));

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}