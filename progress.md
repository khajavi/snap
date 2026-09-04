# Snap (TypeScript) — Implementation Progress

Tracks execution of `plan.md`'s 13 phases (0-12). Each phase's work was done
by a subagent (unless noted), then independently verified here (typecheck +
test run, plus spot-reading key files) before moving on.

Working tree: `.claude/worktrees/snap-impl` (git worktree off `master`,
branch `worktree-snap-impl`). `plan.md`/`research.md` were copied in manually
since they're untracked in the main checkout.

---

## Phase 0 — Project and dependency setup — DONE, verified

- Added `effect@^3.22.1`, `@effect/platform@^0.97.1`, `@effect/platform-node@^0.108.1`
  (runtime deps); `vitest@^3.2.7`, `@effect/vitest@^0.30.0` (dev deps).
- `tsconfig.json` `include` widened to `["src/**/*.ts", "test/**/*.ts"]`.
  `package.json` scripts: `typecheck` (`tsc --noEmit`), `build` (alias to
  `typecheck`), `test` (`vitest run`).
- `package.json` `version` bumped `0.1.0` → `1.0.0`; `commands/version-cmd.ts`
  hand-sets `VERSION = "1.0.0"` (not read from package.json).
- Runtime-entry policy: option (b) — `Effect.runPromiseExit` + manual
  `process.on("SIGINT"/"SIGTERM")` in `main.ts`, bypassing `NodeRuntime.runMain`.
- Empty `ts/src/{cli,domain,replay,fs,config,repo-store,presentation,http,errors}/`
  scaffolded (`.gitkeep`); `commands/version-cmd.ts` + minimal `main.ts` wired
  so `--version` runs end to end.
- One `it.layer` + one `it.prop` smoke test added (`test/toolchain.test.ts`).
- Verified myself: `npm run typecheck` clean; `npm test` 2/2 passed;
  `./snap --version` → exact bytes `snap 1.0.0\n`, stderr empty, exit 0.

## Phase 1 — Version/vector-clock model — DONE, verified (+ one gap backfilled)

- `domain/contributor.ts`, `domain/version.ts` built against SPEC §3.1-3.4.
  `Version` is a smart-constructor class (canonical-form invariant enforced);
  `compareVersions` (4-way: equal/before/after/concurrent), `Version.join`,
  `compareSnapOrder` (§3.4) all implemented and hand-checked against SPEC's
  literal wording (verified myself, matches exactly).
- **Gap caught during my own verification**: plan.md's Phase 1 roadmap entry
  also covers path grammar ("§3.1, §2") but my first dispatch only briefed
  contributor+version. Backfilled with a second small agent:
  `domain/path.ts` (tracked-path grammar, unsigned-UTF-8-byte comparator,
  single-patch prefix-freedom check per §2 — concurrent-replay prefix
  enforcement is explicitly left to Phase 4, not this module).
- Verified myself: typecheck clean; 164/164 tests passing
  (31 contributor + 33 version + 34 path + 2 toolchain, plus Phase 2's tests
  already landed by the time this was checked).

## Phase 2 — Canonical text diff — DONE, verified

- `domain/text.ts` (UTF-8/NUL classification, LF tokenization per §4.4),
  `domain/diff.ts` (exact `D(i,j)` recurrence + deletion-on-tie walk +
  coalescing per §5, plus an `applyEditScript` helper).
- Cross-checked against `tests/05-diff-goldens.yaml` and `tests/06-binary-and-empty.yaml`
  fixtures directly (byte-for-byte match reported).
- Verified myself: SPEC §5's recurrence/tie-break wording read side-by-side
  with the implementation description — matches exactly. Typecheck clean;
  all tests passing as part of the 164/270 running totals below.

## Phase 3 — Repository/patch data model and validation — DONE, verified

- `errors/domain-errors.ts` (shared `Data.TaggedError` hierarchy, additive —
  Precondition/Transport categories deliberately left for later phases).
