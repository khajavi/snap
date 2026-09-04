import { Effect, Exit } from "effect";
import { versionCmd } from "./commands/version-cmd.js";

// Runtime-entry policy (plan.md §1.2, "Process lifecycle"): option (b) —
// drive the top-level Effect with `Effect.runPromiseExit` and own
// SIGINT/SIGTERM handling manually, bypassing `@effect/platform-node`'s
// `NodeRuntime.runMain` defaults entirely.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  const exit = await Effect.runPromiseExit(versionCmd);
  if (Exit.isSuccess(exit)) {
    process.stdout.write(`snap ${exit.value.version}\n`);
    process.exitCode = 0;
  } else {
    process.stderr.write("snap: internal error\n");
    process.exitCode = 2;
  }
} else {
  process.stderr.write("snap: not implemented\n");
  process.exitCode = 1;
}
