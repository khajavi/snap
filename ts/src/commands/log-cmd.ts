/**
 * `snap log` (SPEC.md §7.4, plan.md Phase 8): print patches in reverse
 * canonical integration order, one tab-separated line each:
 *
 *     (alice@example.com->1)\talice@example.com\tadd greeting
 *
 * The order is §6.1's deterministic ready-set integration sequence
 * (`replay/select.ts`'s `selectAndOrderPatches` over the repository's
 * whole patch set — for a validated repository that set is exactly the
 * causal closure of the frontier, so everything is selected), reversed
 * because §7.4 wants the most recently integrated patch first.
 *
 * Each line's first field is the patch's *result version* (§4.2's
 * `base` with `result[author] = revision`, canonicalized through
 * `Version.parse` → `toCanonicalString`, the same print-and-reparse
 * trick `replay/replay.ts`'s `versionOfPairs` uses). The message field
 * escapes backslash, tab, and LF as `\\`, `\t`, `\n` *in that order* —
 * backslash first, or the escape sequences themselves would be
 * double-escaped (tests/04 pins `first\tline\nsecond\\tail` rendering as
 * `first\\tline\\nsecond\\\\tail`).
 *
 * Log requires no contributor configuration (SPEC.md §8) and mutates
 * nothing; an empty repository prints nothing.
 */

import { FileSystem } from "@effect/platform";
import { Effect, Either } from "effect";
import { computePatchResult } from "../domain/patch.js";
import { versionOfPairs } from "../replay/replay.js";
import { selectAndOrderPatches, type PatchSelectionError } from "../replay/select.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";

/** Every error `logCmd` can produce. */
export type LogError = RepositoryNotFoundError | RepoStoreLoadError | PatchSelectionError;

/**
 * §7.4's message escaping: backslash, then tab, then LF, in that order.
 * The message grammar (§4.4) allows no other control characters, so
 * these three rules are its complete one-line rendering.
 */
const escapeMessage = (message: string): string =>
  message.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");

/**
 * Runs §7.4 from the process working directory. Returns the exact stdout
 * bytes: one LF-terminated line per patch in reverse canonical
 * integration order, or `""` for an empty repository.
 */
export function logCmd(): Effect.Effect<string, LogError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const repoRoot = yield* locateRepository(".");
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);
    const frontier = versionOfPairs(repository.frontier);

    // §6.1's sequence over the whole patch set (§7.4's "canonical
    // integration order"); the branch keeps the failure total — for a
    // repository that passed §4.5 validation it cannot fail.
    const ordered = selectAndOrderPatches(frontier, repository.patches);
    if (Either.isLeft(ordered)) {
      return yield* Effect.fail(ordered.left);
    }

    const lines = [...ordered.right]
      .reverse()
      .map(
        (patch) =>
          `${versionOfPairs(computePatchResult(patch)).toCanonicalString()}\t${patch.author}\t${escapeMessage(patch.message)}`,
      );
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  });
}