- `domain/patch.ts` (Effect `Schema` shapes: contributor/path/revision/
  version-pairs/message/base64-content/edit-op/change/patch, with
  `Schema.Int` + range refinement on revision per plan.md §3's requirement).
- `domain/repository.ts` (`RepositorySchema`, causal-closure/frontier helpers).
- `replay/validate.ts` — SPEC §4.5's six-point pipeline:
  - Points 1-4, 6: **fully implemented** (schema; sorting/dot-uniqueness/
    contiguity; base-closure + revision formula; acyclic causality [DFS with
    cycle witness]; frontier replay via a genuine Kahn's-algorithm ready-set
    consumption over the base-dependency graph — no content replay needed).
  - Point 5 ("every change against its materialized exact base"):
    **honestly partial**. Only the trivial empty-`base` case is checked
    (materialized base is definitionally the empty tree, no replay needed).
    Every nonempty-base patch is skipped with an explicit
    `// TODO(Phase 4): ...` explaining that real replay machinery
    (`select.ts`+`integrate.ts`+`ot.ts`) is required for the general case,
    and why two shortcuts (duplicating replay logic; a naive ancestry walk)
    were rejected as unsound under concurrent edits. This is a deliberate,
    documented phase-boundary gap, not a hidden shortcut.
- I read `replay/validate.ts` in full myself and confirmed the six-point
  accounting matches the code exactly (DFS cycle check, Kahn's-algorithm
  consumption, empty-base-only point-5 special case all present as described).
- Verified myself: typecheck clean; 270/270 tests passing.

## Phase 4 — Deterministic replay core — DONE, verified

Per plan.md, this phase must resolve **Open Spec Issue 2** (research.md:
scope of "the paths that `P` makes present" in SPEC §6.2's namespace
precheck) by editing `SPEC.md` itself — not a code-comment workaround — and
adding the missing regression case to `tests/11-namespace-conflicts.yaml`,
*before* `replay/integrate.ts` is written.

I read SPEC §6.1-§6.5 in full myself. Diagnosis confirmed: the narrow
reading of "paths that P makes present" (only absent→present transitions,
i.e. new creates) lets an ordinary *edit* of an already-existing path skip
the ancestor/descendant namespace-conflict precheck entirely, even when a
concurrent patch structurally replaced that path's neighborhood — the
per-path fallback (§6.4 rule 3, "B present/C absent → delete-wins") would
then mislabel a structural namespace collision as an ordinary concurrent
delete, breaking the prefix-free tree invariant SPEC §2 promises.

Fix in progress (doing this part myself, not delegating — it's an edit to
the canonical contract, not implementation code):
- Reword SPEC §6.2 so `S` = every path present in `P`'s authored result
  `T` (create, edit, *or* replace), not only newly-created paths. This is
  the "wide reading" research.md identifies as invariant-preserving.
- Add a 3-repo regression case to `tests/11-namespace-conflicts.yaml`:
  common ancestor with a path already present, then a namespace-replacing
  patch on one branch concurrent with an ordinary edit of that same
  pre-existing path on another branch — asserting the wide reading's
  output.

**SPEC.md fix applied** (§6.2, "Integrating one patch"):
changed "Let `S` be the paths that `P` makes present" to "Let `S` be every
path present in `P`'s authored result — every path `P` creates, edits, or
replaces, not only paths absent from `B`." This is the wide reading —
non-conflicting edits are unaffected (the ancestor/descendant check still
only fires on a genuine structural collision), but an edit of a
pre-existing path now correctly re-enters the namespace precheck when a
concurrent patch replaced that path's neighborhood.

**Regression case added** to `tests/11-namespace-conflicts.yaml` (appended
as a third scenario in the same file, 35 steps total, YAML-validated):
common ancestor `seed-repo` commits `a/b`; branch `replaces-namespace`
(alice) deletes `a/` and creates file `a` (namespace replace); concurrent
branch `edits-preexisting-path` (bob) makes an ordinary edit to the
already-present `a/b`; merging bob's branch into alice's asserts
`warning: auto-resolved a: namespace-wins` and that `a/b` survives with
bob's edited content. Under the old narrow reading this would have
mislabeled the situation via §6.4 rule 3 (`delete-wins` on `a/b`, silently
dropping bob's edit) instead of correctly re-triggering the namespace
precheck.

Next: dispatch Phase 4's actual implementation (`replay/select.ts`,
`replay/integrate.ts`, `replay/tiebreak.ts`) as a subagent, with an early
integration-test checkpoint against the new regression case *before* Phase
5 (OT) proceeds, per plan.md §6/§7.

**Split into smaller jobs** (user request, after full-Phase-4 dispatches
kept dying to external kills / API timeouts before landing any files):
one subagent per module, independent ones in parallel, verify + commit
each as it lands:
- 4a `replay/select.ts` + tests (§6.1) — **DONE, verified, committed** (af552a0).
  18 tests. Ready-set consumption with the three-key order (Snap order of
  result version, then author bytes, then revision); the hand-traced
  pin: for two concurrent base-`()` patches, bob@x integrates before
  alice@x because Snap order compares the alice component first (0 < 1).
- 4b `replay/tiebreak.ts` + tests (§6.4) — **DONE, verified, committed** (c059338).
  30 tests. PathState model (absent/text/binary), six rules in order,
  warning-pair dedupe + sort. The rules are total; §6.2-unreachable
  combinations resolve by literal rule order (documented + pinned).
- 4c `replay/integrate.ts` + `replay/replay.ts` + namespace regression
  checkpoint test (§6.2; depends on 4a+4b) — **DONE, verified, committed**.
  10 tests (328/328 total). `integratePatch` implements the corrected
  namespace precheck + four-case dispatch with an injectable `TextTransform`
  seam (§6.3 left for Phase 5; `OtUnavailableError` when reached without
  one). `replay()` threads each patch its own exact base tree — the
  memoized sub-replay of its base version, not the running canonical tree —
  with a cycle guard. The checkpoint test asserts the corrected scenario
  (`a/b` = "edited\n", `(a, namespace-wins)`); a second test pins the
  as-written scenario's true outcome (`a` = "replaced\n", `(a/b,
  delete-wins)`) with the full ordering trace.

**Phase 4 complete**: 4a + 4b + 4c all verified and committed. The
deterministic replay core — the heart of the whole system — is done:
select (§6.1), integrate (§6.2), tiebreak (§6.4), orchestrated replay
(§6.5's same-bytes guarantee as pure-function determinism). 328/328
tests, typecheck clean.

**Bug found in my own regression scenario** (caught by the 4c agent's
hand-trace, then independently re-verified by me against 4a's committed
ordering tests): the third `tests/11-namespace-conflicts.yaml` scenario
pinned the wrong expectation. Under §6.1's Snap-order sequencing, bob's
result version is Snap-lesser than alice's at the `alice@ns` component
(0 vs 1), so the *editor* (bob) integrates first, the replacer's (alice's)
precheck never fires (her own deletion empties `C'`), and the as-written
outcome is honestly `{ a: "replaced\n" }` + `(a/b, delete-wins)`. I had
authored the scenario assuming the replacer integrates first.
**Fix applied**: swapped the contributor roles in the YAML (replacer =
bob@ns in `replaces-namespace`, editor = alice@ns in
`edits-preexisting-path`) so the replacer genuinely integrates first and
the namespace precheck fires on the editor's ordinary edit of the
pre-existing path — which is what the wide-`S` reading is FOR.
Assertions unchanged (`a/b` = "edited\n", `auto-resolved a:
namespace-wins`). The SPEC.md §6.2 wording fix itself needed no change —
only the test scenario's expectations were wrong. The 4c agent was
instructed to implement §6.2 faithfully, assert the as-written scenario's
TRUE outcome as a second test, and use the corrected scenario for the
namespace-wins checkpoint.

