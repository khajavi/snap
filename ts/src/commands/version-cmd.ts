import { Effect } from "effect";

/**
 * The canonical semver string printed by `snap --version` (SPEC.md §7.10).
 * Hand-set per plan.md §3 rather than read from package.json, so the
 * printed bytes never drift with unrelated packaging changes.
 */
export const VERSION = "1.0.0";

/** Result value for the presentation layer to render (plan.md §1.3). */
export interface VersionResult {
  readonly version: string;
}

/** Command module: no services, no I/O — just produces the result value. */
export const versionCmd: Effect.Effect<VersionResult> = Effect.succeed({
  version: VERSION,
});
