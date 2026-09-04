/**
 * Local/global contributor configuration (SPEC.md §8, plan.md §2's
 * `config/config.ts` entry: "Local/global config service: load/validate/
 * write `.snap/config.json` and `$HOME/.snapconfig.json`, local-over-global
 * precedence, missing-identity error").
 *
 * SPEC.md §8, verbatim: "Configuration is ordinary UTF-8 JSON with exactly
 * this shape: `{"contributor":{"id":"alice@example.com"}}`. Snap reads and
 * validates local `.snap/config.json` first. If it provides an ID, Snap
 * does not read global configuration. Otherwise it reads
 * `$HOME/.snapconfig.json`. A missing file means no value; a malformed
 * file, non-unique or unknown field, or invalid ID in a file that is read
 * is an error. If `$HOME` is absent, global configuration is unavailable.
 * Only `commit` and `revert` author patches and therefore require an ID.
 * If it is missing they fail with: `snap: contributor.id is required;
 * configure it locally or globally`".
 *
 * This module splits along plan.md §1.1's pure-core/service-shell line even
 * though both halves live in one file (plan.md's tree lists a single
 * `config/config.ts`, not a directory):
 *
 *   - The pure core (`decodeConfig` and its helpers, including the
 *     hand-rolled JSON parser below) does no I/O and returns typed
 *     `Either` results, exactly like `domain/*.ts`'s parsers.
 *   - The service shell (`ConfigService`, a `Context.Tag`, and
 *     `ConfigServiceLive`, its `Layer`) is the only part that touches
 *     `@effect/platform`'s `FileSystem` service or `process.env.HOME`.
 *
 * Two design decisions worth calling out (see the report for the full
 * reasoning):
 *
 *   1. **"Object without `id`" ambiguity.** SPEC.md's precedence rule is
 *      framed as a boolean condition on the local file's content ("If it
 *      provides an ID ..."), not as "the file must always name an ID or
 *      else error." A `contributor` object present but missing `id` is
 *      therefore treated exactly like an absent `contributor` field:
 *      "does not provide an ID," which falls through to global
 *      configuration rather than erroring. `contributor` and `id` are
 *      both optional keys; when either is present, it must have the
 *      right shape, and no other key is tolerated at either level.
 *   2. **No atomic rename for config writes.** Unlike
 *      `.snap/repository.json` (`fs/atomic-write.ts`), SPEC.md never
 *      requires config writes to survive a torn write, and a half-written
 *      `.snap/config.json` is not the kind of corruption that can poison
 *      replay or causal history the way a half-written `repository.json`
 *      could. `writeLocalContributorId` therefore writes the file
 *      directly rather than via a temp-file-then-rename, keeping the
 *      write path simple.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Either, Layer, Option } from "effect";
import {
  InvalidContributorIdError,
  parseContributorId,
  type ContributorId,
} from "../domain/contributor.js";

// ---------------------------------------------------------------------------
// Value type
// ---------------------------------------------------------------------------

/**
 * The parsed, validated shape of one config file — SPEC.md §8's "exactly
 * this shape" JSON, decoded. `contributor` is `undefined` both when the
 * top-level `contributor` field is entirely absent and when it is present
 * but has no `id` (see the module doc comment's ambiguity note) — both
 * mean "this file does not provide an ID."
 */
export interface Config {
  readonly contributor: { readonly id: ContributorId } | undefined;
}

/** A `Config` with no contributor ID, used wherever a file omits one. */
const EMPTY_CONFIG: Config = { contributor: undefined };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One config file's raw text failed to decode: malformed JSON, a
 * duplicate object key, an unknown field, a wrongly-shaped `contributor`/
 * `id`, or an invalid contributor ID (SPEC.md §8: "a malformed file,
 * non-unique or unknown field, or invalid ID in a file that is read is an
 * error"). `detail` is the raw, unprefixed message — `tests/*.yaml` pins
 * `invalid JSON`, `duplicate JSON key "..."`, and `invalid contributor id:
 * ...` as substrings/patterns of the final rendered line, and per
 * `errors/domain-errors.ts`'s existing pattern (e.g. `SchemaValidationError`
 * carrying a raw formatted message), the `snap: ` prefix is left for the
 * CLI-error-rendering boundary (a later phase) to prepend, not added here.
 */
export class ConfigDecodeError extends Data.TaggedError("ConfigDecodeError")<{
  readonly detail: string;
}> {}

/**
 * SPEC.md §8: "Only `commit` and `revert` author patches and therefore
 * require an ID. If it is missing they fail with: `snap: contributor.id is
 * required; configure it locally or globally`". `requireContributorId`
 * raises this when neither local nor global configuration provides an ID;
 * `resolveContributorId` itself never raises it, since not every caller
 * (e.g. `status`) needs an ID at all.
 */
