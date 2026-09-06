/**
 * `snap commit <message>` (SPEC.md §7.5, plan.md Phase 8): snapshot the
 * working tree as the next patch by this repository's configured
 * contributor.
 *
 * §7.5's procedure, in its own order: "Snap resolves contributor
 * configuration (§8), validates the message, scans the working tree, and
 * replays the current tree. If the tree is clean it fails; otherwise it
 * authors the change set, checks the revision overflow, patches the
 * repository, and writes the diff to disk."
 *
 * So, in order this module runs them:
 *
 *   1. `locateRepository` (§7's intro: every repository command "runs in
 *      the nearest repository"); without one, `not a Snap repository`.
 *   2. `ConfigService#requireContributorId` (§8: "Only `commit` and
 *      `revert` author patches and therefore require an ID").
 *   3. **Message validation** — §4.2's message grammar (nonempty, no
 *      ASCII control character other than tab and LF) *plus* §7.5's
 *      pinned cap: "`snap commit` limits user-supplied messages to 4096
 *      bytes." Any violation is the one pinned error `invalid commit
 *      message` (tests/25 pins `commit ""` on a *clean* tree printing
 *      that, so validation must precede the clean check).
 *   4. `scanWorkingTree`, failing on the first unsupported entry by path
 *      (SPEC.md §10; tests/08).
 *   5. Replay the current (frontier) tree.
 *   6. Clean-tree check (§2's definition via `tree-ops.ts`) — §7.5:
 *      "If the tree is clean it fails" with `working tree is clean`
 *      (tests/09, /25).
 *   7. Author the change set from current tree → working tree (§7.5's
 *      classification via `tree-ops.ts`'s `authorChanges`, shared with
 *      `revert`), check the revision overflow (§7.5: a revision past
 *      §3.1's bound "is an error"), patch the repository (base = the
 *      current frontier, per §4.2's `revision = base[author] + 1` and
 *      `result = B with result[author] = revision`), and — per §7.5's
 *      closing "writes the diff to disk" — install the committed tree and
 *      then update `.snap/repository.json` (the §7.8-locked-order twin:
 *      materialize first, repository save second).
 *   8. Print the repository's new full frontier as a canonical version
 *      (§7.5: "prints the new version").
 *
 * The patch is saved already in §4.5's canonical order: `repositoryAfterPatch`
 * inserts it into the validated (sorted) patch list at its dot position via
 * `repo-operand.ts`'s `insertPatchSorted`, so the file on disk is always
 * §4.1-canonical without a re-sort.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Either, Schema } from "effect";
import { MessageSchema, computePatchResult, type Patch } from "../domain/patch.js";
import { revisionOfVersionPairs } from "../domain/patch.js";
import { ConfigService, type ConfigDecodeError, type ContributorIdRequiredError } from "../config/config.js";
import {
  WorkingTreeCleanError,
  authorChanges,
  checkedNextRevision,
  firstUnsupportedError,
  isWorkingTreeClean,
  type RevisionOverflowError,
} from "./tree-ops.js";
import type { InvalidPathError } from "../domain/path.js";
import { UnsupportedWorkingTreeEntryError, scanWorkingTree } from "../fs/tree-scan.js";
import { materialize } from "../fs/materialize.js";
import { replay, versionOfPairs, type ReplayError } from "../replay/replay.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, type RepoStoreLoadError } from "../repo-store/store.js";
import { repositoryAfterPatch } from "./repo-operand.js";

/** SPEC.md §7.5's exact invalid-message detail text, unprefixed. */
export const INVALID_COMMIT_MESSAGE_DETAIL = "invalid commit message";

/** A user-supplied commit message over this many UTF-8 bytes is rejected (§7.5's cap). */
export const COMMIT_MESSAGE_MAX_BYTES = 4096;

/** §7.5: a message violating §4.2's grammar or §7.5's 4096-byte cap. */
export class InvalidCommitMessageError extends Data.TaggedError("InvalidCommitMessageError")<{}> {}

/** Every error `commitCmd` can produce. */
export type CommitError =
  | RepositoryNotFoundError
  | RepoStoreLoadError
  | PlatformError
  | ConfigDecodeError
  | ContributorIdRequiredError
  | InvalidCommitMessageError
  | UnsupportedWorkingTreeEntryError
  | InvalidPathError
  | ReplayError
  | WorkingTreeCleanError
  | RevisionOverflowError;

/**
 * §7.5's message rule: §4.2's grammar (`MessageSchema`: nonempty, no ASCII
 * control character other than tab/LF) plus §7.5's own "4096 bytes" cap,
 * measured in UTF-8 bytes. A generated `revert` message is explicitly
 * exempt from the cap (§4.2) but never flows through this function.
 */
function isValidCommitMessage(message: string): boolean {
  if (new TextEncoder().encode(message).length > COMMIT_MESSAGE_MAX_BYTES) {
    return false;
  }
  return Either.isRight(Schema.decodeUnknownEither(MessageSchema, { onExcessProperty: "error" })(message));
}

/**
 * Runs §7.5 from the process working directory. Returns the exact stdout
 * bytes: the repository's new full frontier as a canonical version, plus
 * LF.
 */
export function commitCmd(
  message: string,
): Effect.Effect<string, CommitError, FileSystem.FileSystem | ConfigService | RepoStore> {
  return Effect.gen(function* () {
    if (!isValidCommitMessage(message)) {
      return yield* Effect.fail(new InvalidCommitMessageError());
    }

    const repoRoot = yield* locateRepository(".");
    const config = yield* ConfigService;
    const author = yield* config.requireContributorId(repoRoot);
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);

    const scan = yield* scanWorkingTree(repoRoot);
    const unsupported = firstUnsupportedError(scan);
    if (unsupported !== undefined) {
      return yield* Effect.fail(unsupported);
    }

    const frontier = versionOfPairs(repository.frontier);
    const replayed = replay(frontier, repository.patches);
    if (Either.isLeft(replayed)) {
      return yield* Effect.fail(replayed.left);
    }

    if (isWorkingTreeClean(scan, replayed.right.tree)) {
      return yield* Effect.fail(new WorkingTreeCleanError());
    }

    const changes = authorChanges(replayed.right.tree, scan.tree);

    const nextRevision = checkedNextRevision(revisionOfVersionPairs(repository.frontier, author));
    if (Either.isLeft(nextRevision)) {
      return yield* Effect.fail(nextRevision.left);
    }

    const patch: Patch = {
      author,
      revision: nextRevision.right,
      base: repository.frontier,
      message,
      changes,
    };
    const nextRepository = repositoryAfterPatch(repository, patch);

    // §7.5: the command "writes the diff to disk" — install the authored
    // tree, then update repository.json (materialize-before-save, the same
    // order §7.8 names for merge/revert).
    yield* materialize(repoRoot, scan.tree);
    yield* store.save(repoRoot, nextRepository);

    return `${versionOfPairs(nextRepository.frontier).toCanonicalString()}\n`;
  });
}