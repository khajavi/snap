# Snap

> This project is the capstone project of the [Ziverge Vibe Coding 2.0](https://www.eventbrite.com/e/ziverge-vibe-coding-20-tickets-1994870490337)
> workshop.

Snap is a small local version control system built around vector-clock
versions, patch replay, and deterministic automatic merging. It is deliberately
compact: eight everyday commands plus a read-only HTTP mode, with most of the
challenge concentrated in exact semantics and correctness.

Interactive output is designed for humans: status and history have readable
layouts, diffs use semantic colors, and successful operations, warnings, and
errors have distinct symbols. Redirected output stays plain and byte-stable for
scripts. Set `SNAP_COLOR=always` to preserve the terminal presentation through
a pipe, `SNAP_COLOR=never` to disable it, or `NO_COLOR=1` for Snap's
conservative plain-output opt-out.

## At a glance

- **Focus:** causal modelling, canonical data formats, deterministic diffs,
  operational transform, filesystem materialization, and process-level tests.
- **Expected difficulty:** high, but slightly smaller than TabbyShell. The CLI
  is narrow; replay, conflict rules, and validation require care.
- **Prerequisites:** Node.js for the public harness and the toolchain for the
  implementation language. Snap itself uses no API key or network service.
- **Languages:** TypeScript, Rust, and Scala. Every edition is checked by the
  same language-neutral suite. The **TypeScript edition is complete**: all 28
  acceptance scenarios pass, backed by 431 unit tests including
  property-based replay-convergence testing.

## What's here

- [`SPEC.md`](SPEC.md) — the canonical behavioral contract.
- [`tests/`](tests/) — language-neutral YAML acceptance tests (28 scenarios).
- [`TEST-HARNESS.md`](TEST-HARNESS.md) and [`test-harness/`](test-harness/) —
  the extensible process/filesystem/HTTP test format and driver.
- [`ts/`](ts/) — the TypeScript implementation (Effect-based; the reference
  edition, complete and verified).
- `run` — the bundled launcher; it selects the most recently modified
  available language implementation, or accepts `--lang`.
- `verify` — the public acceptance-test entry point.
- [`flake.nix`](flake.nix) — Nix packaging: install the CLI with
  `nix profile install github:khajavi/snap` (or `nix profile install .#`
  from a checkout) and get a self-contained `snap` on your PATH; a
  `nix develop` shell provides Node for working on the implementation.
- [`progress.md`](progress.md) — phase-by-phase implementation log with
  verification totals.
- [`plan.md`](plan.md) — the 13-phase implementation plan and its sequencing
  rationale; [`research.md`](research.md) — algorithm and prior-art survey
  plus the Open Spec Issues audit (all six resolved or dispositioned).

## Install (Nix)

```bash
nix profile install github:khajavi/snap
snap --version
# snap 1.0.0
```

Or from a checkout:

```bash
nix build            # produces ./result/bin/snap
nix profile install .#
```

The package npm-cis the lockfile in a fixed-output fetch, esbuild-bundles
`ts/src/main.ts` into a single self-contained `main.mjs`, and wraps it with
Node — no `node_modules` ships with the installed package.

## Develop with Nix

The flake also exposes a `devShell` for working on the implementation. It
provides Node 22 (`nodejs_22`), matching the `@types/node ^22` used by the
TypeScript edition:

```bash
nix develop              # enter the dev shell
nix develop --command bash   # same shell, one command (classic nix-shell ergonomics)
```

There is no `shell.nix`, so plain `nix-shell` finds nothing — use the flake
entry point above instead.

Other useful flake commands:

```bash
nix run .#snap -- --version   # run the CLI without installing it
nix build                     # build the derivation, producing ./result/bin/snap
nix profile install .#snap    # install the CLI to ~/.nix-profile/bin
```

## Run Snap

From the repository root (or with `snap` on your PATH via Nix):

```bash
./run init /tmp/example
./run config --global contributor.id you@example.com
cd /tmp/example
echo hello > hello.txt
/path/to/snap/run commit "add greeting"
```

A first session, end to end:

```console
$ snap init repo && cd repo
$ snap config contributor.id alice@example.com
$ printf 'hello\nworld\n' > greeting.txt
$ snap commit "add greeting"
(alice@example.com->1)
$ printf 'hello\nsnap world\n' > greeting.txt
$ snap diff
--- a/greeting.txt
+++ b/greeting.txt
@@ -1,2 +1,2 @@
 hello
-world
+snap world
$ snap log
(alice@example.com->1)	alice@example.com	add greeting
```

To collaborate, serve one repository and merge or diff it from another:

```console
$ snap --serve            # prints http://127.0.0.1:8765/repository.json
$ snap merge http://127.0.0.1:8765/repository.json
```

Concurrent text edits converge through operational transformation; every
structural conflict is resolved by fixed tie-break rules and reported as
`warning: auto-resolved <path>: <reason>`. Snap has no branches, staging area,
checkout, or unresolved conflicts — read the spec before relying on familiar
Git behavior.

The supported surface is:

```text
snap init [path]
snap config [--global] contributor.id <id>
snap status
snap log
snap commit <message>
snap diff [<old> <new> [--repo <repository>]]
snap revert <version>
snap merge <repository>
snap --serve [port]
snap --version
```

## Verify

Run the full language-neutral acceptance suite against your selected workspace:

```bash
./verify --lang ts
```

Replace `ts` with `rust` or `scala` when appropriate. The verifier builds the
Rust or Scala workspace before running the suite; for TypeScript it installs
locked dependencies and executes the candidate through `tsx`. Run
`npm run typecheck` (in `ts/`) separately when you want a static type-check.

Or test any executable implemented in any language:

```bash
./verify --candidate /path/to/snap
```

The YAML suite creates isolated temporary repositories and checks exact output,
history JSON, file bytes, directory state, merge convergence, and HTTP behavior.
It imports no TypeScript implementation code. The harness itself is covered by
its own test suite:

```bash
cd test-harness && npm run check && npm test
```
