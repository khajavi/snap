import { describe, expect, it } from "vitest";
import { classify, isCanonicalTokenSequence, isTextBytes, tokenize } from "../../src/domain/text.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("isTextBytes", () => {
  it.each<[string, Uint8Array, boolean]>([
    ["empty bytes are text", new Uint8Array([]), true],
    ["plain ASCII is text", utf8("hello\n"), true],
    ["valid multi-byte UTF-8 is text", utf8("café\n"), true],
    ["a NUL byte makes it binary, even alongside otherwise-valid UTF-8", new Uint8Array([0x61, 0x00, 0x62]), false],
    // SPEC §4.4 / tests/06-binary-and-empty.yaml's `data.bin` fixture:
    // base64 AP+AQUI= decodes to bytes 00 FF 80 41 42.
    ["the 06-binary-and-empty.yaml data.bin fixture is binary", new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x42]), false],
    ["a lone continuation byte is invalid UTF-8, so binary", new Uint8Array([0x80]), false],
    ["a truncated multi-byte sequence is invalid UTF-8, so binary", new Uint8Array([0xe2, 0x82]), false],
    ["an overlong encoding is invalid UTF-8, so binary", new Uint8Array([0xc0, 0xaf]), false],
  ])("%s", (_name, bytes, expected) => {
    expect(isTextBytes(bytes)).toBe(expected);
  });
});

describe("tokenize", () => {
  it("the empty file has no tokens (SPEC §4.4)", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("splits immediately after every LF, retaining the LF, per SPEC's own example", () => {
    // SPEC §4.4: `"a\r\nb"` becomes `"a\r\n"`, `"b"`.
    expect(tokenize("a\r\nb")).toEqual(["a\r\n", "b"]);
  });

  it("a trailing LF produces no extra empty final token", () => {
    expect(tokenize("a\nb\n")).toEqual(["a\n", "b\n"]);
  });

  it("a final line with no trailing newline is its own (LF-less) token", () => {
    expect(tokenize("a\nb")).toEqual(["a\n", "b"]);
  });

  it("a lone newline is a single token", () => {
    expect(tokenize("\n")).toEqual(["\n"]);
  });

  it("content with no newline at all is a single token", () => {
    expect(tokenize("abc")).toEqual(["abc"]);
  });

  it("repeated lines tokenize to repeated tokens (05-diff-goldens.yaml's repeated.txt)", () => {
    expect(tokenize("a\nb\na\n")).toEqual(["a\n", "b\n", "a\n"]);
    expect(tokenize("b\na\na")).toEqual(["b\n", "a\n", "a"]);
  });
});

describe("classify", () => {
  it("classifies text bytes with their canonical token sequence", () => {
    expect(classify(utf8("a\nb\na\n"))).toEqual({ _tag: "Text", tokens: ["a\n", "b\n", "a\n"] });
  });

  it("classifies the empty file as text with zero tokens", () => {
    expect(classify(new Uint8Array([]))).toEqual({ _tag: "Text", tokens: [] });
  });

  it("classifies NUL-containing bytes as binary", () => {
    expect(classify(new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x42]))).toEqual({ _tag: "Binary" });
  });
});

describe("isCanonicalTokenSequence", () => {
  it("accepts the empty sequence", () => {
    expect(isCanonicalTokenSequence([])).toBe(true);
  });

  it("accepts a sequence where every token ends in LF", () => {
    expect(isCanonicalTokenSequence(["a\n", "b\n"])).toBe(true);
  });

  it("accepts a sequence where only the final token lacks a trailing LF", () => {
    expect(isCanonicalTokenSequence(["a\n", "b"])).toBe(true);
  });

  it("rejects a non-final token lacking a trailing LF", () => {
    expect(isCanonicalTokenSequence(["a", "b\n"])).toBe(false);
  });

  it("rejects a token containing LF before its final byte", () => {
    expect(isCanonicalTokenSequence(["a\nb\n"])).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(isCanonicalTokenSequence(["a\n", ""])).toBe(false);
  });
});
