/**
 * Terminal-mode renderers (SPEC.md §7.11, plan.md Phase 9): the pure
 * plain→terminal transforms for every output family the acceptance suite
 * pins byte-for-byte. Each function consumes the *plain-mode* bytes a
 * command produces (§7.1–§7.10, §6.4, §10) and returns the §7.11
 * terminal layout for that family.
 *
 * Design rule (§7.11): "Selecting a presentation MUST NOT change command
 * execution" — so these functions never re-derive content; they restyle
 * the plain bytes. That is why the commands emit plain text even in
 * terminal mode and why every family's plain output is line-structured
 * enough to restyle safely: command stdout lines have no interior LF
 * (paths cannot contain control characters per §2's grammar; log
 * messages are §7.4-escaped), so splitting on LF and rejoining is a
 * lossless restyling of these specific families, and `diff`'s `\n`
 * markers cannot collide with a text token's own lines (a token starting
 * with a backslash would still be prefixed ` \` by the script's own
 * space prefix, and a *continuation* line inside a token only exists for
 * the pinned `\ No newline at end of file` marker).
 *
 * The literal-prefix precedence for diff lines is §7.11's rule, now
 * stated explicitly in the SPEC (Open Spec Issue 6) and pinned by
 * tests/28's dash/plus-heavy case: `--- `/`+++ ` → bold wins over `-`/`+`
 * → red/green, then `@@ `, `\ `, and `Binary files `.
 */

import { CODE, styled, type Code } from "./ansi.js";
import type { PresentationMode, StreamModes } from "./mode.js";

/** Restyles each LF-separated line of a multi-line family. */
function mapLines(text: string, styleLine: (line: string) => string): string {
  if (text === "") {
    return "";
  }
  const lines = text.split("\n");
  // The final element after a trailing LF is ""; keep it so the rejoined
  // text ends with LF exactly like the input (§7.11: every nonempty
  // record ends with LF, and presentation adds no trailing content).
  const last = lines.length - 1;
  const styledLines = lines.map((line, i) => (line === "" && i === last ? line : styleLine(line)));
  return styledLines.join("\n");
}

// ---------------------------------------------------------------------------
// Success banners: init/commit/revert/merge (§7.11's first bullet)
// ---------------------------------------------------------------------------

/** The plain-mode label each success command renders in terminal mode. */
export type SuccessLabel = "Initialized repository" | "Committed" | "Reverted" | "Merged";

/** The plain line a success command emits (e.g. `(alice@x->1)` or `()`). */
export function successBanner(label: SuccessLabel, version: string): string {
  return `${styled(CODE.green, "✓")} ${styled(CODE.bold, label)} ${styled(CODE.cyan, version)}\n`;
}

// ---------------------------------------------------------------------------
// status (§7.11's second bullet)
// ---------------------------------------------------------------------------

/** One plain status change row's code character and path. */
export interface StatusRow {
  readonly code: "A" | "D" | "M";
  readonly path: string;
}

/** §7.11's terminal `status` layout: header, blank line, then rows (or the clean line). */
export function statusScreen(version: string, rows: ReadonlyArray<StatusRow>): string {
  const header = `${styled(CODE.bold, "Snap status")}  ${styled(CODE.cyan, version)}\n\n`;
  if (rows.length === 0) {
    return `${header}  ${styled(CODE.green, "✓")} Working tree clean\n`;
  }
  const symbols: Record<StatusRow["code"], { code: Code; symbol: string; label: string }> = {
    A: { code: CODE.green, symbol: "+", label: "added" },
    D: { code: CODE.red, symbol: "−", label: "deleted" },
    M: { code: CODE.yellow, symbol: "~", label: "modified" },
  };
  const rendered = rows.map(
    (row) =>
      `  ${styled(symbols[row.code].code, symbols[row.code].symbol)} ${row.path} ${styled(CODE.dim, `(${symbols[row.code].label})`)}\n`,
  );
  return header + rendered.join("");
}

