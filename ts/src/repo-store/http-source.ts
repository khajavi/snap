/**
 * HTTP repository source (SPEC.md §9, plan.md Phase 10): loading a
 * repository operand that starts with `http://` or `https://`.
 *
 * §9's contract, in its own words:
 *
 *   - "Snap performs one GET of that exact URL" — exactly one request,
 *     no probing, no retries;
 *   - "requires status 200" — anything else fails (the detail is
 *     `HTTP <status>`, pinning tests/13's `HTTP 302` for the
 *     redirected-URL case — Node's `fetch` follows redirects, but the
 *     *response* reported here is the final one's status, and a redirect
 *     chain still yields the non-200 end status; the exact-URL rule means
 *     no `location` chasing is performed by Snap itself);
 *   - "parses the body as a repository value, and validates it
 *     normally" — the same `parseRepositoryJson` + `decodeRepository` +
 *     six-point `validateRepository` pipeline as the on-disk store, so a
 *     malformed remote is exactly as rejected as a malformed local file
 *     (tests/26's malformed-HTTP cases share `*remote_failure` with the
 *     local-path ones);
 *   - "HTTP is read-only" — the result is only ever replayed/joined;
 *     nothing in this module (or its callers) writes.
 *
 * The error detail texts the suite pins:
 *   - tests/13: `HTTP 302` (stderr_contains) for the redirect route, and
 *     `invalid JSON` for the not-json route — the latter comes from
 *     `parseRepositoryJson`'s existing `invalid JSON: <reason>` detail.
 *   - tests/26: any `snap: <detail>` line (stderr_matches `.+`), so the
 *     validation errors flow through unchanged.
 *
 * Fetch happens at the Effect boundary (`Effect.tryPromise`); everything
 * else is the pure parse/validate pipeline `repo-store/store.ts` already
 * owns, reused here so the two sources cannot drift.
 */

import { Data, Effect, Either } from "effect";
import type { PlatformError } from "@effect/platform/Error";
import {
  parseRepositoryJsonEncoded,
  type RepositoryJsonSyntaxError,
} from "./store.js";
import { validateRepository, type RepositoryValidationError } from "../replay/validate.js";
import type { Repository } from "../domain/repository.js";

/** §9: the operand must start with `http://` or `https://`. */
export function isHttpOperand(operand: string): boolean {
  return operand.startsWith("http://") || operand.startsWith("https://");
}

/** §9's failure for a non-200 response, detail `HTTP <status>`. */
export class HttpRepositoryStatusError extends Data.TaggedError("HttpRepositoryStatusError")<{
  readonly status: number;
}> {}

/** The failure union `loadHttpRepository` can produce. */
export type HttpRepositoryLoadError =
  | HttpRepositoryStatusError
  | RepositoryJsonSyntaxError
  | RepositoryValidationError
  | PlatformError;

/**
 * Performs §9's one exact-URL GET and validates the body through the
 * standard repository pipeline. One request, status 200 required, no
 * redirects followed by Snap itself, no authentication or caching.
 */
export function loadHttpRepository(urlText: string): Effect.Effect<Repository, HttpRepositoryLoadError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(urlText, { method: "GET", redirect: "manual", signal }),
      catch: (error) => error as PlatformError,
    });
    if (response.status !== 200) {
      return yield* Effect.fail(new HttpRepositoryStatusError({ status: response.status }));
    }
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => error as PlatformError,
    });
    const parsed = parseRepositoryJsonEncoded(text);
    if (Either.isLeft(parsed)) {
      return yield* Effect.fail(parsed.left);
    }
    const validated = validateRepository(parsed.right);
    if (Either.isLeft(validated)) {
      return yield* Effect.fail(validated.left);
    }
    return validated.right;
  });
}
