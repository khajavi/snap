/**
 * Presentation-mode selection (SPEC.md §7.11, plan.md Phase 9): which of
 * the two output presentations — `plain` or `terminal` — each standard
 * stream uses, resolved from `SNAP_COLOR`/`NO_COLOR` and per-stream TTY
 * state.
 *
 * SPEC.md §7.11's selection table:
 *
 *   - `SNAP_COLOR` unset or `auto`: terminal mode **independently** on
 *     stdout or stderr when that stream is a TTY, unless `NO_COLOR` is
 *     present;
 *   - `SNAP_COLOR=always`: terminal mode on both streams, even when
 *     redirected; overrides `NO_COLOR`;
 *   - `SNAP_COLOR=never`: plain mode on both streams;
 *   - any other value: an error *before command execution* (its own
 *     rendering is always plain, because no valid presentation exists).
 *
 * `NO_COLOR` is treated conservatively: its *presence* — including an
 * empty value — selects the complete plain presentation in `auto` mode,
 * rather than merely suppressing color codes.
 *
 * Pure and synchronous: environment record plus two TTY booleans in,
 * selection out — the shape SPEC.md §11 requires each implementation to
 * unit-test for TTY and non-TTY stdout and stderr independently. Reading
 * `process.env`/`process.stdout.isTTY` happens once, in `main.ts`.
 */

import { Either } from "effect";

/** The two presentations SPEC.md §7.11 defines. */
export type PresentationMode = "plain" | "terminal";

/** The independently selected mode of each standard stream. */
export interface StreamModes {
  readonly stdout: PresentationMode;
  readonly stderr: PresentationMode;
}

/** §7.11's exact invalid-value detail text, unprefixed. */
export const SNAP_COLOR_INVALID_DETAIL = "SNAP_COLOR must be auto, always, or never";

/** §7.11's three legal `SNAP_COLOR` values. */
type SnapColor = "auto" | "always" | "never";

/**
 * Classifies the raw `SNAP_COLOR` environment value (`undefined` when
 * unset). Any value outside §7.11's three legal ones — including `""` —
 * is the pre-execution error.
 */
export function parseSnapColor(value: string | undefined): Either.Either<SnapColor, typeof SNAP_COLOR_INVALID_DETAIL> {
  if (value === undefined || value === "auto") {
    return Either.right("auto");
  }
  if (value === "always" || value === "never") {
    return Either.right(value);
  }
  return Either.left(SNAP_COLOR_INVALID_DETAIL);
}

/**
 * Resolves each stream's presentation per §7.11's table. `stdoutIsTTY`/
 * `stderrIsTTY` are independent on purpose: `auto` selects terminal mode
 * per stream, so a piped stdout alongside a TTY stderr colors only
 * stderr (and vice versa).
 */
export function resolveStreamModes(
  snapColor: string | undefined,
  noColorPresent: boolean,
  stdoutIsTTY: boolean,
  stderrIsTTY: boolean,
): Either.Either<StreamModes, typeof SNAP_COLOR_INVALID_DETAIL> {
  return Either.map(parseSnapColor(snapColor), (color) => {
    if (color === "never") {
      return { stdout: "plain", stderr: "plain" };
    }
    if (color === "always") {
      // §7.11: "terminal mode on both streams, even when redirected;
      // overrides `NO_COLOR`."
      return { stdout: "terminal", stderr: "terminal" };
    }
    // `auto`: NO_COLOR's presence — even empty — forces complete plain
    // presentation; otherwise terminal mode exactly when the stream is
    // a TTY, decided per stream.
    if (noColorPresent) {
      return { stdout: "plain", stderr: "plain" };
    }
    return {
      stdout: stdoutIsTTY ? "terminal" : "plain",
      stderr: stderrIsTTY ? "terminal" : "plain",
    };
  });
}
