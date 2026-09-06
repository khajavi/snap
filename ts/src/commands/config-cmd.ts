/**
 * `snap config [--global] contributor.id <id>` (SPEC.md §7.2, §8, plan.md
 * Phase 8): validate the ID, then write it to `$HOME/.snapconfig.json`
 * (`--global`, no repository needed) or to the nearest repository's
 * `.snap/config.json` (the default, via `locateRepository`).
 *
 * The grammar fixes the field name as the literal `contributor.id`, so
 * this module only receives the raw ID string; validation and the exact
 * written shape `{"contributor":{"id":"<id>"}}` both belong to
 * `config/config.ts`'s service (the same `parseContributorId` grammar
 * `decodeConfig` applies on the read side, so a written config always
 * reads back). "Preserves no unknown fields" (§7.2) falls out of that
 * service's write: it encodes only the new ID and never reads the
 * previous file's content — tests/25's config with an unknown extra field
 * is overwritten to exactly the two-field shape.
 *
 * Output is nothing: §7.2 prints nothing on success.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";
import { ConfigService, GlobalHomeUnavailableError } from "../config/config.js";
import type { InvalidContributorIdError } from "../domain/contributor.js";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";

/** Every error `configCmd` can produce. */
export type ConfigCommandError =
  | RepositoryNotFoundError
  | GlobalHomeUnavailableError
  | InvalidContributorIdError
  | PlatformError;

/**
 * Runs §7.2. Without `--global` the nearest repository is located first
 * (SPEC.md §7's commands intro: local repository operands resolve against
 * the process working directory), so `config` outside any repository
 * fails with "not a Snap repository" rather than writing anywhere. With
 * `--global` no repository is located — the grammar pins that this form
 * "needs no repository". Returns the exact stdout bytes: `""`.
 */
export function configCmd(
  global: boolean,
  id: string,
): Effect.Effect<string, ConfigCommandError, FileSystem.FileSystem | ConfigService> {
  return Effect.gen(function* () {
    const config = yield* ConfigService;
    if (global) {
      yield* config.writeGlobalContributorId(id);
      return "";
    }
    const repoRoot = yield* locateRepository(".");
    yield* config.writeLocalContributorId(repoRoot, id);
    return "";
  });
}
