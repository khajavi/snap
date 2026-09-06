/**
 * `Either.Either` → `Effect.Effect` (this Effect version has no
 * `Effect.fromEither`): the one-line adapter `parseArgs` and `serveCmd`
 * use to lift a pure either-valued parser into the failure channel a
 * command module (or `main.ts`) can `yield*`/`catchAll`.
 */

import { Either, Effect } from "effect";

/** Lifts a pure `Either` into the corresponding success/failure Effect. */
export function fromEither<A, E>(either: Either.Either<A, E>): Effect.Effect<A, E> {
  return Either.match(either, { onLeft: Effect.fail, onRight: Effect.succeed });
}