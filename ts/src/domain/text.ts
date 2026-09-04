/**
 * UTF-8/NUL text classification and LF tokenization/canonicalization, per
 * SPEC.md §4.4 ("Text tokens and edit scripts").
 *
 * This module always succeeds: every byte sequence is either classified as
 * text (with its canonical token sequence) or binary. There is no failure
 * mode here — SPEC §4.4 defines classification and tokenization as total
 * functions over arbitrary bytes; rejecting malformed *content* (e.g. an
 * edit script that doesn't reconstruct a canonical token sequence) is a
 * concern for later validation layers (patch/repository validation), not
 * for this pure module.
 */

/** A single text token: SPEC §4.4's unit produced by LF-splitting. */
export type Token = string;

/** The outcome of classifying raw file bytes per SPEC §4.4. */
export type Classification =
  | { readonly _tag: "Text"; readonly tokens: ReadonlyArray<Token> }
  | { readonly _tag: "Binary" };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * SPEC §4.4: "A file is text when its bytes are valid UTF-8 and contain no
 * NUL." NUL is checked separately because a NUL byte (0x00) is itself a
 * technically valid UTF-8 code point, so UTF-8 validity alone would not
 * reject it.
 */
export const isTextBytes = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    utf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * Splits decoded text content into tokens per SPEC §4.4: "Split it
 * immediately after every LF byte, retaining LF in the token." The empty
 * file has no tokens. The example given in SPEC — `"a\r\nb"` becomes
 * `"a\r\n"`, `"b"` — is a direct fixture below.
 */
export const tokenize = (text: string): ReadonlyArray<Token> => {
  if (text.length === 0) {
    return [];
  }
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === "\n") {
      tokens.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    tokens.push(text.slice(start));
  }
  return tokens;
};

/**
 * Classifies raw file bytes as text (with its canonical token sequence) or
 * binary, per SPEC §4.4. This is the single entry point commands/patch
 * authoring should use — it never re-derives text-vs-binary and
 * tokenization from two separate passes over the bytes.
 */
export const classify = (bytes: Uint8Array): Classification => {
  if (!isTextBytes(bytes)) {
    return { _tag: "Binary" };
  }
  const text = utf8Decoder.decode(bytes);
  return { _tag: "Text", tokens: tokenize(text) };
};

/**
 * Checks SPEC §4.4's canonical-token-sequence invariant: "every token
 * except possibly the final one ends in LF, and no token contains LF
 * before its final byte." Also rejects empty tokens, since SPEC's edit
 * script `insert` operation requires "nonempty text tokens" and a token
 * produced by `tokenize` is never empty.
 *
 * Exposed for tests that assert `diffTokens`'s output (applied to `a`)
 * always reconstructs a canonical sequence, and for future validation
 * layers that need to check an arbitrary token array (e.g. one decoded
 * from a repository's stored edit script) against this invariant.
 */
export const isCanonicalTokenSequence = (tokens: ReadonlyArray<Token>): boolean => {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length === 0) {
      return false;
    }
    const lfIndex = token.indexOf("\n");
    const isLast = i === tokens.length - 1;
    if (lfIndex === -1) {
      if (!isLast) {
        return false;
      }
    } else if (lfIndex !== token.length - 1) {
      return false;
    }
  }
  return true;
};
