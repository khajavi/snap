/**
 * `snap --serve [port]`'s Phase 8 slice (SPEC.md §7.9, plan.md Phase 8):
 * port-number validation only.
 *
 * §7.9: "`--serve` starts the HTTP server on `port`. The port defaults to
 * 8765. A valid port is a plain decimal integer between 0 and 65535.
 * Leading zeroes are invalid. ... An invalid port ... is an error."
 *
 * Serving itself (the HTTP `GET /repository.json` handler, the start/stop
 * protocol tests/13 and /26 drive) is Phase 10's `http/serve.ts`; this
 * module owns just the two pinned-by-tests/14 behaviors every phase
 * needs: the port grammar and its exact error text
 * (`snap: invalid port: <n>`, pinned for `--serve 65536`). The dispatch
 * layer keeps phasing the actual server out with its
 * `CommandNotImplementedError` until Phase 10, so argv-level port errors
 * behave identically today and after that phase.
 *
 * Pure: given the raw operand string (or `undefined` for the default),
 * returns the validated port number or the typed error — no services.
 */

import { Data, Effect, Either } from "effect";
import { fromEither } from "../cli/from-either.js";

/** §7.9's exact invalid-port detail text, rendered as `invalid port: <port>`. */
export const INVALID_PORT_DETAIL_PREFIX = "invalid port";

/** §7.9: the port defaults to 8765. */
export const DEFAULT_SERVE_PORT = "8765";

/** §7.9: a port is a plain decimal integer between 0 and 65535, no leading zeroes. */
export const MAX_PORT = 65535;

/**
 * §7.9: an invalid port operand. `port` carries the raw user-supplied text
 * so the rendered detail reproduces what the user actually wrote
 * (`invalid port: 65536`, tests/14). Unreachable for the `undefined`
 * default operand, which always yields the structurally valid `8765`.
 */
export class InvalidPortError extends Data.TaggedError("InvalidPortError")<{
  readonly port: string;
}> {}

/** True iff `text` is a canonical port literal: ASCII digits, no leading zero (except `"0"` itself). */
export function isPortLiteral(text: string): boolean {
  if (!/^[0-9]+$/.test(text)) {
    return false;
  }
  // §7.9: "Leading zeroes are invalid." `0` itself is the single valid
  // zero-spelled port; any longer number may not start with a zero digit.
  return text.length === 1 || !text.startsWith("0");
}

/**
 * Parses `input` (the raw `--serve` operand, or `undefined` for the
 * default) per §7.9: grammatical first, then the 0..65535 range. Either
 * the validated port number or `InvalidPortError` carrying the user's raw
 * text.
 */
export function parseServePort(input: string | undefined): Either.Either<number, InvalidPortError> {
  const raw = input ?? DEFAULT_SERVE_PORT;
  if (!isPortLiteral(raw) || Number(raw) > MAX_PORT) {
    return Either.left(new InvalidPortError({ port: raw }));
  }
  return Either.right(Number(raw));
}

/**
 * The Phase 8 command module: validate only. Returns the validated port
 * number (so the caller can act on it once Phase 10's server lands); every
 * call reaching the dispatch layer currently ends in the serve command's
 * not-implemented error after this succeeds.
 */
export function serveCmd(input: string | undefined): Effect.Effect<number, InvalidPortError> {
  return fromEither(parseServePort(input));
}