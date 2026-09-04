import { describe, expect, it } from "vitest";
import { Either } from "effect";
import type { ContributorId } from "../../src/domain/contributor.js";
import {
  ChangesSchema,
  EditScriptSchema,
  MessageSchema,
  computePatchResult,
  decodePatch,
  dotOf,
  expectedRevisionFor,
  revisionOfVersionPairs,
  VersionPairsSchema,
  Base64ContentSchema,
  type Patch,
} from "../../src/domain/patch.js";
import { Schema } from "effect";

// Fixtures drawn from SPEC.md §4.1's worked repository example, §4.2-§4.4's
// prose rules, and the literal failing cases in tests/15-repository-
// validation.yaml and tests/23-strict-validation-matrix.yaml (grepped by
// content, not guessed by filename).

const SPEC_EXAMPLE_PATCH = {
  author: "alice@example.com",
  revision: 1,
  base: [],
  message: "add greeting",
  changes: [{ type: "text", path: "hello.txt", edit: [{ insert: ["hello\n"] }] }],
};

describe("decodePatch: SPEC.md §4.1's worked example", () => {
  it("decodes the exact JSON from SPEC.md §4.1", () => {
    const result = decodePatch(SPEC_EXAMPLE_PATCH);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.author).toBe("alice@example.com");
      expect(result.right.revision).toBe(1);
      expect(result.right.base).toEqual([]);
      expect(result.right.message).toBe("add greeting");
      expect(result.right.changes).toEqual([
        { type: "text", path: "hello.txt", edit: [{ insert: ["hello\n"] }] },
      ]);
    }
  });
});