export class ContributorIdRequiredError extends Data.TaggedError("ContributorIdRequiredError")<{}> {}

/**
 * SPEC.md §8's exact required-identity detail text, unprefixed (see
 * `ConfigDecodeError`'s doc comment on the `snap: ` prefix convention).
 * The CLI-error-rendering boundary renders `ContributorIdRequiredError` as
 * `` `snap: ${CONTRIBUTOR_ID_REQUIRED_DETAIL}` ``, reproducing SPEC.md's
 * line verbatim.
 */
export const CONTRIBUTOR_ID_REQUIRED_DETAIL =
  "contributor.id is required; configure it locally or globally";

// ---------------------------------------------------------------------------
// Pure core — a duplicate-key-aware JSON parser
// ---------------------------------------------------------------------------

/**
 * The subset of JSON values this module's hand-rolled parser produces.
 * Plain `JSON.parse` cannot be used alone: it silently keeps only the last
 * occurrence of a repeated object key, so a config file with a duplicate
 * `"id"` key would decode successfully instead of failing SPEC.md §8's
 * "non-unique ... field" rule. This parser detects that case itself.
 */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** Internal control-flow error for both JSON syntax errors and duplicate keys. */
class JsonParseFailure extends Error {}

/**
 * Parses `text` as JSON, failing on any syntax error and, unlike
 * `JSON.parse`, on any object literal containing the same key twice
 * (regardless of whether the two occurrences have equal values — SPEC.md
 * §8 calls this "non-unique field", a textual property, not a semantic
 * one).
 */
function parseJsonNoDuplicateKeys(text: string): JsonValue {
  const state = { pos: 0 };

  const peek = (): string | undefined => text[state.pos];

  const fail = (message: string): never => {
    throw new JsonParseFailure(`${message} at position ${state.pos}`);
  };

  const skipWhitespace = (): void => {
    while (state.pos < text.length && (peek() === " " || peek() === "\t" || peek() === "\n" || peek() === "\r")) {
      state.pos++;
    }
  };

  const expect = (ch: string): void => {
    if (peek() !== ch) {
      fail(`expected "${ch}"`);
    }
    state.pos++;
  };

  const isDigit = (ch: string | undefined): ch is string => ch !== undefined && ch >= "0" && ch <= "9";

  const parseDigits = (): void => {
    if (!isDigit(peek())) {
      fail("expected a digit");
    }
    while (isDigit(peek())) {
      state.pos++;
    }
  };

  const parseString = (): string => {
    expect('"');
    let out = "";
    for (;;) {
      const ch = peek();
      if (ch === undefined) {
        fail("unterminated string");
      }
      if (ch === '"') {
        state.pos++;
        return out;
      }
      if (ch === "\\") {
        state.pos++;
        const esc = peek();
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(state.pos + 1, state.pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              fail("invalid unicode escape");
            }
            out += String.fromCharCode(parseInt(hex, 16));
            state.pos += 4;
            break;
          }
          default:
            fail(`invalid escape "\\${esc ?? ""}"`);
        }
        state.pos++;
        continue;
      }
      out += ch;
      state.pos++;
    }
  };

  const parseNumber = (): number => {
    const start = state.pos;
    if (peek() === "-") {
      state.pos++;
    }
    if (peek() === "0") {
      state.pos++;
    } else {
      parseDigits();
    }
    if (peek() === ".") {
      state.pos++;
      parseDigits();
    }
    if (peek() === "e" || peek() === "E") {
      state.pos++;
      if (peek() === "+" || peek() === "-") {
        state.pos++;
      }
      parseDigits();
    }
    return Number(text.slice(start, state.pos));
  };

  const parseArray = (): ReadonlyArray<JsonValue> => {
    expect("[");
    const result: JsonValue[] = [];
    skipWhitespace();
    if (peek() === "]") {
      state.pos++;
      return result;
    }
    for (;;) {
      result.push(parseValue());
      skipWhitespace();
      const next = peek();
      if (next === ",") {
        state.pos++;
        skipWhitespace();
        continue;
      }
      if (next === "]") {
        state.pos++;
        return result;
      }
      fail('expected "," or "]"');
    }
  };

  const parseObject = (): { readonly [key: string]: JsonValue } => {
    expect("{");
    const result: { [key: string]: JsonValue } = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (peek() === "}") {
      state.pos++;
      return result;
    }
    for (;;) {
      skipWhitespace();
      if (peek() !== '"') {
        fail("expected string key");
      }
      const key = parseString();
      if (seen.has(key)) {
        throw new JsonParseFailure(`duplicate JSON key "${key}"`);
      }
      seen.add(key);
      skipWhitespace();
      expect(":");
      skipWhitespace();
      result[key] = parseValue();
      skipWhitespace();
      const next = peek();
      if (next === ",") {
        state.pos++;
        continue;
      }
      if (next === "}") {
        state.pos++;
        return result;
      }
      fail('expected "," or "}"');
    }
  };

  const parseValue = (): JsonValue => {
    skipWhitespace();
    const ch = peek();
    if (ch === undefined) {
      fail("unexpected end of input");
    }
    if (ch === "{") {
      return parseObject();
    }
    if (ch === "[") {
      return parseArray();
    }
    if (ch === '"') {
      return parseString();
    }
    if (ch === "-" || isDigit(ch)) {
      return parseNumber();
    }
    if (text.startsWith("true", state.pos)) {
      state.pos += 4;
      return true;
    }
    if (text.startsWith("false", state.pos)) {
      state.pos += 5;
      return false;
    }
    if (text.startsWith("null", state.pos)) {
      state.pos += 4;
      return null;
    }
    return fail(`unexpected character "${ch}"`);
  };

  const value = parseValue();
  skipWhitespace();
  if (state.pos !== text.length) {
    fail("unexpected trailing content");
  }
  return value;
}

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Pure core — decode/validate
// ---------------------------------------------------------------------------

