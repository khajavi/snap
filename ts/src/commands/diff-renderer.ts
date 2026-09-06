/**
 * SPEC.md §7.6's whole-file unified diff rendering (plain mode): the pure
 * function that turns a pair of `Tree` values into the exact stdout bytes
 * every `snap diff` invocation prints.
 *
 * The contract, from §7.6:
 *
 *   - Changed paths sort by path (§2's unsigned-UTF-8 byte order).
 *   - A **text path** (new content is text and the old side is absent or
 *     text, Symmetrically for a text→absent removal) prints one
 *     whole-file block: `--- <old-label>`, `+++ <new-label>`,
 *     `@@ -1,<old-token-count> +1,<new-token-count> @@` (the *whole-file*
 *     token counts, not hunk sizes), then every token of §5's canonical
 *     edit script with its space/`-`/`+` prefix. A token without a final
 *     LF is followed by LF and then `\ No newline at end of file`.
 *   - **Absent sides** get label `/dev/null` in their header.
 *   - A **binary change** prints one line,
 *     `Binary files <old-label> and <new-label> differ`, again with
 *     `/dev/null` for an absent side.
 *   - No differences means no stdout (and success, decided by the
 *     caller).
 *
 * Both blocks and binary lines are emitted for a changed path (tests/26
 * mixes them in one repository), in path order. Pinned byte-for-byte by
 * tests/05-diff-goldens.yaml, tests/06-binary-and-empty.yaml, and
 * tests/26-portability-and-failure-safety.yaml.
 *
 * Pure and synchronous: `Tree`s in, exact bytes out, no services.
 */

import { diffTokens } from "../domain/diff.js";
import type { TrackedPath } from "../domain/path.js";
import type { Tree } from "../replay/integrate.js";
import type { PathState } from "../replay/tiebreak.js";
import { pathStatesEqual } from "../replay/tiebreak.js";
import { unionPathsSorted } from "./tree-ops.js";

/** The state of a path a tree does not contain. */
const ABSENT: PathState = { _tag: "Absent" };

/** §7.6's header label for one side of a changed path: `a/<path>`/`b/<path>`, or `/dev/null` when absent. */
const sideLabel = (prefix: "a" | "b", state: PathState, path: TrackedPath): string =>
  state._tag === "Absent" ? "/dev/null" : `${prefix}/${path}`;

/** One token line with its §5 marker prefix, plus the missing-final-LF marker when the token lacks LF. */
function tokenLine(prefix: string, token: string): string {
  const line = `${prefix}${token}`;
  return token.endsWith("\n")
    ? line
    : `${line}\n\\ No newline at end of file\n`;
}

/**
 * One whole-file text block (SPEC.md §7.6): the two headers, the
 * whole-file-count hunk header, and every token of §5's canonical script
 * exactly once. `--- /dev/null` labels a creation, `+++ /dev/null` a
 * removal; absent and text states both contribute their token counts (0
 * for absent, §4.4's canonical token sequence for text).
 */
function textBlock(
  oldLabel: string,
  newLabel: string,
  oldTokens: ReadonlyArray<string>,
  newTokens: ReadonlyArray<string>,
): string {
  const lines: string[] = [
    `--- ${oldLabel}\n`,
    `+++ ${newLabel}\n`,
    `@@ -1,${oldTokens.length} +1,${newTokens.length} @@\n`,
  ];
  // One running cursor over `oldTokens`, advanced by every `retain` and
  // `delete` in script order (SPEC §4.4: "The script MUST consume the
  // complete old token sequence"), so each marker picks the exact old
  // token it names — a `delete` after earlier `retain`s is not the first
  // old token.
  let oldIndex = 0;
  for (const op of diffTokens(oldTokens, newTokens)) {
    if ("retain" in op) {
      let remaining = op.retain;
      while (remaining > 0) {
        lines.push(tokenLine(" ", oldTokens[oldIndex]!));
        oldIndex++;
        remaining--;
      }
    } else if ("delete" in op) {
      let remaining = op.delete;
      while (remaining > 0) {
        lines.push(tokenLine("-", oldTokens[oldIndex]!));
        oldIndex++;
        remaining--;
      }
    } else {
      for (const token of op.insert) {
        lines.push(tokenLine("+", token));
      }
    }
  }
  return lines.join("");
}

/**
 * Renders the difference from tree `a` to tree `b` per SPEC.md §7.6:
 * one block or binary line per changed path, in §2's path order. Changed
 * paths skipped by the per-path content comparison contribute nothing;
 * a pair of equal trees renders `""`.
 */
export function renderTreeDiff(a: Tree, b: Tree): string {
  const blocks: string[] = [];
  for (const path of unionPathsSorted(a, b)) {
    const old = a.get(path) ?? ABSENT;
    const next = b.get(path) ?? ABSENT;
    if (pathStatesEqual(old, next)) {
      continue;
    }

    // §7.6's text eligibility: new content is text and the old side is
    // absent or text; plus the symmetric removal direction (old text,
    // new absent) — matching §7.5's change authoring.
    const isTextChange =
      (next._tag === "Absent" && old._tag === "Text") ||
      (next._tag === "Text" && (old._tag === "Absent" || old._tag === "Text"));

    if (isTextChange) {
      const oldTokens = old._tag === "Text" ? old.tokens : [];
      const newTokens = next._tag === "Text" ? next.tokens : [];
      blocks.push(
        textBlock(sideLabel("a", old, path), sideLabel("b", next, path), oldTokens, newTokens),
      );
    } else {
      blocks.push(
        `Binary files ${sideLabel("a", old, path)} and ${sideLabel("b", next, path)} differ\n`,
      );
    }
  }
  return blocks.join("");
}