/**
 * Repository load/validate/save (SPEC.md §4.1), plus the one canonical
 * repository-JSON encode function that `http/serve.ts` (a later phase)
 * will reuse verbatim for the `--serve` HTTP body — see this module's
 * `encodeRepository` export and plan.md §2's `repo-store/store.ts` entry:
 * "Owns the one canonical repository-JSON encode function (key order,
 * indentation) also reused by `http/serve.ts`, so the on-disk file and
 * the `--serve` HTTP body can never independently drift from each
 * other's byte layout."
 *
 * This module splits along plan.md §1.1's pure-core/service-shell line
 * even though both halves live in one file, exactly like
 * `config/config.ts`:
 *
 *   - The pure core (`encodeRepository` and the duplicate-key-aware JSON
 *     parser it shares with decoding) does no I/O.
 *   - The service shell (`RepoStore`, a `Context.Tag`, and
 *     `RepoStoreLive`, its `Layer`) is the only part that touches
 *     `@effect/platform`'s `FileSystem` service.
 *
 * `encodeRepository` is deliberately exported standalone — a pure
 * function of a `Repository` value, no `FileSystem` dependency — rather
 * than buried inside `RepoStore`'s `save` method, so `http/serve.ts` can
 * call it directly without needing a `FileSystem` in scope.
 *
 * SPEC.md §4.1: "Readers accept ordinary JSON whitespace and object-key
 * order. Valid input has unique object keys." That reads as a property of
 * *valid* input, not by itself a rejection rule for readers — but
 * `tests/15-repository-validation.yaml` pins the opposite: a
 * `repository.json` with a duplicate top-level key (`{"format":1,"format":1,...}`)
 * must be rejected with a message containing `"duplicate JSON key"`, the
 * same text `config/config.ts`'s hand-rolled parser produces for §8's
 * config files. Plain `JSON.parse` cannot detect this (it silently keeps
 * only the last occurrence of a repeated key), so `load` below parses
 * through a hand-rolled duplicate-key-aware JSON parser mirroring
 * `config/config.ts`'s (duplicated here rather than imported, since
 * `config/config.ts` does not export it and this phase does not touch
 * other `src/` modules) before handing the result to
 * `replay/validate.ts`'s `validateRepository`.
 */

import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Data, Effect, Either, Layer } from "effect";
import type { Change, Patch, PatchEditOp, VersionPairs } from "../domain/patch.js";
import type { Repository } from "../domain/repository.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { validateRepository, type RepositoryValidationError } from "../replay/validate.js";

/** Path to the repository file, relative to a repository root. */
const REPOSITORY_RELATIVE_PATH = ".snap/repository.json";

// ---------------------------------------------------------------------------
// Pure core — a duplicate-key-aware JSON parser (mirrors `config/config.ts`)
// ---------------------------------------------------------------------------

/**
 * The subset of JSON values this module's hand-rolled parser produces —
 * exactly `config/config.ts`'s `JsonValue`, redefined here since that
 * module does not export it.
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
 * (regardless of whether the two occurrences have equal values) —
 * `tests/15-repository-validation.yaml` pins this exact behavior for
 * `repository.json`, the same "non-unique field" property SPEC.md §8
 * calls out for config files.
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

/**
 * A repository file's raw text failed to parse as JSON at all: a syntax
 * error or a duplicate object key (SPEC.md §4.1's reader contract, as
 * pinned by `tests/15-repository-validation.yaml`). This is distinct from
 * `replay/validate.ts`'s `RepositoryValidationError` union, which only
 * ever sees an already-parsed JSON value — a `RepositoryJsonSyntaxError`
 * means the text never became a JSON value in the first place. `detail`
 * is the raw, unprefixed message, following `config/config.ts`'s
 * `ConfigDecodeError` convention (the `snap: ` prefix is added at the
 * CLI-error-rendering boundary, a later phase).
 */
export class RepositoryJsonSyntaxError extends Data.TaggedError("RepositoryJsonSyntaxError")<{
  readonly detail: string;
}> {}

/**
 * Parses `text` via `parseJsonNoDuplicateKeys`, mapping any parse failure
 * to `RepositoryJsonSyntaxError`.
 */
