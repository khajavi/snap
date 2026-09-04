# Snap (TypeScript) — Implementation Plan

This is a high-level roadmap for building the TypeScript edition of `snap`
against `SPEC.md`, using **TypeScript + Effect TS** as mandated. It
supersedes the scaffold's original "zero runtime dependencies" assumption:
Effect and its platform companions are now the runtime dependency set. No
code, function signatures, or test-case names appear below; this is a plan
for a contributor to start from, not a spec restatement.

Read `SPEC.md` and `research.md` before starting. `research.md`'s "Open
Spec Issues" section is referenced throughout below where it touches
sequencing or risk — those issues are **not resolved here** (no wording
decision is made in this plan), but per `AGENTS.md`'s actual rule ("correct
the spec first, or in the same commit, and add a regression case to the
public YAML suite — do not silently make the implementation authoritative"),
every phase below that touches an Open Spec Issue schedules **editing
`SPEC.md` and adding the missing `tests/*.yaml` case**, not merely leaving a
code comment. A comment documenting *why* a wording change was made is fine
supporting detail; a comment substituting *for* the spec/test fix is not
what this plan calls for.

Two contract sources, not one: `SPEC.md` is normative for *behavior*, but
several exact byte strings graded by the acceptance suite (stderr/stdout
literals, the `--version` string, JSON key order and indentation) are only
pinned in `tests/*.yaml`, not spelled out in SPEC's prose. Any phase that
implements user-visible text must check the relevant `tests/*.yaml` files
for the literal expected bytes, not just SPEC.md's descriptive text.

---

## 1. Architecture

### 1.1 Layering philosophy

Snap's logic splits cleanly into a **pure core** (no I/O: version algebra,
diff, OT, tie-break rules, schema shapes) and a **service shell** (I/O:
filesystem, config files, HTTP, process argv/env/console). Effect TS is
used to make that boundary explicit and enforced by the type system rather
than by convention:

- The pure core is ordinary synchronous TypeScript functions and value
  types. Where they can fail validation, they return typed results (or are
  wrapped in `Effect.Effect` only at the point they're invoked from
  service code) — the recurrences themselves (canonical diff, OT
  transform, tie-break resolution) don't need Effect's concurrency or
  dependency-injection machinery, only its error-typing discipline where
  they surface failures.
- Everything that touches the outside world — reading/writing
  `.snap/repository.json` and `.snap/config.json`, scanning and mutating
  the working tree, performing one HTTP GET, running the `--serve` HTTP
  server, reading argv/env and writing stdout/stderr — is modeled as an
  **Effect service** (a `Context.Tag`/`Context.Service` interface with a
  corresponding `Layer` implementation). Command modules are `Effect`
  programs that only *request* these services; they never import
  `node:fs` or `node:http` directly.
- `main.ts` is the only place that assembles the full `Layer` graph (real
  Node filesystem, real HTTP client/server, real process console/argv/env)
  and runs a command's `Effect` against it. This makes every command
  swappable onto fake/in-memory layers for tests without touching command
  logic.

### 1.2 Error modeling

Every failure mode in the spec is a distinct tagged error type (using
`Data.TaggedError` for internal domain errors that need discriminated
`catchTag`-style handling, and `Schema.TaggedError` specifically where a
decoded/validated shape and its failure need to travel together, e.g.
repository/config JSON decoding). Broad categories:

- **Parse/grammar errors** — malformed version syntax, malformed CLI
  invocation, malformed `SNAP_COLOR`.
- **Validation errors** — repository JSON schema violations, causal
  validation failures (cycles, gaps, dot collisions, base mismatches),
  invalid contributor IDs/paths/messages.
- **Precondition errors** — dirty/clean tree violations, missing
  contributor configuration, unknown/not-locally-known version, "already
  current" revert, unsupported filesystem entries.
- **Corruption errors** — same dot with structurally different patch
  values, either locally or discovered while cross-checking another
  repository during `merge`/`diff --repo`.
- **Transport errors** — HTTP non-200, non-JSON body, connection failure.

