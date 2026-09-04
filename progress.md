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

## Phase 4 — Deterministic replay core — IN PROGRESS

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

## Phases 5-12 — NOT STARTED

5. Operational transform (`replay/ot.ts`)
6. Filesystem materialization + working-tree scanning (`fs/*`)
7. Configuration service (`config/*`)
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
