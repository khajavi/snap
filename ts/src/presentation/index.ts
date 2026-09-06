/**
 * Re-exports the presentation layer's two halves under one module path:
 *
 *   - `mode.ts`: `SNAP_COLOR`/`NO_COLOR` resolution per stream (§7.11's
 *     selection table, including the pre-execution error);
 *   - `ansi.ts`: the `S(n, text)` primitive;
 *   - `render.ts`: the per-family plain→terminal transforms and the
 *     `renderFamilyOutput` composition boundary `main.ts` drives.
 *
 * Nothing outside `presentation/` inspects ANSI codes or modes; command
 * modules always produce plain bytes tagged with an output family, which
 * is what keeps §7.11's "MUST NOT change command execution" guarantee
 * structural rather than conventional.
 */

export * from "./mode.js";
export * from "./ansi.js";
export * from "./render.js";