A single top-level error union is mapped, once, at the CLI boundary in
`main.ts` to SPEC §10's exit codes: every one of the above categories is an
*expected* error (exit 1, printed as `snap: <detail>` in the selected
presentation); anything else (a defect, an assertion failure, an unhandled
exception surfaced through Effect's defect channel) is exit 2. This keeps
every command module honest about what can go wrong (it's in the
`Effect<..., E>` error type) while keeping exit-code policy in one place.

The `<detail>` text itself is a second contract, sourced from `tests/*.yaml`
(`stderr_equals`/`stderr_contains` assertions), not invented at
implementation time: several exact messages (e.g. `"invalid command or
arguments"`, `"not a Snap repository"`, `"invalid port: <n>"`, `"invalid
contributor id"`, `"invalid JSON"`, `"unknown version"`) are pinned by the
suite but not quoted verbatim in SPEC.md's prose. `errors/domain-errors.ts`
must carry these literal strings (or the exact substrings the suite
matches), and the unit tests in §4 level 1 must assert them directly
against the YAML files' text, not a paraphrase, so drift is caught before
the acceptance suite runs.

**Process lifecycle.** `main.ts` must not lean on
`@effect/platform-node`'s `NodeRuntime.runMain` defaults uncritically: by
default it installs its own SIGINT teardown handling and renders uncaught
failures in Effect's own pretty-printed log format, neither of which
matches SPEC §10's `snap: <detail>` line or §7.9's `--serve` shutdown
contract (exit 0 on SIGINT/SIGTERM with no extra output). The plan is
either (a) supply `runMain`'s `teardown` hook to fully own error rendering
and exit-code assignment instead of its default, or (b) bypass `runMain`
and drive the top-level `Effect` with `Effect.runPromiseExit` plus
`main.ts`'s own `process.on("SIGINT"/"SIGTERM", ...)` handling. `serve.ts`
in particular owns its own signal handling per §7.9 rather than relying on
Effect's generic fiber interruption, since the required behavior (finish
in-flight response, then exit 0) is a specific product requirement, not
"whatever interrupting the fiber happens to do."

### 1.3 Composition and dispatch

`main.ts`'s flow: read `argv`/`env` → resolve presentation mode (§7.11,
validated before any command runs, since an invalid `SNAP_COLOR` is itself
a plain-mode error that pre-empts execution) → parse the command line into
a typed command value → build the `Layer` for the services that specific
command needs (not every command needs every service — `--version` needs
none, `status` doesn't need HTTP, `--serve` doesn't need the diff/OT core)
→ run the corresponding command's `Effect` program → render its success or
failure through the presentation layer → set `process.exitCode`.

Command modules are the seam between the CLI and the domain/service
layers: each one is a short Effect program that (a) asks for exactly the
services it needs, (b) calls into the pure core for any algorithmic work,
and (c) returns a small structured result value for the presentation layer
to render — command modules never format output strings themselves, so
plain/terminal rendering stays centralized and consistent.

---

## 2. Code organization

Proposed layout under `ts/src/`. Each entry is one responsibility, not an
API sketch.