## Phase 5 — Operational transform — DONE, verified

Split into two per the split-subagent-work-into-small-steps memory
preference:
- 5a `replay/ot.ts`'s `transformEditThroughContext` (§6.3's pure
  transform table) + 17 tests — **DONE, verified, committed** (4dce54e).
  All six table rows, Q-insert priority, count-splitting via
  `min(P.remaining, Q.remaining)`, output coalescing. Read the module
  in full: exact match to SPEC's table.
- 5b `snapTextTransform` (composes `diff` + 5a + `applyEditScript`) +
  wiring into `replay()`'s default `textTransform` + end-to-end
  convergence tests — **DONE, verified, committed** (735fb47). 3 new
  tests (348 total): a minimal two-patch sanity case, an
  `tests/22-ot-matrix.yaml` row, and the full
  `tests/18-three-way-convergence.yaml` scenario replayed through the
  new default, converging to exactly "B\nA\nend\n" with zero warnings.
  `replay()` now performs real OT by default; the `OtUnavailableError`
  coverage moved to a direct `integratePatch` call (its own signature
  untouched) so it still exists and still passes. Read the diff myself:
  minimal, exactly as reported, no side effects on other files.

**Phase 5 complete**: 348/348 tests, typecheck clean. Deterministic
replay + OT (§6.1-§6.5) is now fully implemented and self-consistent —
no more seams or stubs in the replay core.