// ---------------------------------------------------------------------------
// log (§7.11's fourth bullet)
// ---------------------------------------------------------------------------

/** One plain log entry's three fields (§7.4's tab-separated line). */
export interface LogEntry {
  readonly version: string;
  readonly author: string;
  readonly message: string;
}

/** §7.11's terminal `log` layout: one LF between entries, none after the last. */
export function logScreen(entries: ReadonlyArray<LogEntry>): string {
  if (entries.length === 0) {
    return "";
  }
  // §7.11: "Entries have one additional LF between them" — between, not
  // after: each entry is a two-line record ending in LF, and entries are
  // joined with one extra LF. The final entry ends with exactly one LF,
  // matching the §7.11 rule that every nonempty record ends with LF.
  return entries
    .map(
      (entry) =>
        `${styled(CODE.cyan, "●")} ${styled(CODE.bold, entry.message)}\n  ${styled(CODE.cyan, entry.version)} ${styled(CODE.dim, "by")} ${styled(CODE.magenta, entry.author)}\n`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// diff (§7.11's fifth bullet — the literal-prefix rule, Issue 6)
// ---------------------------------------------------------------------------

/**
 * Restyles one plain diff line by §7.11's first-applicable-style rule.
 * The order below is the SPEC's list order; matching is a literal prefix
 * match on the rendered line, so a deleted token whose content begins
 * `-- ` (printed as `--- ...`) takes the header style — the precedence
 * tests/28 now pins (Open Spec Issue 6).
 */
export function styleDiffLine(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    return styled(CODE.bold, line);
  }
  if (line.startsWith("@@ ")) {
    return styled(CODE.cyan, line);
  }
  if (line.startsWith("-")) {
    return styled(CODE.red, line);
  }
  if (line.startsWith("+")) {
    return styled(CODE.green, line);
  }
  if (line.startsWith("\\ ")) {
    return styled(CODE.dim, line);
  }
  if (line.startsWith("Binary files ")) {
    return styled(CODE.yellow, line);
  }
  return line;
}

/** Restyles a complete plain diff rendering, line by line. */
export function diffScreen(plainDiff: string): string {
  return mapLines(plainDiff, styleDiffLine);
}

// ---------------------------------------------------------------------------
// --version (§7.11's sixth bullet)
// ---------------------------------------------------------------------------

/** §7.11's terminal `--version` layout. */
export function versionScreen(semver: string): string {
  return `${styled(CODE.bold, `snap ${semver}`)}\n`;
}

// ---------------------------------------------------------------------------
// Warnings and errors (§7.11's seventh bullet)
// ---------------------------------------------------------------------------

/**
 * One plain `warning: <detail>` line's terminal rendering *without* its
 * trailing LF (the form `mapLines` re-joins).
 */
function warningSegment(plainLine: string): string {
  const detail = plainLine.startsWith("warning: ") ? plainLine.slice("warning: ".length) : plainLine;
  return `${styled(CODE.yellow, "⚠")} ${styled(CODE.yellow, detail)}`;
}

/**
 * One plain `warning: <detail>` line in terminal mode, LF-terminated.
 * `plainLine` is the complete plain line (with its `warning: ` prefix);
 * the rendered detail is everything after that prefix, restyled yellow.
 */
export function warningLine(plainLine: string): string {
  return `${warningSegment(plainLine.endsWith("\n") ? plainLine.slice(0, -1) : plainLine)}\n`;
}

/** Restyles a whole plain stderr of consecutive warning lines. */
export function warningsScreen(plainStderr: string): string {
  return mapLines(plainStderr, warningSegment);
}

/**
 * One plain `snap: <detail>` error line in terminal mode: the entire
 * plain line is wrapped — `S(31, "✗ " + <error>)` — including the
 * `snap: ` prefix (pinned byte-for-byte by tests/28's unknown-command
 * case). Accepts the plain line with or without its trailing LF; the
 * output always ends with exactly one.
 */
export function errorLine(plainLine: string): string {
  const line = plainLine.endsWith("\n") ? plainLine.slice(0, -1) : plainLine;
  return `${styled(CODE.red, `✗ ${line}`)}\n`;
}

// ---------------------------------------------------------------------------
// Output families and the plain→terminal composition boundary
// ---------------------------------------------------------------------------

/**
 * Which §7.11 layout family a command's plain stdout belongs to. The
 * dispatch layer tags each command's output with one of these; terminal
 * restyling (and only terminal restyling) dispatches on it.
 */
export type OutputFamily =
  | { readonly kind: "banner"; readonly label: SuccessLabel }
  | { readonly kind: "status" }
  | { readonly kind: "log" }
  | { readonly kind: "diff" }
  | { readonly kind: "version" }
  | { readonly kind: "silent" }
  | { readonly kind: "url" };

/** A command's plain-mode bytes tagged with their output family. */
export interface FamilyOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly family: OutputFamily;
}

