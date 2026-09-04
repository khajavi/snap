import { describe, expect, it } from "vitest";
import type { EditOp, EditScript } from "../../src/domain/diff.js";
import { transformEditThroughContext } from "../../src/replay/ot.js";

// SPEC.md §6.3's transform, exercised row by row against the table:
//
//   | Next operations         | Output in transformed `P` | Consumption |
//   | ------------------------ | -------------------------- | ----------- |
//   | `Q insert`                | `retain(length(Q insert))` | Q only      |
//   | `P insert`                | same `P insert`             | P only      |
//   | `P retain`, `Q retain`   | `retain(min)`               | both        |
//   | `P delete`, `Q retain`   | `delete(min)`               | both        |
//   | `P retain`, `Q delete`   | nothing                     | both        |
//   | `P delete`, `Q delete`   | nothing                     | both        |
//
// then count-splitting, Q-insert priority, trailing inserts, a composed
// multi-op scenario, and output coalescing.

const retain = (n: number): EditOp => ({ retain: n });
const del = (n: number): EditOp => ({ delete: n });
const insert = (tokens: ReadonlyArray<string>): EditOp => ({ insert: tokens });

/** Sums the base tokens a script consumes (retain + delete counts). */
const consumedBaseTokens = (script: EditScript): number =>
  script.reduce((sum, op) => sum + ("retain" in op ? op.retain : "delete" in op ? op.delete : 0), 0);

describe("transformEditThroughContext: the six table rows in isolation", () => {
  it("Q insert -> retain(length(Q insert)), Q only", () => {
    // P has nothing (empty base); Q inserts 2 tokens at the same position.
    const p: EditScript = [];
    const q: EditScript = [insert(["x", "y"])];
    expect(transformEditThroughContext(p, q)).toEqual([retain(2)]);
  });

  it("P insert -> same P insert, P only", () => {
    // Q has nothing; P inserts a token.
    const p: EditScript = [insert(["a"])];
    const q: EditScript = [];
    expect(transformEditThroughContext(p, q)).toEqual([insert(["a"])]);
  });

  it("P retain, Q retain -> retain(min), both", () => {
    const p: EditScript = [retain(3)];
    const q: EditScript = [retain(3)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(3)]);
  });

  it("P delete, Q retain -> delete(min), both", () => {
    const p: EditScript = [del(3)];
    const q: EditScript = [retain(3)];
    expect(transformEditThroughContext(p, q)).toEqual([del(3)]);
  });

  it("P retain, Q delete -> nothing, both", () => {
    const p: EditScript = [retain(3)];
    const q: EditScript = [del(3)];
    expect(transformEditThroughContext(p, q)).toEqual([]);
  });

  it("P delete, Q delete -> nothing, both", () => {
    const p: EditScript = [del(3)];
    const q: EditScript = [del(3)];
    expect(transformEditThroughContext(p, q)).toEqual([]);
  });
});

describe("transformEditThroughContext: count-splitting", () => {
  it("P retain(5) vs Q retain(3) splits P's op, re-matching the remainder against Q's next op", () => {
    // P: retain 5 (over base tokens 0-4).
    // Q: retain 3, then delete 2 (also over base tokens 0-4).
    // Step 1: min(5,3)=3 -> retain(3), P has 2 left, Q advances to delete(2).
    // Step 2: min(2,2)=2, P retain vs Q delete -> nothing.
    const p: EditScript = [retain(5)];
    const q: EditScript = [retain(3), del(2)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(3)]);
  });

  it("P retain(3) vs Q retain(5) splits Q's op, re-matching P's next op against the remainder", () => {
    // P: retain 3, then delete 2 (over base tokens 0-4).
    // Q: retain 5 (over base tokens 0-4).
    // Step 1: min(3,5)=3 -> retain(3), Q has 2 left, P advances to delete(2).
    // Step 2: min(2,2)=2, P delete vs Q retain -> delete(2).
    const p: EditScript = [retain(3), del(2)];
    const q: EditScript = [retain(5)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(3), del(2)]);
  });
});

describe("transformEditThroughContext: Q insert priority", () => {
  it("Q's pending insert fires before P's insert at the same position", () => {
    // Both P and Q want to insert at position 0. Per the table, Q's insert
    // row is checked first: it becomes a retain (consuming Q only), and only
    // on the next step does P's insert get emitted.
    const p: EditScript = [insert(["p-token"])];
    const q: EditScript = [insert(["q-token", "q-token2"])];
    expect(transformEditThroughContext(p, q)).toEqual([retain(2), insert(["p-token"])]);
  });

  it("Q's insert still takes priority even while P also has a retain pending", () => {
    // P: retain(1) (over one base token). Q: insert(1 token), then retain(1)
    // over the same base token. Q's insert must be consumed (as a retain)
    // before P's retain is matched against Q's retain.
    const p: EditScript = [retain(1)];
    const q: EditScript = [insert(["q-token"]), retain(1)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(2)]); // coalesced: retain(1) + retain(1)
  });
});

describe("transformEditThroughContext: trailing insertions", () => {
  it("a trailing insert at the end of Q is processed after P and Q's shared base is exhausted", () => {
    // retain(1) matching both heads, then Q's trailing insert(1 token)
    // becomes a further retain(1) — coalesced into one retain(2).
    const p: EditScript = [retain(1)];
    const q: EditScript = [retain(1), insert(["tail"])];
    expect(transformEditThroughContext(p, q)).toEqual([retain(2)]);
  });

  it("a trailing insert at the end of P is processed after P and Q's shared base is exhausted", () => {
    const p: EditScript = [retain(1), insert(["tail"])];
    const q: EditScript = [retain(1)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(1), insert(["tail"])]);
  });
});

