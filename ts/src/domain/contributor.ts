/**
 * Contributor-ID grammar validation (SPEC.md §3.1).
 *
 * A contributor ID is Snap's vector-clock writer identity: an ASCII
 * email-shaped string, preserved verbatim (Snap never normalizes case or
 * whitespace within it — there is none to normalize once validated).
 */

import { Buffer } from "node:buffer";
import { Data, Either } from "effect";

/**
 * A contributor ID that has passed `parseContributorId`. Branded so a bare
 * `string` can't be mistaken for one elsewhere in the domain.
 */
export type ContributorId = string & { readonly __brand: "ContributorId" };

/** SPEC.md §3.1: "at most 254 bytes". */
export const MAX_CONTRIBUTOR_ID_BYTES = 254;

/** SPEC.md §3.1: forbidden standalone characters (beyond control/whitespace). */
const FORBIDDEN_CHARS = new Set([",", "(", ")"]);

/** SPEC.md §3.1: forbidden substring (it also separates a version's id from its revision, §3.2). */
const FORBIDDEN_SUBSTRING = "->";

export class InvalidContributorIdError extends Data.TaggedError("InvalidContributorIdError")<{
  readonly input: string;
  readonly reason: string;
}> {}

/**
 * ASCII control characters (0x00-0x1F, 0x7F) and ASCII whitespace (all of
 * which already fall in 0x00-0x20) collapse to a single range check once
 * non-ASCII input has been rejected separately.
 */
function isAsciiControlOrWhitespace(codePoint: number): boolean {
  return codePoint <= 0x20 || codePoint === 0x7f;
}

/**
 * Validates a contributor ID against SPEC.md §3.1's grammar: an ASCII
 * email-shaped string containing exactly one `@` with nonempty text on
 * both sides; no control character, whitespace, `,`, `(`, `)`, or
 * substring `->`; at most 254 bytes. Preserves the input's exact spelling
 * on success.
 */
export function parseContributorId(
  input: string,
): Either.Either<ContributorId, InvalidContributorIdError> {
  const fail = (reason: string): Either.Either<ContributorId, InvalidContributorIdError> =>
    Either.left(new InvalidContributorIdError({ input, reason }));

  for (const char of input) {
    const codePoint = char.codePointAt(0);
    // `char` is a single code point yielded by string iteration, so this is defined.
    if (codePoint === undefined) {
      return fail("contains an invalid character");
    }
    if (codePoint > 0x7f) {
      return fail("must be ASCII");
    }
    if (isAsciiControlOrWhitespace(codePoint)) {
      return fail("must not contain a control character or whitespace");
    }
    if (FORBIDDEN_CHARS.has(char)) {
      return fail(`must not contain "${char}"`);
    }
  }

  if (input.includes(FORBIDDEN_SUBSTRING)) {
    return fail('must not contain "->"');
  }

  const atParts = input.split("@");
  if (atParts.length !== 2) {
    return fail('must contain exactly one "@"');
  }
  const [localPart, domainPart] = atParts;
  if (localPart === "" || domainPart === "") {
    return fail('must have nonempty text on both sides of "@"');
  }

  if (Buffer.byteLength(input, "utf8") > MAX_CONTRIBUTOR_ID_BYTES) {
    return fail(`must be at most ${MAX_CONTRIBUTOR_ID_BYTES} bytes`);
  }

  return Either.right(input as ContributorId);
}

/**
 * Compares two contributor IDs by unsigned UTF-8 bytes (SPEC.md §3.2), the
 * order canonical version syntax sorts contributors by.
 */
export function compareContributorIds(a: ContributorId, b: ContributorId): -1 | 0 | 1 {
  const cmp = Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
}
