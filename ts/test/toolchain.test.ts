import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import * as fc from "effect/FastCheck";

/**
 * Phase 0 toolchain smoke tests only (plan.md §6, Phase 0 exit criterion):
 * prove vitest + @effect/vitest + ESM + the project's `moduleResolution`
 * setting actually work end to end. No real snap logic exists yet.
 */

interface Greeter {
  readonly greet: () => string;
}
const Greeter = Context.GenericTag<Greeter>("Greeter");
const GreeterLive = Layer.succeed(Greeter, { greet: () => "hello" });

it.layer(GreeterLive)("it.layer smoke test", (it) => {
  it.effect("provides the Greeter service through a no-op Layer", () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter;
      expect(greeter.greet()).toBe("hello");
    }),
  );
});

it.prop("it.prop smoke test: identity round-trips any integer", { n: fc.integer() }, ({ n }) => {
  expect(n).toBe(n);
});
