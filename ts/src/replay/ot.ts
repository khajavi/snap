/**
 * SPEC.md §6.3's operational transform: rewrite an incoming edit `P` so it
 * applies after an aggregate context edit `Q` that already moved the base
 * out from under it.
 *
 * §6.3's table, processed "left to right, splitting counts as needed":
 *
 *   | Next operations         | Output in transformed `P` | Consumption |
 *   | ------------------------ | -------------------------- | ----------- |
 *   | `Q insert`                | `retain(length(Q insert))` | Q only      |
 *   | `P insert`                | same `P insert`             | P only      |
 *   | `P retain`, `Q retain`   | `retain(min)`               | both        |
 *   | `P delete`, `Q retain`   | `delete(min)`               | both        |
 *   | `P retain`, `Q delete`   | nothing                     | both        |
 *   | `P delete`, `Q delete`   | nothing                     | both        |
 *
 * "`length(Q insert)` is its token count. The `Q insert` row has priority" —
 * so Q's head is checked before P's on every step, even when P's head is
 * also an insert (§6.3: "Concurrent inserts at one cursor therefore appear
 * in canonical integration order"). Only once Q's head is not an insert do
 * we look at P's head; only once neither head is an insert are we in the
 * four retain/delete combination rows, where "both" consumption means the
 * larger side's op is split down to the smaller side's remaining count.
 *
 * "Both scripts consume the same base token count" by construction (`Q`'s
 * base is `P`'s own base, per §6.2 case 3's `Q = diff(B, C)`), so this
 * function is total over well-formed inputs — no `Either`, matching
 * `domain/diff.ts`'s `applyEditScript`, which also throws on the internal
 * invariant it depends on rather than returning a typed error. A caller
 * handing in two edit scripts with different base token counts is a defect
 * in that caller, not a validation case this pure helper is responsible
 * for.
 */

import type { EditOp, EditScript } from "../domain/diff.js";

// ---------------------------------------------------------------------------
// A cursor over one op stream, tracking how much of the current op remains
// ---------------------------------------------------------------------------

/**
 * A position within one edit script's `retain`/`delete` run: `index` is the
 * current op, `remaining` is how many of that op's tokens have not yet been
 * consumed. Meaningless for `remaining` when the current op is `insert` —
 * inserts are never split (§6.3 consumes a whole `insert` per step), so
 * nothing ever reads `remaining` while `headKind` is `"insert"`.
 */
interface Cursor {
  readonly ops: EditScript;
  index: number;
  remaining: number;
}

/** `retain`/`delete` count of `op`; 0 for `insert` (never consulted there). */
function countOf(op: EditOp): number {
  if ("retain" in op) {
    return op.retain;
  }
  if ("delete" in op) {
    return op.delete;
  }
  return 0;
}

function makeCursor(ops: EditScript): Cursor {
  return { ops, index: 0, remaining: ops.length > 0 ? countOf(ops[0]!) : 0 };
}

function isDone(cursor: Cursor): boolean {
  return cursor.index >= cursor.ops.length;
}

/** The current op, or `undefined` once the stream is exhausted. */
function headOp(cursor: Cursor): EditOp | undefined {
  return cursor.ops[cursor.index];
}

/** Moves past the current op entirely (it has been fully consumed). */
function advance(cursor: Cursor): void {
  cursor.index++;
  cursor.remaining = cursor.index < cursor.ops.length ? countOf(cursor.ops[cursor.index]!) : 0;
}

/** Consumes `n` tokens from the current `retain`/`delete` op (`n <= remaining`). */
function consume(cursor: Cursor, n: number): void {
  cursor.remaining -= n;
  if (cursor.remaining === 0) {
    advance(cursor);
  }
}

/** Consumes the current `insert` op whole, returning its tokens. */
function consumeInsert(cursor: Cursor): ReadonlyArray<string> {
  const op = cursor.ops[cursor.index]!;
  if (!("insert" in op)) {
    throw new Error("transformEditThroughContext: consumeInsert called on a non-insert op");
  }
  advance(cursor);
  return op.insert;
}

// ---------------------------------------------------------------------------
// Output coalescing (SPEC §6.3: "Coalesce adjacent output operations")
// ---------------------------------------------------------------------------