```
ts/src/
  main.ts                     Process entrypoint: wires argv/env, builds the
                               Layer graph, runs the dispatched command,
                               maps its outcome to stdout/stderr + exit code.

  cli/
    args.ts                   Hand-rolled grammar-driven parser: turns argv
                               into a typed command value or a typed parse
                               error (unknown option, missing operand, wrong
                               option position, extra operand).
    dispatch.ts                Maps a parsed command value to its command
                               module and the Layer subset it requires.
    exit.ts                    Central mapping from the top-level error union
                               (and presentation-mode errors) to exit codes.

  domain/
    contributor.ts             Contributor-ID grammar validation (§3.1).
    version.ts                 Vector clock type: canonical parse/print,
                               four-way comparison, join, Snap order (§3.2–3.4).
    path.ts                    Tracked-path grammar and prefix-free tree
                               invariant checks (§2).
    text.ts                    UTF-8/NUL text classification and LF
                               tokenization/canonicalization (§4.4).
    diff.ts                    Canonical token diff recurrence and script
                               coalescing (§5), reused by commit, diff, and OT.
    patch.ts                   Patch and change-variant value shapes, dot
                               identity, message validation (§4.2–4.3).
    repository.ts              Repository JSON value shape (via Schema),
                               causal closure/frontier helpers (§4.1).

  replay/
    validate.ts                Full repository validation pipeline (§4.5):
                               schema, sorting/contiguity, base closure,
                               acyclicity, per-change base checks.
    select.ts                  Patch selection for a target version and the
                               ready-set/Snap-order integration sequence (§6.1).
    integrate.ts               Single-patch integration: namespace-conflict
                               precheck (S/C'), per-path case dispatch (§6.2).
    ot.ts                      Text edit transform against an aggregate
                               context edit (§6.3).
    tiebreak.ts                Path-level winner rules and warning-pair
                               emission (§6.4).
    replay.ts                  Orchestrates select + integrate (+ ot/tiebreak)
                               over a patch set into a final tree and warning
                               set; the one function every tree-producing
                               command goes through.

  fs/
    tree-scan.ts               Working-tree scan respecting the `.snap`
                               exclusion; detects unsupported entries
                               (symlinks, etc.) and builds a path/byte map.
    materialize.ts             Installs a target path/byte map onto disk:
                               removes blocking paths, creates directories,
                               writes files, prunes newly empty directories.
    atomic-write.ts             Same-directory temp-file replace for
                               `repository.json`, per §10's write ordering.

  config/
    config.ts                  Local/global config service: load/validate/
                               write `.snap/config.json` and
                               `$HOME/.snapconfig.json`, local-over-global
                               precedence, missing-identity error.

  repo-store/
    locate.ts                  Nearest-repository lookup by walking to the
                               filesystem root.
    store.ts                   Repository load/validate/save service backed
                               by the filesystem service. Owns the one
                               canonical repository-JSON encode function
                               (key order, indentation) also reused by
                               `http/serve.ts`, so the on-disk file and the
                               `--serve` HTTP body can never independently
                               drift from each other's byte layout.
    http-source.ts             Loads and validates a repository from an
                               `http://`/`https://` URL (single GET, status
                               and shape checks) without importing it.

  commands/
    init.ts, config-cmd.ts, status.ts, log.ts, commit.ts, diff-cmd.ts,
    revert.ts, merge.ts, serve.ts, version-cmd.ts
                               One Effect program per CLI command, each
                               composed only from the domain/replay/fs/
                               config/repo-store services it needs.

  presentation/
    mode.ts                    Resolves plain vs terminal presentation from
                               `SNAP_COLOR`/`NO_COLOR`/TTY detection (§7.11),
                               including the pre-execution `SNAP_COLOR` error.
    ansi.ts                    Shared `S(code, text)` styling helper.
    render.ts                  Per-command renderers (status/log/diff/commit
                               /revert/merge/version/warnings/errors) that
                               consume command result values and the resolved
                               mode, producing exact plain or terminal bytes.

  http/
    serve.ts                   `--serve` HTTP server: startup snapshot
                               (serialized once via `repo-store/store.ts`'s
                               canonical encoder and reused for every
                               response, never re-encoded per request),
                               127.0.0.1 binding and port selection, GET/HEAD
                               `/repository.json`, 404/405 handling, and its
                               own SIGINT/SIGTERM handling (exit 0 after the
                               in-flight response finishes) rather than
                               Effect's default interrupt behavior.

  errors/
    domain-errors.ts           Shared tagged-error hierarchy used across
                               domain/replay/fs/config/repo-store/http, plus
                               the expected-vs-defect classification consumed
                               by `cli/exit.ts`.
