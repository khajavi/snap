/**
 * Canonical text diff: the SPEC.md §5 `D(i, j)` recurrence, its
 * deletion-on-tie rule, and edit-script coalescing. Pure and
 * dependency-free (plan.md §1.1) — reused by `commit`'s patch authoring,
 * `diff`'s rendering, and OT's transform composition.
 *
 * There is no failure mode for diffing itself: SPEC §5 defines `D(i, j)`
 * and the walk as total over any two token arrays, so `diffTokens` always
 * returns a script. (Malformed *stored* edit scripts are a concern for
 * later validation layers, not for this function.)
 */

/** SPEC §4.4's edit-script operation shapes. */
export type EditOp =
  | { readonly retain: number }
  | { readonly delete: number }
  | { readonly insert: ReadonlyArray<string> };

/** SPEC §4.4: "an edit script is an array of these one-key operations." */
export type EditScript = ReadonlyArray<EditOp>;

/** A single-token operation, before adjacent same-kind coalescing. */
type RawOp = { readonly kind: "retain" } | { readonly kind: "delete" } | { readonly kind: "insert"; readonly token: string };

/**
 * Computes the canonical edit script transforming old tokens `a` into new
 * tokens `b`, per SPEC §5.
 *
 * Implementation strategy: a direct Wagner–Fischer-style DP restricted to
 * insert/delete (no substitution), filled bottom-up exactly per SPEC's own
 * base cases (`D(n, m) = 0`, `D(i, m) = n - i`, `D(n, j) = m - j`) and
 * recurrence (`D(i, j) = D(i+1, j+1)` when tokens are equal, else
 * `1 + min(D(i+1, j), D(i, j+1))`). The backtrack walk then applies SPEC's
 * exact deletion-on-tie rule (choose `delete` when
 * `D(i+1, j) <= D(i, j+1)`, `insert` otherwise), so on repeated tokens and
 * ties the output matches SPEC's own recurrence exactly, by construction —
 * this *is* SPEC's `D(i,j)` table, not an approximation of it. SPEC
 * explicitly permits Myers/Hirschberg as alternative implementations only
 * if they reproduce this same tie-break and token-splitting behavior; this
 * straightforward O(n*m) DP is simple enough at this project's file sizes
 * and gets that equivalence for free, so it's preferred here over a Myers
 * implementation that would need its own tie-break equivalence proof.
 */
export const diffTokens = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): EditScript => {
  const n = a.length;
  const m = b.length;

  // D[i][j] = D(i, j) from SPEC §5, for i in [0, n], j in [0, m].
  const D: number[][] = [];
  for (let i = 0; i <= n; i++) {
    D.push(new Array<number>(m + 1).fill(0));
  }
  for (let i = n; i >= 0; i--) {
    const row = D[i]!;
    const nextRow = D[i + 1];
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) {
        row[j] = 0;
      } else if (i === n) {
        row[j] = m - j;
      } else if (j === m) {
        row[j] = n - i;
      } else if (a[i] === b[j]) {
        row[j] = nextRow![j + 1]!;
      } else {
        row[j] = 1 + Math.min(nextRow![j]!, row[j + 1]!);
      }
    }
  }

  const rawOps: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      // Rule 1: equal tokens produce `retain 1`.
      rawOps.push({ kind: "retain" });
      i++;
      j++;
    } else if (j === m) {
      // Rule 4: new side exhausted, old side is not — delete the rest.
      rawOps.push({ kind: "delete" });
      i++;
    } else if (i === n) {
      // Rule 4: old side exhausted, new side is not — insert the rest.
      rawOps.push({ kind: "insert", token: b[j]! });
      j++;
    } else if (D[i + 1]![j]! <= D[i]![j + 1]!) {
      // Rule 2: deletion-on-tie.
      rawOps.push({ kind: "delete" });
      i++;
    } else {
      // Rule 3.
      rawOps.push({ kind: "insert", token: b[j]! });
      j++;
    }
  }

  return coalesce(rawOps);
};

/**
 * SPEC §5 rule 5: "Coalesce adjacent operations of the same kind." SPEC
 * §4.4 additionally forbids adjacent operations of the same kind in a
 * stored edit script, so this is not merely a size optimization — it's
 * required for the output to be a valid edit script at all.
 */
const coalesce = (rawOps: ReadonlyArray<RawOp>): EditScript => {
  const ops: EditOp[] = [];
  for (const raw of rawOps) {
    const last = ops.length > 0 ? ops[ops.length - 1] : undefined;
    if (raw.kind === "retain") {
      if (last !== undefined && "retain" in last) {
        ops[ops.length - 1] = { retain: last.retain + 1 };
      } else {
        ops.push({ retain: 1 });
      }
    } else if (raw.kind === "delete") {
      if (last !== undefined && "delete" in last) {
        ops[ops.length - 1] = { delete: last.delete + 1 };
      } else {
        ops.push({ delete: 1 });
      }
    } else {
      if (last !== undefined && "insert" in last) {
        ops[ops.length - 1] = { insert: [...last.insert, raw.token] };
      } else {
        ops.push({ insert: [raw.token] });
      }
    }
  }
  return ops;
};

/**
 * Applies an edit script to old tokens, producing the resulting new
 * tokens: `applyEditScript(a, diffTokens(a, b))` equals `b` for any `a`,
 * `b`. Reused by later phases (patch authoring/verification, OT) that need
 * to reconstruct a token sequence from a stored or transformed script, and
 * by this module's own round-trip tests.
 *
 * SPEC §4.4: "The script MUST consume the complete old token sequence;
 * there is no implicit trailing retain." A script violating that, or one
 * whose retain/delete counts run past the end of `a`, is a malformed edit
 * script — an invariant violation this function throws on rather than
 * silently tolerating, since validating externally-sourced scripts is a
 * later validation layer's job, not this pure helper's.
 */
export const applyEditScript = (a: ReadonlyArray<string>, script: EditScript): ReadonlyArray<string> => {
  const result: string[] = [];
  let i = 0;
  for (const op of script) {
    if ("retain" in op) {
      for (let k = 0; k < op.retain; k++) {
        if (i >= a.length) {
          throw new Error("applyEditScript: retain exceeds remaining old tokens");
        }
        result.push(a[i]!);
        i++;
      }
    } else if ("delete" in op) {
      i += op.delete;
      if (i > a.length) {
        throw new Error("applyEditScript: delete exceeds remaining old tokens");
      }
    } else {
      result.push(...op.insert);
    }
  }
  if (i !== a.length) {
    throw new Error("applyEditScript: script does not consume the complete old token sequence");
  }
  return result;
};