describe("decodePatch: rejects unknown fields at every nesting level (tests/23-strict-validation-matrix.yaml)", () => {
  it("rejects an unknown top-level patch field", () => {
    const result = decodePatch({ ...SPEC_EXAMPLE_PATCH, unknown: true });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects an unknown field on a change object ('change field' case)", () => {
    const result = decodePatch({
      author: "a@x",
      revision: 1,
      base: [],
      message: "change field",
      changes: [{ type: "put", path: "f", content: "YQ==", extra: 1 }],
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("decodePatch: revision and base grammar", () => {
  it("rejects a non-integer revision ('fraction' case)", () => {
    const result = decodePatch({
      author: "a@x",
      revision: 1.5,
      base: [],
      message: "fraction",
      changes: [{ type: "text", path: "f", edit: [] }],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects revision 0 (not positive)", () => {
    const result = decodePatch({ ...SPEC_EXAMPLE_PATCH, revision: 0 });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a base with an invalid contributor id", () => {
    const result = decodePatch({ ...SPEC_EXAMPLE_PATCH, base: [["not-an-email", 1]] });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a base out of canonical (sorted, unique-author) order", () => {
    const result = decodePatch({
      ...SPEC_EXAMPLE_PATCH,
      base: [
        ["b@x", 1],
        ["a@x", 1],
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a base with a duplicate author", () => {
    const result = decodePatch({
      ...SPEC_EXAMPLE_PATCH,
      base: [
        ["a@x", 1],
        ["a@x", 2],
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("accepts a base with several contributors in canonical order", () => {
    const result = decodePatch({
      ...SPEC_EXAMPLE_PATCH,
      base: [
        ["a@x", 3],
        ["b@x", 1],
      ],
    });
    expect(Either.isRight(result)).toBe(true);
  });
});

describe("decodePatch: path grammar and rejects invalid change paths", () => {
  it("rejects a change path with first segment '.snap' ('bad path' case)", () => {
    const result = decodePatch({
      author: "a@x",
      revision: 1,
      base: [],
      message: "bad path",
      changes: [{ type: "put", path: ".snap/secret", content: "YQ==" }],
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("MessageSchema: SPEC.md §4.2's message grammar", () => {
  const valid = ["add greeting", "a\tb", "a\nb", "  leading and trailing spaces  ", "unicode café"];
  it.each(valid)("accepts %j", (message) => {
    expect(Either.isRight(Schema.decodeUnknownEither(MessageSchema)(message))).toBe(true);
  });

  it("rejects the empty string ('message is empty' case)", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(MessageSchema)(""))).toBe(true);
  });

  it.each([
    ["a\u0000b", "NUL"],
    ["a\u0001b", "SOH"],
    ["a\u007fb", "DEL"],
    ["a\rb", "carriage return"],
  ])("rejects a message containing %j (%s)", (message) => {
    expect(Either.isLeft(Schema.decodeUnknownEither(MessageSchema)(message))).toBe(true);
  });

  it("does NOT enforce a 4096-byte cap here (that's a snap-commit CLI concern, per SPEC.md §4.2)", () => {
    const longMessage = "a".repeat(5000);
    expect(Either.isRight(Schema.decodeUnknownEither(MessageSchema)(longMessage))).toBe(true);
  });
});

describe("Base64ContentSchema: SPEC.md §4.3's 'standard padded RFC 4648 base64'", () => {
  it.each(["YQ==", "YWI=", "YWJj", "", "AAEC"])("accepts %j", (content) => {
    expect(Either.isRight(Schema.decodeUnknownEither(Base64ContentSchema)(content))).toBe(true);
  });

  it("rejects unpadded/malformed base64 ('bad bytes' case: content 'abc')", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Base64ContentSchema)("abc"))).toBe(true);
  });

  it("rejects characters outside the base64 alphabet", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Base64ContentSchema)("YQ==!"))).toBe(true);
  });
});

describe("EditScriptSchema: SPEC.md §4.4's edit-script structural rules", () => {
  it("accepts the empty script (valid only for creating an empty text file, per §4.3 — checked elsewhere)", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(EditScriptSchema)([]))).toBe(true);
  });

  it("accepts a script with retain/delete/insert alternating", () => {
    const script = [{ retain: 1 }, { delete: 1 }, { insert: ["x\n"] }];
    expect(Either.isRight(Schema.decodeUnknownEither(EditScriptSchema)(script))).toBe(true);
  });

  it("rejects an operation with more than one key ('bad op' case: {retain:1,delete:1})", () => {
    // Excess-property rejection is a per-call `ParseOptions`, not a schema
    // default (SPEC.md §4.5 point 1's "unknown fields ... are errors" is
    // enforced by `decodePatch`/`decodeRepository` passing
    // `{onExcessProperty:"error"}` — exercised end to end below).
    const script = [{ retain: 1, delete: 1 }];
    expect(
      Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema, { onExcessProperty: "error" })(script)),
    ).toBe(true);
  });

  it("rejects a non-positive count ('bad count' case: retain 0)", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)([{ retain: 0 }]))).toBe(true);
  });

  it("rejects a negative count", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)([{ delete: -1 }]))).toBe(true);
  });

  it("rejects a non-integer count", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)([{ retain: 1.5 }]))).toBe(true);
  });

  it("rejects an empty insert ('empty insert' case)", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)([{ insert: [] }]))).toBe(true);
  });

  it("rejects an insert containing an empty token", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)([{ insert: [""] }]))).toBe(true);
  });

  it("rejects two adjacent operations of the same kind ('adjacent insert' case)", () => {
    const script = [{ insert: ["a\n"] }, { insert: ["b\n"] }];
    expect(Either.isLeft(Schema.decodeUnknownEither(EditScriptSchema)(script))).toBe(true);
  });

  it("accepts coalesced adjacent inserts as one operation (the canonical form diffTokens produces)", () => {
    const script = [{ insert: ["a\n", "b\n"] }];
    expect(Either.isRight(Schema.decodeUnknownEither(EditScriptSchema)(script))).toBe(true);
  });
});

describe("ChangesSchema: SPEC.md §4.2's changes-array invariants", () => {
  it("rejects an empty changes array ('changes is empty' case)", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(ChangesSchema)([]))).toBe(true);
  });

  it("accepts changes already sorted by path", () => {
    const changes = [
      { type: "put", path: "a", content: "" },
      { type: "put", path: "b", content: "" },
    ];
    expect(Either.isRight(Schema.decodeUnknownEither(ChangesSchema)(changes))).toBe(true);
  });

  it("rejects changes out of path order", () => {
    const changes = [
      { type: "put", path: "b", content: "" },
      { type: "put", path: "a", content: "" },
    ];
    expect(Either.isLeft(Schema.decodeUnknownEither(ChangesSchema)(changes))).toBe(true);
  });

  it("rejects two changes for the same path", () => {
    const changes = [
      { type: "put", path: "a", content: "" },
      { type: "delete", path: "a" },
    ];
    expect(Either.isLeft(Schema.decodeUnknownEither(ChangesSchema)(changes))).toBe(true);
  });

  it("rejects a prefix conflict between two creating changes ('tree paths conflict' case: 'a' and 'a/b')", () => {
    const changes = [
      { type: "put", path: "a", content: "YQ==" },
      { type: "put", path: "a/b", content: "Yg==" },
    ];
    expect(Either.isLeft(Schema.decodeUnknownEither(ChangesSchema)(changes))).toBe(true);
  });

  it("does not flag a delete alongside a create under its own former path as a prefix conflict", () => {
    // delete "a" (making it absent) alongside creating "a/b" is not a
    // *structural* conflict — see patch.ts's isPrefixFreeChanges comment.
    const changes = [
      { type: "delete", path: "a" },
      { type: "put", path: "a/b", content: "Yg==" },
    ];
    expect(Either.isRight(Schema.decodeUnknownEither(ChangesSchema)(changes))).toBe(true);
  });
});

