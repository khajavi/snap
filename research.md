# Snap: Prior Art and Algorithm Research

## Overview

Snap (see [`SPEC.md`](SPEC.md)) identifies a **version** by a **vector clock** — a map from
contributor ID to that contributor's revision counter — and treats history as a **causally
ordered set of patches**, deterministically **replayed** from the empty tree to materialize any
known version. Every conflict — text or structural — is resolved automatically: line-level
Operational Transformation for concurrent text edits (§6.3), and fixed tie-break rules such as
`delete-wins`/`later-create-wins`/`namespace-wins` for everything else (§6.4). No conflict is ever
left unresolved for a human.

This document covers only the algorithms and reference material that directly inform Snap's
implementation: the canonical diff recurrence (§5), the OT transform (§6.3), vector clocks and
their CRDT convergence property (§3, §1 invariant 6), and the LWW-style tie-break rules (§6.4).
The `ts/package.json` scaffold declares **zero runtime dependencies**, so libraries below are
cited only as algorithm references to hand-roll against, never as imports.

---

## Algorithms

### Canonical LCS/edit-distance recurrence (Wagner–Fischer)

Computes minimum edit distance via DP: `D[i][j]` filled bottom-up in `O(n·m)` from "match extends
the diagonal for free; otherwise 1 + min(insert, delete)". First formalized by Wagner & Fischer
(1974). SPEC §5's `D(i, j)` recurrence is exactly this table restricted to insert/delete only (no
substitution), plus a fixed deletion-on-tie walk rule. Any implementation may compute this table
by a faster method as long as output matches, including on ties and repeated lines.