## Phase 6 — Filesystem materialization + working-tree scanning — DONE, verified

First phase touching real I/O and the first real Effect service in this
codebase (Phases 0-5 were pure/synchronous). Split into two parallel
jobs, both landed and read in full:
- 6a `fs/tree-scan.ts` (9afbab9): walks the tree excluding `.snap`,
  detects symlinks via `readLink` (never `stat`, which would follow
  them) plus any other non-regular entry, builds a `Tree`. Continues
  past unsupported entries rather than stopping at the first one.
  `isCleanAgainstCurrentTree` per §2's exact definition. 10 tests.
- 6b `fs/materialize.ts` + `fs/atomic-write.ts` (937e4e6): installs a
  target `Tree` onto disk by diffing against real disk state (never a
  caller-supplied previous tree — stays correct after an external
  change); handles both blocking directions (file blocks directory,
  and the reverse); prunes emptied directories deepest-first.
  `atomicWriteFile`: same-directory temp-then-rename so
  `repository.json` is never observed half-written, per §10. 10 tests.
  Two real-disk-I/O bugs the agent caught and fixed itself: Node's
  `fs.rm` needs `recursive: true` even for an empty directory, and the
  obsolete-file removal pass had to exclude paths just legitimately
  rebuilt as directories earlier in the same call.

Both use `@effect/platform`'s `FileSystem` service (`Context.Tag`),
confirmed against the real API before coding, swappable for tests.
Test convention established: `it.layer(NodeFileSystem.layer)` +
`it.scoped` + the service's own `makeTempDirectoryScoped()` for
disposable temp dirs — no `node:fs/promises` needed. 368/368 tests,
typecheck clean.

## Phase 7 — Configuration service — DONE, verified

`config/config.ts` (297cdc6): local/global contributor.id resolution
per §8. Read in full myself. Notable: `JSON.parse` silently keeps only
the last of a duplicate key, so SPEC's "non-unique field" rule needed a
hand-rolled recursive-descent JSON parser to actually be enforceable —
the agent caught this and built one rather than skipping the case.
"Object without `id`" treated same as absent `contributor` (falls
through to global) — a reasoned judgment call, documented. Required-ID
error text found pinned at `tests/19-version-boundaries.yaml:87`. 26
tests (394 total), typecheck clean.

## Phases 8-12 — NOT STARTED
8. CLI grammar, dispatch, and commands (`cli/*`, `commands/*`)
9. Presentation layer (`presentation/*`) — also resolves Open Spec Issue 6
   (§7.11 literal-prefix diff coloring) via a SPEC wording addition + new
   `tests/28-terminal-presentation.yaml` case, per plan.md.
10. HTTP serve + HTTP repository loading (`http/*`, `repo-store/http-source.ts`)
11. Cross-cutting hardening + full-suite convergence — also resolves Open
    Spec Issue 3 (§7.6 text/binary diff classification) via a SPEC wording
    addition + new `tests/06-binary-and-empty.yaml` case.
12. Property-based convergence tests + polish (editorial Open Spec Issues 1, 5)

---

## Running verification totals

| After phase | typecheck | tests passing |
|---|---|---|
| 0 | clean | 2/2 |
| 1 (+ path backfill) | clean | 164/164 |
| 2 | clean | 164/164 (included above; ran concurrently with Phase 1) |
| 3 | clean | 270/270 |
| 4 (a+b+c) | clean | 328/328 |
| 5 (a+b) | clean | 348/348 |
| 6 (a+b) | clean | 368/368 |
| 7 | clean | 394/394 |