/**
 * Decodes and validates one config file's raw text against SPEC.md §8's
 * exact shape: a top-level JSON object with only an optional `contributor`
 * field, itself a JSON object with only an optional `id` string field.
 * Malformed JSON, a duplicate key anywhere, an unknown field at either
 * level, a wrongly-typed `contributor`/`id`, or an `id` that fails
 * `domain/contributor.ts`'s `parseContributorId` grammar are all
 * `ConfigDecodeError`s. An absent `contributor` field and a `contributor`
 * object present without `id` both decode successfully to
 * `{ contributor: undefined }` (see the module doc comment's ambiguity
 * note) — neither is an error.
 */
export function decodeConfig(text: string): Either.Either<Config, ConfigDecodeError> {
  let parsed: JsonValue;
  try {
    parsed = parseJsonNoDuplicateKeys(text);
  } catch (error) {
    if (error instanceof JsonParseFailure) {
      const detail = error.message.startsWith("duplicate JSON key")
        ? error.message
        : `invalid JSON: ${error.message}`;
      return Either.left(new ConfigDecodeError({ detail }));
    }
    throw error;
  }

  if (!isJsonObject(parsed)) {
    return Either.left(new ConfigDecodeError({ detail: "config must be a JSON object" }));
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "contributor") {
      return Either.left(new ConfigDecodeError({ detail: `config has unknown field: ${key}` }));
    }
  }

  const contributorRaw = parsed["contributor"];
  if (contributorRaw === undefined) {
    return Either.right(EMPTY_CONFIG);
  }
  if (!isJsonObject(contributorRaw)) {
    return Either.left(new ConfigDecodeError({ detail: "config field contributor must be an object" }));
  }
  for (const key of Object.keys(contributorRaw)) {
    if (key !== "id") {
      return Either.left(new ConfigDecodeError({ detail: `config has unknown field: contributor.${key}` }));
    }
  }

  const idRaw = contributorRaw["id"];
  if (idRaw === undefined) {
    return Either.right(EMPTY_CONFIG);
  }
  if (typeof idRaw !== "string") {
    return Either.left(new ConfigDecodeError({ detail: "config field contributor.id must be a string" }));
  }

  const parsedId = parseContributorId(idRaw);
  if (Either.isLeft(parsedId)) {
    return Either.left(
      new ConfigDecodeError({ detail: `invalid contributor id: ${parsedId.left.reason}` }),
    );
  }
  return Either.right({ contributor: { id: parsedId.right } });
}

/** Serializes a `Config` back to SPEC.md §8's exact JSON shape. */
function encodeConfig(config: Config): string {
  return config.contributor === undefined
    ? JSON.stringify({})
    : JSON.stringify({ contributor: { id: config.contributor.id } });
}

// ---------------------------------------------------------------------------
// Service shell
// ---------------------------------------------------------------------------

const LOCAL_CONFIG_RELATIVE_PATH = ".snap/config.json";
const GLOBAL_CONFIG_FILE_NAME = ".snapconfig.json";