describe("decodePatch: full patches combining the JSON shapes above", () => {
  const decodeOrThrow = (input: unknown): Patch => {
    const result = decodePatch(input);
    if (Either.isLeft(result)) {
      throw new Error(`expected a valid patch, got: ${result.left.message}`);
    }
    return result.right;
  };

  it("decodes a put creation", () => {
    const patch = decodeOrThrow({
      author: "a@x",
      revision: 1,
      base: [],
      message: "put",
      changes: [{ type: "put", path: "image.bin", content: "AAEC" }],
    });
    expect(patch.changes).toEqual([{ type: "put", path: "image.bin", content: "AAEC" }]);
  });

  it("decodes a delete", () => {
    const patch = decodeOrThrow({
      author: "a@x",
      revision: 2,
      base: [["a@x", 1]],
      message: "remove",
      changes: [{ type: "delete", path: "obsolete.txt" }],
    });
    expect(patch.changes).toEqual([{ type: "delete", path: "obsolete.txt" }]);
  });
});

describe("dotOf / computePatchResult / expectedRevisionFor: SPEC.md §4.2's patch identity", () => {
  const patch: Patch = {
    author: "b@x" as ContributorId,
    revision: 3,
    base: [
      ["a@x" as ContributorId, 5],
      ["b@x" as ContributorId, 2],
    ],
    message: "m",
    changes: [{ type: "delete", path: "f" as Patch["changes"][number]["path"] }],
  };

  it("dotOf extracts (author, revision)", () => {
    expect(dotOf(patch)).toEqual({ author: "b@x", revision: 3 });
  });

  it("expectedRevisionFor computes base[author] + 1", () => {
    expect(expectedRevisionFor(patch)).toBe(3);
  });

  it("computePatchResult sets result[author] = revision and keeps other components (SPEC.md §4.2)", () => {
    expect(computePatchResult(patch)).toEqual([
      ["a@x", 5],
      ["b@x", 3],
    ]);
  });

  it("computePatchResult inserts a brand-new author in sorted position", () => {
    const genesis: Patch = { ...patch, author: "c@x" as ContributorId, revision: 1, base: [] };
    expect(computePatchResult(genesis)).toEqual([["c@x", 1]]);
  });
});

describe("revisionOfVersionPairs: SPEC.md §3.3's 'an absent component is zero'", () => {
  it("returns 0 for an absent author", () => {
    const pairs = Either.getOrThrow(Schema.decodeUnknownEither(VersionPairsSchema)([["a@x", 1]]));
    expect(revisionOfVersionPairs(pairs, "b@x" as ContributorId)).toBe(0);
  });

  it("returns the stored revision for a present author", () => {
    const pairs = Either.getOrThrow(Schema.decodeUnknownEither(VersionPairsSchema)([["a@x", 7]]));
    expect(revisionOfVersionPairs(pairs, "a@x" as ContributorId)).toBe(7);
  });
});

describe("VersionPairsSchema: SPEC.md §3.2's version-JSON shape (shared by base and frontier)", () => {
  it("accepts the empty version", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(VersionPairsSchema)([]))).toBe(true);
  });

  it("rejects a non-canonical (unsorted) pair list ('canonical' case, tests/23-strict-validation-matrix.yaml)", () => {
    const pairs = [
      ["b@x", 1],
      ["a@x", 1],
    ];
    expect(Either.isLeft(Schema.decodeUnknownEither(VersionPairsSchema)(pairs))).toBe(true);
  });

  it("rejects zero as an explicit revision", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(VersionPairsSchema)([["a@x", 0]]))).toBe(true);
  });
});
