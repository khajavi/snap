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
import { Cause, Effect, Exit, Layer } from "effect";
import { parseArgs } from "./cli/args.js";
import { fromEither } from "./cli/from-either.js";
import { dispatch, renderErrorLine, type CommandOutput, type DispatchError } from "./cli/dispatch.js";
import { ConfigServiceLive } from "./config/config.js";
import { RepoStoreLive } from "./repo-store/store.js";

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

/** The bytes to write to each stream, with the process's exit code. */
interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0 | 1 | 2;
}

/**
 * Folds a run's `Cause` into the concrete `RunResult` to write out. A
 * `Fail` cause is a value of the program's error channel (`DispatchError`,
 * since parse and dispatch share it); any other cause shape is an
 * internal failure and is never printed as a diagnostic.
 */
const toRunResult = (exit: Exit.Exit<CommandOutput, DispatchError>): RunResult => {
  if (Exit.isSuccess(exit)) {
    return { stdout: exit.value.stdout, stderr: exit.value.stderr, exitCode: 0 };
  }
  const cause = exit.cause;
  if (Cause.isFailType(cause)) {
    return { stdout: "", stderr: renderErrorLine(cause.error as DispatchError), exitCode: 1 };
  }
  return { stdout: "", stderr: "snap: internal error\n", exitCode: 2 };
};

// Effects are lazy; build the whole pipeline before running it.
const handled = Effect.flatMap(fromEither(parseArgs(process.argv.slice(2))), dispatch).pipe(
  Effect.exit,
  Effect.map(toRunResult),
);

// `RepoStoreLive` reads the config, which reads the filesystem: feed each
// inner layer into the next with `provideMerge`, so the merged layer's
// output carries every service the program can require.
const AppLayer = RepoStoreLive.pipe(
  Layer.provideMerge(ConfigServiceLive),
  Layer.provideMerge(NodeFileSystem.layer),
);

const result = await Effect.runPromise(Effect.provide(handled, AppLayer));

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;