function parseRepositoryJson(text: string): Either.Either<JsonValue, RepositoryJsonSyntaxError> {
  try {
    return Either.right(parseJsonNoDuplicateKeys(text));
  } catch (error) {
    if (error instanceof JsonParseFailure) {
      const detail = error.message.startsWith("duplicate JSON key")
        ? error.message
        : `invalid JSON: ${error.message}`;
      return Either.left(new RepositoryJsonSyntaxError({ detail }));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pure core — the one canonical encode function (SPEC.md §4.1)
// ---------------------------------------------------------------------------

/** Encodes one edit-script operation back to its one-key JSON shape (SPEC.md §4.4). */
function encodeEditOp(op: PatchEditOp): unknown {
  if ("retain" in op) {
    return { retain: op.retain };
  }
  if ("delete" in op) {
    return { delete: op.delete };
  }
  return { insert: op.insert };
}

/**
 * Encodes one change back to its variant's JSON shape (SPEC.md §4.3), key
 * order `type`, `path`, then the variant's own field — matching SPEC
 * §4.1's worked example (`{"type":"text","path":"hello.txt","edit":[...]}`).
 */
function encodeChange(change: Change): unknown {
  switch (change.type) {
    case "text":
      return { type: "text", path: change.path, edit: change.edit.map(encodeEditOp) };
    case "put":
      return { type: "put", path: change.path, content: change.content };
    case "delete":
      return { type: "delete", path: change.path };
  }
}

/** Encodes a version-JSON `[id, revision]` pair array as-is — already the right shape. */
function encodeVersionPairs(pairs: VersionPairs): unknown {
  return pairs.map(([author, revision]) => [author, revision]);
}

/**
 * Encodes one patch back to JSON, key order `author`, `revision`, `base`,
 * `message`, `changes` — matching SPEC §4.1's worked example exactly.
 */
function encodePatch(patch: Patch): unknown {
  return {
    author: patch.author,
    revision: patch.revision,
    base: encodeVersionPairs(patch.base),
    message: patch.message,
    changes: patch.changes.map(encodeChange),
  };
}

/**
 * The one canonical repository-JSON encode function (plan.md §2/§3):
 * produces `{"format":1,"frontier":[...],"patches":[...]}` with keys in
 * exactly that order at the top level, and the key orders above for every
 * nested patch/change, two-space indentation, and a trailing LF (SPEC.md
 * §4.1: "Writers SHOULD use two-space indentation and a trailing LF").
 * Pure — no I/O — so `http/serve.ts` (a later phase) can reuse it
 * verbatim for the `--serve` HTTP body. Locked down byte-for-byte by this
 * module's test file's golden-byte test rather than trusted to
 * `Schema.encode`'s default field order (plan.md §3's Schema bullet).
 */
export function encodeRepository(repository: Repository): string {
  const value = {
    format: repository.format,
    frontier: encodeVersionPairs(repository.frontier),
    patches: repository.patches.map(encodePatch),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Service shell
// ---------------------------------------------------------------------------

/** The union of every error `RepoStore#load` can produce. */
export type RepoStoreLoadError = PlatformError | RepositoryJsonSyntaxError | RepositoryValidationError;

export class RepoStore extends Context.Tag("snap/RepoStore")<
  RepoStore,
  {
    /**
     * Reads `<repoRoot>/.snap/repository.json`, parses it via a
     * duplicate-key-aware JSON parser, and runs the result through
     * `replay/validate.ts`'s full six-point `validateRepository`
     * pipeline (which itself starts with `domain/repository.ts`'s
     * `decodeRepository`), returning the validated `Repository` value or
     * a typed error naming exactly what went wrong.
     */
    readonly load: (repoRoot: string) => Effect.Effect<Repository, RepoStoreLoadError>;

    /**
     * Encodes `repository` via `encodeRepository` and writes it to
     * `<repoRoot>/.snap/repository.json` through `fs/atomic-write.ts`'s
     * `atomicWriteFile`, so a reader never observes a half-written file.
     */
    readonly save: (repoRoot: string, repository: Repository) => Effect.Effect<void, PlatformError>;
  }
>() {}

/** `@effect/platform`-backed `RepoStore` implementation. */
export const RepoStoreLive = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const load = (repoRoot: string): Effect.Effect<Repository, RepoStoreLoadError> =>
      Effect.gen(function* () {
        const text = yield* fs.readFileString(`${repoRoot}/${REPOSITORY_RELATIVE_PATH}`);
        const parsed = parseRepositoryJson(text);
        if (Either.isLeft(parsed)) {
          return yield* Effect.fail(parsed.left);
        }
        const validated = validateRepository(parsed.right);
        if (Either.isLeft(validated)) {
          return yield* Effect.fail(validated.left);
        }
        return validated.right;
      });

    const save = (repoRoot: string, repository: Repository): Effect.Effect<void, PlatformError> =>
      atomicWriteFile(`${repoRoot}/${REPOSITORY_RELATIVE_PATH}`, encodeRepository(repository)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    return { load, save };
  }),
);