Sources: [Wagner–Fischer algorithm (Wikipedia)](https://en.wikipedia.org/wiki/Wagner%E2%80%93Fischer_algorithm)

### Myers' O(ND) diff algorithm

Reframes sequence diffing as shortest-path search over an edit graph, finding "snakes" (diagonal
match runs) in `O(N·D)` time (`N` = combined length, `D` = edit-script size), with a linear-space
divide-and-conquer refinement. SPEC §5 explicitly names Myers (and Hirschberg) as acceptable
*optimizations* of its recurrence — usable for performance on large files provided the exact
tie-break and token-splitting behavior is reproduced.

Patience diff was considered and rejected: it anchors on lines unique to both texts for more
human-readable alignments, but SPEC §5 fixes the diff's exact output via a single recurrence and
tie-break rule, which patience diff's heuristics would not reliably reproduce.

Sources: [An O(ND) Difference Algorithm (Myers, original paper PDF)](http://www.xmailserver.org/diff2.pdf), [jsdiff docs on Myers](https://www.jsdiff.com/docs/myers-diff-algorithm.html)

### Operational Transformation

Classic OT lets every replica edit locally, then **transforms** a remote operation against a
local one so that application order doesn't change the resulting document (Jupiter protocol,
1995; Google Wave's OT). SPEC §6.3's transform table (retain/delete/insert rules, "`Q insert` row
has priority") is a small token-level, two-operand transform in this family — but simplified,
because Snap never runs live multi-site transformation: it performs exactly **one** offline
transform of an incoming patch's edit script against one aggregate "context edit" (the join of
already-integrated concurrent effects), computed once per patch during replay, not once per
historical patch (§6.3). This sidesteps the classical multi-site OT correctness conditions
(TP1/TP2) that make live OT hard, because Snap's replay order (Snap order, §3.4) is already fully
deterministic.

Sources: [Google Wave Operational Transformation whitepaper](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html), [Practical Intro to Operational Transformation](https://archive.casouri.cc/note/2025/practical-intro-ot/)

### Vector clocks and CRDT convergence

Each process holds a vector of per-process counters; a local event increments the local
component, and a receive takes the pointwise `max` with the received vector. This gives **strong
clock consistency**: causal precedence iff the vector compares strictly less componentwise —
stronger than Lamport scalar clocks. Introduced by Fidge (1988) and Mattern (1989). This is
Snap's version type verbatim: SPEC §3.3's four comparison outcomes (`=`, `<`, `>`, `||`) and
`join(V, W)[c] = max(V[c], W[c])` are textbook vector-clock comparison and merge, and the "serial
contributor rule" (§3.5, one contributor ID must not produce two divergent events at the same
counter) is the classical constraint that each process's own component only advances through its
own events.

"Import is set union: idempotent, commutative, and associative" (SPEC §1 invariant 6) is exactly
the semilattice property defining a **state-based CRDT (CvRDT)** — the mathematical guarantee
that merging patch sets in any order, any number of times, converges to the same result, which is
what SPEC §6.5 requires ("re-merging the same history is a no-op, and merge direction cannot
change the joined result").

Sources: [Chapter 3: Logical Time (Kshemkalyani & Singhal)](https://www.cs.uic.edu/~ajayk/Chapter3.pdf), [Conflict-free Replicated Data Types (Shapiro et al., 2011, PDF)](https://www.lip6.fr/Marc.Shapiro/papers/2011/CRDTs_SSS-2011.pdf)

### Deterministic tie-break rules for structural/binary conflicts (LWW)

When two concurrent operations touch the same conflict-prone unit, a **last-writer-wins (LWW)**
register resolves the conflict by picking one operation under a total order and discarding the
other's effect — guaranteed convergence without coordination, at the cost of silently dropping a
concurrent update. SPEC §6.4's path-level rules (`delete-wins`, `later-create-wins`,
`later-put-wins`, `namespace-wins`, `put-wins`) are exactly this pattern, generalized over "Snap
order" (§3.4) — an arbitrary-but-fixed total order over concurrent versions used purely to decide
which concurrent patch is canonically later, with "no chronological or authorship meaning." A
concurrent, equally valid change can be discarded (SPEC §1, §6.5) — mitigated only by the
`warning: auto-resolved <path>: <reason>` line so the loss stays visible and correctable via a
follow-up commit.

Sources: [Conflict-free Replicated Data Types: An Overview (arXiv 1806.10254)](https://arxiv.org/pdf/1806.10254)

---

## Libraries & References

None of these are runtime dependencies (`ts/package.json` has none) — they are algorithm/behavior
references to consult or diff test output against while hand-rolling SPEC-compliant logic.

| Library | Purpose | Relevance to Snap |
| --- | --- | --- |
| [`diff`](https://www.npmjs.com/package/diff) (jsdiff) | Myers-based text diff | Reference implementation of the algorithm SPEC §5 permits as an optimization; not a drop-in since Snap's tie-break and token-splitting rules are more specific |
| [`fast-diff`](https://www.npmjs.com/package/fast-diff) | Stripped-down Myers-derived diff-only | Minimal reference for the "diff only" half of what Snap needs |
| [`ot.js`](https://github.com/Operational-Transformation/ot.js) / [`ottypes/json0`](https://github.com/ottypes/json0) | OT transform functions (retain/insert/delete op streams) | Direct prior art for the shape of the transform SPEC §6.3 generalizes; note json0's pairwise transform cost is exactly what Snap avoids by transforming once against an aggregate context edit |
| [`ajv`](https://ajv.js.org/) | JSON Schema validator | Reference for structuring schema validation and error reporting; SPEC §4.5's bespoke structural + causal validation (dot-collision, cycle/gap detection, replay-based validation) goes well beyond generic schema validation, so this informs API shape only |
| [`vectorclock`](https://www.npmjs.com/package/vectorclock) (mixu), [`ts-vector-clock`](https://github.com/MattLloyd101/ts-vector-clock) | Minimal vector-clock data structures (`increment`/`merge`/compare) | Directly analogous data structure to Snap's version type; none encode Snap's canonical `(id->n,...)` syntax or serial-contributor corruption rule, so they inform the interface, not the encoding |

Sources: [npm `diff` package](https://www.npmjs.com/package/diff), [npm `fast-diff`](https://www.npmjs.com/package/fast-diff), [ottypes/json0](https://github.com/ottypes/json0), [ajv.js.org](https://ajv.js.org/), [npm `vectorclock` (mixu)](https://www.npmjs.com/package/vectorclock), [MattLloyd101/ts-vector-clock (GitHub)](https://github.com/MattLloyd101/ts-vector-clock)

---

## Open Spec Issues

Findings from an audit of `SPEC.md` cross-checked against `tests/*.yaml`. **No decisions or fixes
are recorded here — this is a catalog only.** Each item: category, spec quote, why it's a
problem, whether a test resolves it, severity.

### Inconsistency

**1. §2's cross-reference for prefix-freedom enforcement points to the wrong section.**
Quote: "Every tracked tree is **prefix-free by path segment**... This is validated for every
patch's authored result and enforced during concurrent replay by §6.4." The actual
ancestor/descendant namespace-conflict mechanism (computing `S`, `C'`, marking paths for
removal/installation) lives in **§6.2**'s first paragraph, not §6.4. §6.4 ("Path-level rules")
only holds same-path `B`/`C`/`T` tie-break rules and never mentions ancestor/descendant checking.
Not resolved by any test. Severity: minor/editorial, but actively misdirecting.

### Ambiguity

**2. Scope of "the paths that P makes present" (§6.2) is underdetermined, with a real behavioral fork.**
Quote: "Let `S` be the paths that `P` makes present... If a path in `S` has a different current
ancestor or descendant in `C'`... mark every conflicting current path for removal." Could mean
only absent→present transitions (creates), or every path whose authored result `T` is present
(including ordinary edits/puts of already-present paths). Concrete fork: an already-integrated
patch namespace-replaces file `a` with directory `a/b`; a concurrent patch, integrated afterward,
merely edits already-present `a/b` from its own unrelated base. Under the narrow reading, `a/b`
never enters `S`, so the namespace pre-check never fires — the ordinary per-path evaluation would
fall through to §6.4 rule 3 ("B present, C absent → delete-wins"), mislabeling a structural
namespace collision as an ordinary concurrent delete. The wide reading correctly re-triggers the
namespace path. `tests/11-namespace-conflicts.yaml` only exercises **create**-vs-create
collisions; no test exercises an edit landing on a path whose ancestor/descendant was
namespace-replaced by an unrelated concurrently-integrated patch. Severity:
**moderate-to-blocking** — both readings are internally consistent and separately implementable,
but they diverge in output, and the narrow reading risks violating the prefix-free tree invariant
§2 promises this mechanism enforces.

**3. §7.6's predicate for "text path" vs. binary one-liner is unstated for cross-version diffs with mixed text/binary sides.**
Quote: "For each text path, print one whole-file unified-style block... For a binary change,
print one line... `Binary files a/<path> and b/<path> differ`." §7.6 never states the
text-vs-binary classification rule when a path's byte classification differs between the old and
new side being diffed (e.g. `put` replaces a text file with binary content, or vice versa). §7.5
(`commit`) states an analogous rule for choosing a change type, and it's a reasonable inference
that §7.6 means the same, but this is never stated for `diff`, and the inference isn't obviously
symmetric (depend on old-side classification, new-side, or both?). `tests/06-binary-and-empty.yaml`
only exercises pure-binary create/delete and empty-text create — no text→binary or binary→text
transition at one path across two versions. Severity: moderate — implementable multiple ways,
risk of TS/Rust/Scala divergence on mixed-type diffs.

### Impossible/ill-defined requirement

None found. The diff recurrence (§5), the OT transform table (§6.3), and the vector-clock
comparison/join laws (§3.3–3.5) were hand-traced end to end and are all fully determined,
internally consistent, and match their corresponding test files. The closest candidate is Finding
2 above, categorized as an ambiguity rather than an impossibility because both readings are
individually well-defined — the risk is invariant violation under one specific reading, not a
mathematical contradiction.

### Editorial/typo issues

**4. §6.4 rule 1 ("If `C` and `T` are identical, keep `C` and emit no warning") is unreachable dead text given the described control flow.**
§6.2 already filters out every `C==T` case (its own case 2) before ever invoking §6.4 (only
invoked from case 4). So §6.4 rule 1 restates a condition that can never be true when §6.4 is
reached. Harmless as defensive documentation, but confusing. Minor severity.

**5. §6.1's third tie-break key ("numeric revision") is also unreachable in the described replay algorithm.**
§6.1 lists Snap order, then author (UTF-8 order), then numeric revision, implying real ties reach
key 2/3. Tracing it: two distinct, concurrently-ready patches can only tie on key 1 if they have
different authors — but the serial-contributor rule (§3.5) guarantees only one patch per author
can ever be "ready" at once, so key 2 always resolves any key-1 tie between distinct ready
patches. Key 3 can never be exercised as a genuine tie-break. Not wrong, just vestigial. Minor
severity.

**6. §7.11's byte-literal "first applicable style" line-coloring rule can misclassify diff body lines that happen to start with header-like text.**
Quote: "the complete text of each matching line... is wrapped by the first applicable style:
`--- ` or `+++ ` uses `1`; `@@ ` uses `36`; `-` uses `31`; `+` uses `32`." This is a pure prefix
match on the rendered plain-mode line text, not a structural tag from the emitting code path. A
deleted/inserted token whose own content begins with e.g. `-- ` produces a printed line `--- ...`,
which matches the header pattern before the bare `-` deletion pattern in the stated priority
order — so a genuine deletion line would render in bold header style instead of red. Fully
deterministic (no TS/Rust/Scala divergence if all three literal-prefix-match), but contradicts the
section's own stated intent ("color is never the only signal"). No test exercises a
deleted/inserted line beginning with dash/plus-heavy content colliding with a header/hunk marker.
Severity: minor-to-moderate — narrow trigger, but a genuine spec/intent mismatch with no test
coverage.

---

## Sources

- [Wagner–Fischer algorithm (Wikipedia)](https://en.wikipedia.org/wiki/Wagner%E2%80%93Fischer_algorithm)
- [An O(ND) Difference Algorithm and Its Variations (Myers, original PDF)](http://www.xmailserver.org/diff2.pdf)
- [Myers' Diff Algorithm explained (jsdiff docs)](https://www.jsdiff.com/docs/myers-diff-algorithm.html)
- [Google Wave Operational Transformation whitepaper](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html)
- [Practical Intro to Operational Transformation](https://archive.casouri.cc/note/2025/practical-intro-ot/)
- [Chapter 3: Logical Time — Kshemkalyani & Singhal](https://www.cs.uic.edu/~ajayk/Chapter3.pdf)
- [Conflict-free Replicated Data Types (Shapiro, Preguiça, Baquero, Zawirski, 2011, PDF)](https://www.lip6.fr/Marc.Shapiro/papers/2011/CRDTs_SSS-2011.pdf)
- [Conflict-free Replicated Data Types: An Overview (arXiv 1806.10254)](https://arxiv.org/pdf/1806.10254)
- [npm `diff` package](https://www.npmjs.com/package/diff)
- [npm `fast-diff`](https://www.npmjs.com/package/fast-diff)
- [ottypes/json0 (GitHub)](https://github.com/ottypes/json0)
- [Ajv JSON schema validator](https://ajv.js.org/)
- [npm `vectorclock` (mixu)](https://www.npmjs.com/package/vectorclock)
- [MattLloyd101/ts-vector-clock (GitHub)](https://github.com/MattLloyd101/ts-vector-clock)