```

Test files live alongside this layout under `ts/test/` (or colocated,
per whatever convention `ts/AGENTS.md` ends up recording), mirroring the
same module boundaries — see §4.

---

## 3. Chosen technologies

- **TypeScript, strict mode** — already scaffolded (`ts/tsconfig.json`);
  no change needed beyond continuing to avoid `any` per `ts/AGENTS.md`.

- **Effect (the `effect` package, current stable line)** — the mandated
  functional core. Used for: `Effect` to type every fallible/service-using
  computation; `Context`/`Layer` for dependency injection of the
  filesystem, config, repository-store, and HTTP services described above,
  so command logic never talks to `node:fs`/`node:http` directly and every
  service is replaceable in tests; `Data.TaggedError`/`Schema.TaggedError`
  for the error hierarchy in §1.2, giving exhaustive, discriminated error
  handling instead of stringly-typed `Error` subclasses. The stable
  released line is preferred over the `4.0.0` pre-release/RC line seen in
  current docs, since this project needs a settled, well-documented API
  surface rather than a moving migration target.

- **`@effect/platform` + `@effect/platform-node`** — supplies Effect-native
  `FileSystem`, `Path`, and `HttpServer`/`HttpClient` services with Node
  backends. Justification: it gives the filesystem and HTTP boundaries the
  same testable-service treatment as the rest of the app (a repository
  store or working-tree scanner can be tested against a fake/no-op
  `FileSystem` layer instead of a real temp directory when a test doesn't
  need real I/O), and lets `--serve` and the HTTP repository loader be
  built on `HttpRouter`/`HttpServerResponse`/`HttpClient` instead of a
  hand-rolled `node:http` server — while still satisfying `ts/AGENTS.md`'s
  preference for Node built-ins, since platform-node's implementation is
  exactly that, wrapped in an Effect-shaped interface.

- **Effect's `Schema` module** — used to declare the `repository.json` and
  config JSON shapes (frontier, patches, change variants, config object)
  declaratively, producing structured decode failures that map directly
  onto SPEC §4.5's "unknown fields, non-integer numbers, and invalid typed
  values are errors" requirement. Numeric fields (revision, port) use an
  explicit `Schema.Int` plus a safe-range refinement (not a bare
  `Schema.Number`), since SPEC §3.1/§4.5 requires rejecting non-integer or
  out-of-range values and Effect's default number schema would silently
  accept `2.5` or a value beyond `Number.MAX_SAFE_INTEGER`. Schema handles
  the *shape* layer only; the *causal* layer (closure, contiguity,
  acyclicity, base-consistency, replay-based validation) is bespoke logic
  in `replay/validate.ts`, since no generic schema tool models causal graph
  validity — this matches research.md's note that `ajv`-style tools "inform
  API shape only." Encoding back to JSON for disk/HTTP output goes through
  one canonical, hand-verified encode path (see §2's `repo-store/store.ts`)
  rather than trusting `Schema.encode`'s struct-field order to stay stable
  across Effect versions — that ordering is locked down by a golden-byte
  test (see §5, "Repository interoperability readiness") rather than
  assumed.

- **Hand-rolled CLI argument parsing, not `@effect/cli`** — a deliberate
  deviation from the obvious "look up `@effect/cli`, use it" path. The
  decisive reason is structural, not cosmetic: SPEC §9's grammar is
  **positional** — options are only valid in specific fixed slots and may
  appear at most once (confirmed by `tests/24-cli-grammar-matrix.yaml`'s
  failure cases for a correctly-spelled option used in the wrong position,
  or repeated) — while `@effect/cli`'s `Options`/`Flag`/`Param` model is
  fundamentally position-independent flag parsing (options are recognized
  by identity anywhere on the line). Bending that model to reject
  position/repetition errors it isn't designed to detect would cost more
  than it saves. The secondary reason still holds as a supporting point:
  `@effect/cli` generates its own help/usage/error text, which would need
  overriding everywhere to match SPEC's byte-exact `snap: <detail>` and
  `--serve` startup lines. `cli/args.ts` is instead a small Effect-idiomatic
  parser (returns `Effect`/tagged errors, composes with the rest of the app
  the same way every other module does) purpose-built for snap's
  eight-command, position-fixed grammar.

- **`vitest` + `@effect/vitest`** — test runner. `@effect/vitest` adds
  `it.effect`/`it.layer` (run a test with Effect test services and a
  shared, memoized `Layer`, letting service-level tests inject fake
  filesystem/config/HTTP layers cleanly) and `it.prop` (property-based
  testing via generators, directly supporting research.md's recommendation
  to property-test import-permutation convergence). This is a deliberate
  deviation from the `tsx --test` (Node's built-in test runner) precedent
  used elsewhere in this workshop (`test-harness/`, other capstones) — a
  deviation only Effect's own layer-memoization and property-testing
  helpers justify, and one that must be resolved, not deferred, at Phase 0:
  (a) test files under `ts/test/` sit outside `ts/tsconfig.json`'s
  `include: ["src/**/*.ts"]`, so Phase 0 either widens that `include` to
  cover `test/**/*.ts` or adds a second `tsconfig.test.json`, and either
  way wires a `typecheck` script that actually runs `tsc --noEmit` over the
  test tree — vitest's default esbuild transform does not type-check, so
  without this step tests silently escape `ts/AGENTS.md`'s strict-mode
  gate; (b) Phase 0's exit criterion includes one passing `it.layer` test
  and one passing `it.prop` test, proving ESM interop with the project's
  `moduleResolution` setting before any real logic is built on top of the
  runner. `tsx` remains the dev runner for `npm start`/the `snap` launcher
  script, unchanged.

- **`--version` output string** — SPEC ties `--version` to a single
  canonical semver string; `tests/28-terminal-presentation.yaml` pins the
  literal bytes `snap 1.0.0`. This must be a hand-set constant `commands/
  version-cmd.ts` owns directly, not a read of `ts/package.json`'s
  `version` field (currently `0.1.0`) — Phase 0 reconciles this explicitly
  (either bump the scaffold's `package.json` version to match, or decouple
  the printed string from it entirely) rather than leaving it to be
  discovered as a test failure.

- **No other runtime dependencies** — the diff recurrence, OT transform,
  and tie-break rules are hand-rolled per SPEC's exact-byte requirements
  (per research.md, `diff`/`fast-diff`/`ot.js`/`vectorclock` are algorithm
  references only, not drop-ins); Effect and its two platform/tooling
  companions above are the only additions to the scaffold's original
  dependency set, consistent with `ts/AGENTS.md`'s minimal-dependency,
  Node-built-ins-first spirit.

---

## 4. Testing hierarchy

Five complementary levels, from fastest/narrowest to slowest/most
authoritative:

1. **Pure-logic unit tests** (`vitest`, no services). Exercise
   `domain/*` and the pure parts of `replay/*` (diff recurrence, OT
   transform table, tie-break rules, version algebra, text tokenization)
   directly against SPEC's literal worked examples. Fast, exhaustive,
   table-driven; the first line of defense for algorithmic correctness.
   This level also owns pinning literal user-visible text (error strings,
   the `--version` string, JSON key order/indentation) against the actual
   bytes in `tests/*.yaml`, since — per the note at the top of this plan —
   those are not fully specified in SPEC.md's prose and must be sourced
   from the acceptance suite directly.

2. **Service-level integration tests** (`@effect/vitest`'s
   `it.effect`/`it.layer`). Exercise `replay/validate.ts`/`replay.ts`,
   `fs/*`, `config/*`, and `repo-store/*` wired to either the real
   `@effect/platform-node` filesystem (against a disposable temp
   directory) or a fake/no-op layer, and the HTTP client/server pair
   against `@effect/platform`'s in-memory or loopback test layer. Verifies
   Effect service wiring and cross-module composition without going
   through the argv/process boundary.

3. **In-process CLI smoke tests** (optional, developer-facing only).
   Invoke `cli/dispatch.ts` directly with an in-memory argv/console/
   filesystem layer to sanity-check exact stdout/stderr strings and
   exit-code mapping quickly during development. Explicitly not a
   substitute for level 5 — `AGENTS.md` is explicit that language-specific
   tests "cannot replace the shared acceptance suite."

4. **Property-based tests** (`@effect/vitest`'s `it.prop`, generator-based).
   Implements research.md's recommendation directly: generate valid causal
   patch graphs and assert that different import/merge permutations
   converge to the same joined frontier, patch set, warning set, and tree.
   This is the only level that goes beyond the fixed example set to probe
   the CRDT convergence guarantee (§6.5) broadly.

5. **Black-box YAML acceptance suite** (`tests/*.yaml`, run via
   `./verify --lang ts`). Canonical, language-neutral, process-level, and
   — per `AGENTS.md` — the authoritative public contract; every
   implementation phase below ends by running it. Levels 1–4 exist to
   make failures here fast to localize (a YAML failure plus a passing
   unit-test suite points straight at the untested seam), not to replace
   it.

---

## 5. Testing domains

Distinct categories of functional/regression risk to keep covered across
the levels above (categories of concern, not specific tests):

- **Vector clock / version algebra** — canonical syntax parse/print,
  four-way comparison (`=`, `<`, `>`, `||`), join laws, Snap order.
- **Contributor ID and path grammar** — email-shaped ID rules, tracked-path
  rules, prefix-free tree enforcement.
- **Canonical diff recurrence correctness** — repeated lines, deletion
  ties, coalescing, empty-file edge cases.
- **OT transform correctness** — every pairwise table case, multi-patch
  concurrent sequences, aggregate-context-edit composition.
- **Repository/patch schema and causal validation** — unknown fields,
  non-integer numbers, dot collisions, cycles, gaps, base-closure
  mismatches, per-change base consistency.
- **Replay/materialization determinism** — patch selection and
  integration ordering, permutation invariance, filesystem installation
  correctness (blocking-file removal, directory creation/pruning).
- **Namespace and path-level conflict resolution** — all six §6.4 winner
  rules, ancestor/descendant namespace collisions, warning selection and
  ordering. Note: this domain directly touches Open Spec Issue 2 (scope of
  "paths P makes present" for the namespace precheck). Per this plan's
  intro, the fix is to resolve the wording in `SPEC.md` itself (choosing
  the reading that preserves the prefix-free tree invariant §2 promises)
  and add the missing regression case research.md already identified — an
  edit landing on a path whose ancestor/descendant was namespace-replaced
  by an unrelated, previously-integrated patch — as a new case in
  `tests/11-namespace-conflicts.yaml`, before `replay/integrate.ts` is
  written against it (see Phase 4).
- **Filesystem materialization and working-tree scanning** — dirty
  detection, unsupported-entry rejection (symlinks, FIFOs), clean/dirty
  status codes.
- **Configuration precedence** — local-over-global resolution, missing
  identity error, malformed/unknown-field config rejection.
- **CLI argument grammar** — fixed option positions, at-most-once options,
  unknown option/operand errors, missing option values, exit-code mapping.
- **Command semantics** — `init`/`status`/`log`/`commit`/`diff`/`revert`/
  `merge` behavior, additive-only revert, no-op merge/errors, and §10's
  validate-before-mutate ordering.
- **Cross-repository and HTTP diff/merge** — URL vs local-path resolution,
  cross-repository dot-collision corruption detection, HTTP GET status/body
  handling. Note: Open Spec Issue 3 (§7.6 never states a text-vs-binary
  classification rule for a path whose type differs across the two diffed
  sides) touches `commands/diff-cmd.ts` — resolve by adding the missing
  rule to `SPEC.md` §7.6 (stating explicitly whether classification depends
  on the old side, the new side, or both, mirroring or deliberately
  diverging from §7.5's commit rule) and adding a text↔binary-transition
  case to `tests/06-binary-and-empty.yaml`, before implementing.
- **HTTP serve mode** — startup snapshot semantics (one canonical encode,
  reused per response, never re-serialized per request), GET/HEAD,
  404/405, loopback-only binding and port selection, and bespoke (not
  Effect-default) SIGINT/SIGTERM shutdown.
- **Plain vs terminal presentation** — `SNAP_COLOR`/`NO_COLOR` precedence,
  auto-TTY detection per stream, exact ANSI byte layout per output family.
  Note: Open Spec Issue 6 (literal-prefix diff line coloring can
  misclassify a deleted/inserted line that itself starts with header-like
  text) — the rule itself stays a literal prefix match (changing it would
  itself be a behavior change needing its own spec/test update, and the
  trigger condition is narrow); the fix here is adding SPEC.md wording that
  acknowledges the precedence explicitly (so it reads as intended, not as
  an oversight) and a regression case in `tests/28-terminal-presentation.yaml`
  covering a deleted/inserted line beginning with dash/plus-heavy content,
  so the literal behavior is pinned rather than merely implied.
- **Exact user-visible text** — stderr/stdout literal strings, the
  `--version` string, and warning-line text, sourced from `tests/*.yaml`
  where SPEC.md's prose doesn't spell out the exact bytes (see this plan's
  intro and §4 level 1).
- **Repository interoperability readiness** — byte-for-byte JSON shape and
  ordering compatibility between the on-disk `repository.json` and the
  `--serve` HTTP body, backed by a single canonical encoder (§2, §3) and
  locked down by a golden-byte test, not assumed from `Schema.encode`'s
  default behavior. Also covers integer-range/non-integer rejection for
  revision and port fields (`Schema.Int` + range refinement, §3).

---

## 6. Implementation roadmap

Phased so that foundational, low-risk-of-rework logic lands before logic
that depends on it, and so every phase ends with a runnable, testable
increment. Each phase's exit criterion includes running the relevant slice
of `./verify --lang ts` (full suite once commands exist; before that, the
levels-1–2 tests from §4).

**Phase 0 — Project and dependency setup.**
Add `effect`, `@effect/platform`, `@effect/platform-node`, `vitest`, and
`@effect/vitest` to `ts/package.json`. Concrete deliverables, not a
"confirm they coexist" check: (a) widen `ts/tsconfig.json`'s `include` to
cover the test tree (or add a `tsconfig.test.json`) and wire a `typecheck`
script running `tsc --noEmit` over it, since vitest's esbuild transform
skips type-checking; (b) reconcile the `--version` string now, per §3 —
either bump `ts/package.json`'s `version` off `0.1.0` to match the
test-pinned `snap 1.0.0`, or decouple `commands/version-cmd.ts`'s printed
constant from that field entirely; (c) decide and record `main.ts`'s
runtime-entry policy per §1.2's "Process lifecycle" note — `runMain` with
an owned `teardown` hook, or `Effect.runPromiseExit` plus manual
SIGINT/SIGTERM handlers — before any command wiring depends on how the
process exits. Stand up the empty directory layout from §2 and a minimal
`Layer`-wiring skeleton in `main.ts` that can at least run `--version` end
to end. Exit criterion: one passing `it.layer` test and one passing
`it.prop` test (proving ESM/`moduleResolution` interop), `typecheck`
passing over both `src/` and the test tree, and `--version` printing the
exact test-pinned bytes end to end.

**Phase 1 — Version/vector-clock model.**
Canonical version syntax parse/print, four-way comparison, join, and Snap
order (§3.2–3.4), plus contributor-ID and path grammar validation
(§3.1, §2). This is the most foundational data type — everything else
(patches, frontiers, replay ordering) is built on top of it — and it has
no dependency on filesystem or Effect services, so it can be fully
unit-tested in isolation first.

**Phase 2 — Canonical text diff.**
The §5 recurrence, token splitting/canonicalization (§4.4), and script
coalescing, hand-traced against SPEC's worked examples and research.md's
Wagner–Fischer framing. Pure and dependency-free like Phase 1; needed by
both `commit`'s patch authoring and later OT integration, so it should be
solid before either depends on it.

**Phase 3 — Repository/patch data model and validation.**
Repository/patch/change JSON shapes via Schema (§4.1–4.3), and the
structural + causal validation pipeline (§4.5): schema shape, sorting and
per-dot uniqueness, contiguous per-contributor revisions, base closure,
acyclicity. No replay/materialization yet — this phase proves a repository
value can be loaded, validated, and rejected correctly, independent of
producing a tree.

**Phase 4 — Deterministic replay core.**
Patch selection and ready-set/Snap-order integration sequencing (§6.1),
then single-patch integration (§6.2): namespace-conflict precheck and the
per-path case dispatch, landing in the path-level tie-break rules (§6.4)
for the non-text/structural cases. This is the highest-risk correctness
area and the point where Open Spec Issue 2 (namespace-precheck scope) must
be resolved first, not deferred: correct `SPEC.md` §6.2's wording (the
reading that preserves the prefix-free tree invariant §2 promises) and add
the missing ancestor/descendant-edit regression case to
`tests/11-namespace-conflicts.yaml` before writing `replay/integrate.ts`
against it. Before Phase 5 proceeds, run that specific new case as an
integration test against Phase 4's implementation as an early checkpoint
— don't wait for Phase 8's first full-suite run to discover the
namespace-precheck scope was wrong, since Phase 5 (OT) and every
tree-producing command from Phase 6 onward builds directly on this
module.

**Phase 5 — Operational transform.**
The §6.3 transform of an incoming text edit against an aggregate context
edit, wired into Phase 4's replay as the text/text concurrent case. Kept
as its own phase because it's algorithmically distinct from Phase 4's
structural rules and benefits from its own focused pairwise-case test
pass (per SPEC §11 item 4) before being integrated.

**Phase 6 — Filesystem materialization and working-tree scanning.**
Installing a replay result onto disk (blocking-path removal, directory
creation/pruning) and scanning a working directory into a path/byte map
with unsupported-entry detection, both as `@effect/platform-node`-backed
services. This is the first phase that touches real I/O and should prove
out the FileSystem-service testing approach (real temp dir vs. fake layer)
described in §4 level 2.

**Phase 7 — Configuration service.**
Local/global config load, validate, and write, with local-over-global
precedence and the missing-identity error path (§8). Small and
self-contained; sequenced here because `commit`/`revert` (Phase 8) need it
immediately and it has no dependency on replay.

**Phase 8 — CLI grammar, dispatch, and commands.**
The hand-rolled argument parser (§1.3/§3 tech-stack justification) and the
eight command modules, each composed from the services built in Phases
1–7: `init`, `config`, `status`, `log`, `commit`, `diff` (local and
`--repo` cross-repository), `revert`, `merge`. Implement §10's
validate-before-mutate ordering and atomic `repository.json` replacement
here. This is the phase where the full `./verify --lang ts` suite first
becomes meaningfully runnable end to end (minus `--serve` and terminal
presentation, still plain-only).

**Phase 9 — Presentation layer.**
Retrofit plain/terminal dual output (§7.11) across every command built in
Phase 8: `SNAP_COLOR`/`NO_COLOR` resolution and its pre-execution error,
the ANSI styling helper, and per-command renderers. Sequenced after
commands exist (not interleaved with Phase 8) so command logic and output
formatting stay decoupled per §1.3, and so the byte-exact terminal-mode
acceptance tests (SPEC §11 item 12, `tests/28-terminal-presentation.yaml`)
have real command output to render. Before implementing, correct
`SPEC.md` §7.11's wording per Open Spec Issue 6 to state the
literal-prefix precedence explicitly (it stays a literal prefix match —
changing the rule itself would be its own behavior change), and add the
dash/plus-heavy deletion/insertion-line regression case to
`tests/28-terminal-presentation.yaml`; implement against that corrected
wording and new case, not a bare unexplained literal match.

**Phase 10 — HTTP serve and HTTP repository loading.**
`--serve`'s startup-snapshot HTTP server (GET/HEAD, 404/405, loopback
binding, bespoke SIGINT/SIGTERM shutdown per §1.2's "Process lifecycle"
note — exit 0 after the in-flight response finishes, not Effect's default
fiber-interrupt behavior) and the HTTP repository source used by
`diff --repo`/`merge` with an `http(s)://` operand. The startup snapshot
must be serialized once through `repo-store/store.ts`'s canonical encoder
(§2, §3) and reused for every response, never re-encoded per request, so
the HTTP body and the on-disk file can never independently drift. Sequenced
last among functional phases since it's the most isolated command (no
interaction with the working tree or config) and depends only on the
already-built repository validation and presentation layers.

**Phase 11 — Cross-cutting hardening and full-suite convergence.**
Run the complete `tests/*.yaml` suite repeatedly, closing gaps: exact
error text and exit codes across every command, CLI grammar edge cases
(§11 item on validation matrices), dirty-tree refusal ordering, and Open
Spec Issue 3 (§7.6's text/binary classification for mixed-type diffs) —
resolved by correcting `SPEC.md` §7.6 itself and adding the
text↔binary-transition case to `tests/06-binary-and-empty.yaml`, per §5,
before `commands/diff-cmd.ts`'s classification logic is finalized here.
Treat every YAML failure as pointing at a missing or wrong unit/integration
test in levels 1–2, per §4, and backfill that test alongside the fix.

**Phase 12 — Property-based convergence tests and polish.**
Add the `it.prop`-based import-permutation convergence tests recommended
by research.md, covering replay/merge order-independence beyond the fixed
YAML cases. Use this phase also to sweep for the two purely editorial
Open Spec Issues (1 and 5) — no behavior change needed, just confirm the
implementation doesn't accidentally depend on the vestigial/misdirected
text they describe (e.g. don't rely on §6.4 rule 1 or §6.1's third
tie-break key ever being reachable).

---

## 7. Sequencing rationale

The order above is deliberately "pure and foundational first, I/O and
presentation last": Phases 1–5 (version algebra, diff, schema/validation,
replay, OT) are pure functions over in-memory values and carry the
project's real algorithmic risk (SPEC §11 items 1–5), so they get built
and unit-tested before any filesystem or CLI code exists to obscure a bug
under process-level noise. Phase 4 also carries the plan's one deliberately
early full-stack checkpoint: Open Spec Issue 2's corrected reading and its
new regression case are validated against the actual replay implementation
right after Phase 4, not left to surface at Phase 8's first full-suite run
— by then Phase 5 (OT) and Phases 6–10 would already have been built on
top of whichever interpretation turned out wrong, at four phases' worth of
rework cost. Phases 6–7 introduce I/O but stay command-agnostic. Phase 8 is where these combine into the actual product
surface, and only after commands exist does Phase 9 add the
presentation concern SPEC is careful to say must never change execution
semantics (§7.11) — building it earlier would risk conflating output
formatting bugs with logic bugs. HTTP (Phase 10) is deferred because it's
the most self-contained command and least likely to reveal foundational
issues. Hardening and property testing (11–12) close out because they
depend on everything else existing.