describe("transformEditThroughContext: deletion-vs-insert interaction", () => {
  it("P delete against Q retain still emits delete(min) even with inserts mixed in nearby", () => {
    // Q: insert(1 token), then retain(2) — over base tokens 0-1.
    // P: retain(1), then delete(1) — over the same base tokens 0-1.
    // Step 1: Q's insert fires -> retain(1), Q only.
    // Step 2: P retain(1) vs Q retain(2) -> retain(1); Q has 1 left.
    // Step 3: P delete(1) vs Q retain(1) -> delete(1).
    // Raw retain(1), retain(1), delete(1) coalesces to retain(2), delete(1).
    const p: EditScript = [retain(1), del(1)];
    const q: EditScript = [insert(["ins"]), retain(2)];
    expect(transformEditThroughContext(p, q)).toEqual([retain(2), del(1)]);
  });
});

describe("transformEditThroughContext: a composed multi-op scenario", () => {
  it("produces the full expected output op-by-op and preserves each side's total consumed base tokens", () => {
    // Base tokens indexed 0..6 (7 tokens total).
    // P: retain(2), delete(1), insert(["p-ins"]), retain(2), delete(2).
    //   consumes base: retain2 + delete1 + retain2 + delete2 = 7.
    // Q: insert(["q-ins"]), retain(1), delete(2), retain(4).
    //   consumes base: retain1 + delete2 + retain4 = 7.
    //
    // Trace:
    //  1. Q insert (q-ins) -> retain(1), Q only. Q now at retain(1).
    //  2. Neither head is insert. P retain(2) vs Q retain(1): min=1 ->
    //     retain(1). P retain remaining=1; Q advances to delete(2).
    //  3. P retain(1) vs Q delete(2): min=1 -> nothing. P advances to
    //     delete(1); Q delete remaining=1.
    //  4. P delete(1) vs Q delete(1): min=1 -> nothing. P advances to its
    //     insert; Q advances to retain(4).
    //  5. P insert(["p-ins"]) -> emits insert(["p-ins"]), P only. P advances
    //     to retain(2).
    //  6. P retain(2) vs Q retain(4): min=2 -> retain(2). P advances to
    //     delete(2); Q retain remaining=2.
    //  7. P delete(2) vs Q retain(2): min=2 -> delete(2). Both exhausted.
    //
    // Raw output: retain(1), retain(1), insert(["p-ins"]), retain(2), delete(2)
    // Coalesced: retain(2), insert(["p-ins"]), retain(2), delete(2).
    const p: EditScript = [retain(2), del(1), insert(["p-ins"]), retain(2), del(2)];
    const q: EditScript = [insert(["q-ins"]), retain(1), del(2), retain(4)];

    const result = transformEditThroughContext(p, q);
    expect(result).toEqual([retain(2), insert(["p-ins"]), retain(2), del(2)]);

    // Structural invariant: total base tokens consumed by P equals total
    // base tokens consumed by Q ("both scripts consume the same base token
    // count"). Checked here at the input level since applyEditScript-based
    // integration is a later piece.
    expect(consumedBaseTokens(p)).toBe(7);
    expect(consumedBaseTokens(q)).toBe(7);
    expect(consumedBaseTokens(p)).toBe(consumedBaseTokens(q));
  });
});

describe("transformEditThroughContext: coalescing", () => {
  it("merges adjacent retains produced by consecutive matching steps into one op", () => {
    // P: retain(1), retain(1) is not a valid single script (diff.ts would
    // have coalesced it already), but the *transform*'s own step-by-step
    // output can still produce adjacent same-kind ops that need merging:
    // two retain(1) steps in a row here, from P retain(2) split against Q's
    // retain(1) + retain(1).
    const p: EditScript = [retain(2)];
    const q: EditScript = [retain(1), retain(1)];
    // Note: q as given has adjacent retains (an artificial fixture — a real
    // diffTokens output would already coalesce this), which is exactly why
    // this exercises two separate min-steps that must coalesce on output.
    const result = transformEditThroughContext(p, q);
    expect(result).toEqual([retain(2)]);
  });

  it("merges adjacent deletes produced across a Q-insert-free run of matching delete/retain steps", () => {
    // P: delete(1), delete(1) (already adjacent — coalesced input would be
    // delete(2), but feeding two ops still must coalesce on output).
    // Q: retain(1), retain(1).
    const p: EditScript = [del(1), del(1)];
    const q: EditScript = [retain(1), retain(1)];
    const result = transformEditThroughContext(p, q);
    expect(result).toEqual([del(2)]);
  });

  it("merges adjacent inserts produced by two consecutive P-insert steps", () => {
    // P: insert(["a"]), insert(["b"]) with no Q inserts in between — Q is
    // empty, so both P inserts are emitted back-to-back and must coalesce.
    const p: EditScript = [insert(["a"]), insert(["b"])];
    const q: EditScript = [];
    const result = transformEditThroughContext(p, q);
    expect(result).toEqual([insert(["a", "b"])]);
  });
});