/**
 * Merges adjacent same-kind operations, the way `domain/diff.ts`'s own
 * `coalesce` does for its output — here applied to already multi-count ops
 * (each step below can emit a `retain`/`delete` larger than 1) rather than
 * one raw unit at a time. Also drops zero-length ops, which cannot arise
 * from a well-formed `min` split but are filtered defensively rather than
 * assumed away.
 */
function coalesce(ops: ReadonlyArray<EditOp>): EditScript {
  const result: EditOp[] = [];
  for (const op of ops) {
    const last = result.length > 0 ? result[result.length - 1] : undefined;
    if ("retain" in op) {
      if (op.retain === 0) {
        continue;
      }
      if (last !== undefined && "retain" in last) {
        result[result.length - 1] = { retain: last.retain + op.retain };
      } else {
        result.push(op);
      }
    } else if ("delete" in op) {
      if (op.delete === 0) {
        continue;
      }
      if (last !== undefined && "delete" in last) {
        result[result.length - 1] = { delete: last.delete + op.delete };
      } else {
        result.push(op);
      }
    } else {
      if (op.insert.length === 0) {
        continue;
      }
      if (last !== undefined && "insert" in last) {
        result[result.length - 1] = { insert: [...last.insert, ...op.insert] };
      } else {
        result.push(op);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

/**
 * Transforms incoming edit script `incomingEdit` (`P`) so that it applies
 * cleanly after aggregate context edit `contextEdit` (`Q`) has already been
 * applied to their shared base — SPEC.md §6.3, used by §6.2 case 3 once per
 * incoming text change against the aggregate `Q = diff(B, C)`.
 *
 * Walks both streams left to right with one cursor each, at every step
 * checking `Q`'s head first (its priority row: an insert there emits
 * `retain(length)` and advances only `Q`), then `P`'s head (an insert there
 * emits itself and advances only `P`); only when neither head is an insert
 * do we fall into the four `retain`/`delete` combination rows, splitting
 * whichever side has the larger remaining count down to `min(P, Q)` so both
 * cursors consume exactly that much before the next step. The loop ends
 * once both cursors are exhausted, which — since "both scripts consume the
 * same base token count" by construction — happens for both at once;
 * reaching a step where one side is exhausted but the other still has a
 * pending `retain`/`delete` is an invariant violation this function throws
 * on rather than tolerating.
 *
 * The raw per-step output can leave adjacent same-kind operations (e.g. two
 * `retain` steps in a row), so the final script is coalesced before return.
 */
export function transformEditThroughContext(incomingEdit: EditScript, contextEdit: EditScript): EditScript {
  const p = makeCursor(incomingEdit);
  const q = makeCursor(contextEdit);
  const raw: EditOp[] = [];

  while (!isDone(p) || !isDone(q)) {
    // Row 1: "Q insert" has priority — checked before anything else.
    const qHeadForInsert = headOp(q);
    if (qHeadForInsert !== undefined && "insert" in qHeadForInsert) {
      const tokens = consumeInsert(q);
      raw.push({ retain: tokens.length });
      continue;
    }

    // Row 2: "P insert" — same insert, P only.
    const pHeadForInsert = headOp(p);
    if (pHeadForInsert !== undefined && "insert" in pHeadForInsert) {
      const tokens = consumeInsert(p);
      raw.push({ insert: tokens });
      continue;
    }

    // Neither head is an insert: both must be pending retain/delete ops, and
    // by the base-token-count invariant both cursors must still be open.
    const pHead = headOp(p);
    const qHead = headOp(q);
    if (pHead === undefined || qHead === undefined) {
      throw new Error(
        "transformEditThroughContext: incoming and context edits do not consume the same base token count",
      );
    }

    const n = Math.min(p.remaining, q.remaining);
    const pIsDelete = "delete" in pHead;
    const qIsDelete = "delete" in qHead;

    if (!pIsDelete && !qIsDelete) {
      // Row 3: P retain, Q retain -> retain(min).
      raw.push({ retain: n });
    } else if (pIsDelete && !qIsDelete) {
      // Row 4: P delete, Q retain -> delete(min).
      raw.push({ delete: n });
    }
    // Row 5 (P retain, Q delete) and Row 6 (P delete, Q delete): nothing.

    consume(p, n);
    consume(q, n);
  }

  return coalesce(raw);
}