/** Strips one trailing LF (plain records are LF-terminated). */
const stripLf = (s: string): string => (s.endsWith("\n") ? s.slice(0, -1) : s);

/**
 * Parses the plain `status` rendering back into its header version and
 * change rows. Safe because the row grammar is `<code> <path>` with the
 * whole rest of the line as the path (paths may contain spaces, e.g.
 * tests/28's `trailing `), and paths cannot contain LF (§2's grammar
 * rejects control characters), so LF-splitting is lossless.
 */
export function parseStatusPlain(plain: string): { version: string; rows: ReadonlyArray<StatusRow> } {
  const lines = plain.split("\n");
  const first = lines[0] ?? "";
  const version = first.startsWith("version ") ? first.slice("version ".length) : stripLf(first);
  const rows: StatusRow[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") {
      continue;
    }
    rows.push({ code: line.charAt(0) as StatusRow["code"], path: line.slice(2) });
  }
  return { version, rows };
}

/**
 * Parses the plain `log` rendering back into entries. Safe because §7.4
 * escapes tab and LF out of messages, so each line is exactly three
 * tab-separated fields.
 */
export function parseLogPlain(plain: string): ReadonlyArray<LogEntry> {
  const entries: LogEntry[] = [];
  for (const line of plain.split("\n")) {
    if (line === "") {
      continue;
    }
    const [version, author, message] = line.split("\t");
    entries.push({ version: version ?? "", author: author ?? "", message: message ?? "" });
  }
  return entries;
}

/** Terminal-mode stdout for one family, from its plain bytes. */
function stdoutTerminal(output: FamilyOutput): string {
  switch (output.family.kind) {
    case "banner":
      return successBanner(output.family.label, stripLf(output.stdout));
    case "status": {
      const { version, rows } = parseStatusPlain(output.stdout);
      return statusScreen(version, rows);
    }
    case "log":
      return logScreen(parseLogPlain(output.stdout));
    case "diff":
      return diffScreen(output.stdout);
    case "version":
      return versionScreen(stripLf(output.stdout).slice("snap ".length));
    case "silent":
    case "url":
      // §7.11: config remains silent; the --serve startup URL always
      // remains plain so a client can consume it without stripping ANSI.
      return output.stdout;
  }
}

/**
 * Composes a command's plain output with the per-stream §7.11 selection:
 * plain bytes through untouched in plain mode, restyled per family in
 * terminal mode. stderr carries only §6.4 warning lines (the sole
 * non-error stderr a command produces), restyled as a block.
 */
export function renderFamilyOutput(
  output: FamilyOutput,
  modes: StreamModes,
): { stdout: string; stderr: string } {
  return {
    stdout: modes.stdout === "terminal" ? stdoutTerminal(output) : output.stdout,
    stderr:
      output.stderr === "" || modes.stderr === "plain"
        ? output.stderr
        : warningsScreen(output.stderr),
  };
}
