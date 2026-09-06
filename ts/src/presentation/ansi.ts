/**
 * ANSI SGR primitive (SPEC.md §7.11, plan.md Phase 9): the section's
 * `S(n, text)` — `ESC[`, decimal code `n`, `m`, `text`, `ESC[0m` — plus
 * the decimal codes it names. Pure string composition; nothing here
 * decides *whether* styling applies (that is `mode.ts`'s job) or what
 * text each output family carries (that is `render.ts`'s job).
 */

/** The ESC control character §7.11's notation abbreviates. */
const ESC = "\u001b";

/** §7.11's named SGR codes: bold, dim, red, green, yellow, magenta, cyan. */
export const CODE = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  magenta: 35,
  cyan: 36,
} as const;

/** One SGR style code. */
export type Code = (typeof CODE)[keyof typeof CODE];

/** §7.11's `S(n, text)`: wrap `text` in SGR code `n`, then reset. */
export const styled = (code: Code, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`;