export class ConfigService extends Context.Tag("snap/ConfigService")<
  ConfigService,
  {
    /**
     * Resolves the effective contributor ID for the repository rooted at
     * `repoRoot`, per SPEC.md §8's local-over-global precedence: local
     * `.snap/config.json` is read first; if it provides an ID, global
     * configuration is never consulted. Otherwise `$HOME/.snapconfig.json`
     * is read (if `$HOME` is unset or empty, global configuration is
     * simply unavailable — `Option.none()` from that branch, not an
     * error). A missing file (local or global) means no value from that
     * file, not an error; a file that exists but fails `decodeConfig`
     * fails this Effect. Neither file providing an ID is not itself an
     * error at this layer — it resolves to `Option.none()`, since not
     * every command (e.g. `status`) requires an ID.
     */
    readonly resolveContributorId: (
      repoRoot: string,
    ) => Effect.Effect<Option.Option<ContributorId>, PlatformError | ConfigDecodeError>;

    /**
     * `resolveContributorId`, but fails with `ContributorIdRequiredError`
     * when neither local nor global configuration provides an ID — the
     * exact failure `commit`/`revert` need per SPEC.md §8.
     */
    readonly requireContributorId: (
      repoRoot: string,
    ) => Effect.Effect<ContributorId, PlatformError | ConfigDecodeError | ContributorIdRequiredError>;

    /**
     * Validates `rawId` via `domain/contributor.ts`'s `parseContributorId`
     * (the same grammar `decodeConfig` applies to an `id` read from a
     * file) and, on success, writes `.snap/config.json` under `repoRoot`
     * as `{"contributor":{"id":"<rawId>"}}`, replacing any previous
     * content — this command always writes a config recording only the
     * new ID, so a malformed or unknown-field previous file is never read
     * or validated by a write.
     */
    readonly writeLocalContributorId: (
      repoRoot: string,
      rawId: string,
    ) => Effect.Effect<void, InvalidContributorIdError | PlatformError>;
  }
>() {}

/** Reads and decodes one config file, or `Option.none()` if it does not exist. */
const readConfigFile = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<Config>, PlatformError | ConfigDecodeError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(path);
    if (!exists) {
      return Option.none();
    }
    const text = yield* fs.readFileString(path);
    const decoded = decodeConfig(text);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(decoded.left);
    }
    return Option.some(decoded.right);
  });

/** The contributor ID a decoded `Config` provides, if any. */
const idOf = (config: Config): Option.Option<ContributorId> => Option.fromNullable(config.contributor?.id);

/** `@effect/platform`-backed `ConfigService` implementation (plan.md §1.1's service shell). */
export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const resolveContributorId = (
      repoRoot: string,
    ): Effect.Effect<Option.Option<ContributorId>, PlatformError | ConfigDecodeError> =>
      Effect.gen(function* () {
        const localConfig = yield* readConfigFile(fs, `${repoRoot}/${LOCAL_CONFIG_RELATIVE_PATH}`);
        const localId = Option.flatMap(localConfig, idOf);
        if (Option.isSome(localId)) {
          return localId;
        }

        // SPEC.md §8: "If `$HOME` is absent, global configuration is
        // unavailable." An empty string is treated the same as unset.
        const home = process.env["HOME"];
        if (home === undefined || home === "") {
          return Option.none();
        }

        const globalConfig = yield* readConfigFile(fs, `${home}/${GLOBAL_CONFIG_FILE_NAME}`);
        return Option.flatMap(globalConfig, idOf);
      });

    const requireContributorId = (
      repoRoot: string,
    ): Effect.Effect<ContributorId, PlatformError | ConfigDecodeError | ContributorIdRequiredError> =>
      Effect.gen(function* () {
        const id = yield* resolveContributorId(repoRoot);
        return yield* Option.match(id, {
          onNone: () => Effect.fail(new ContributorIdRequiredError()),
          onSome: (value) => Effect.succeed(value),
        });
      });

    const writeLocalContributorId = (
      repoRoot: string,
      rawId: string,
    ): Effect.Effect<void, InvalidContributorIdError | PlatformError> =>
      Effect.gen(function* () {
        const parsedId = parseContributorId(rawId);
        if (Either.isLeft(parsedId)) {
          return yield* Effect.fail(parsedId.left);
        }
        const localDir = `${repoRoot}/.snap`;
        yield* fs.makeDirectory(localDir, { recursive: true });
        yield* fs.writeFileString(
          `${repoRoot}/${LOCAL_CONFIG_RELATIVE_PATH}`,
          encodeConfig({ contributor: { id: parsedId.right } }),
        );
      });

    return { resolveContributorId, requireContributorId, writeLocalContributorId };
  }),
);
