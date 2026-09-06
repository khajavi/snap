/**
 * Property-based convergence tests (plan.md Phase 12, research.md's
 * recommendation): generate valid causal patch graphs — per-author
 * revision chains whose bases name only already-emitted dots — and assert
 * that canonical replay (SPEC §6.1-§6.2) converges to the same tree and
 * warning set regardless of the input patch array's order, across several
 * target versions (the joined frontier, each contributor's own head, and
 * intermediate versions), beyond what the fixed YAML cases can cover.
 *
 * This is the level-4 tier of plan.md's test pyramid: the only one that
 * probes the CRDT convergence guarantee (§1 invariant 6, §6.5) broadly.
 * Per AGENTS.md it complements, never replaces, the shared YAML suite.
 *
 * Generator design (what makes every generated repository valid by
 * construction): each generated event has an author emit one patch whose
 * base is the author's current knowledge — the per-author latest
 * revisions it has emitted or (optionally, when the event says `sync`)
 * imported from everything emitted so far. Each change is then computed
 * against the TRUE replayed base tree (`replay` over the base version),
 * so every validity rule the acceptance suite pins holds by
 * construction: creations require an absent base path, edits consume
 * exactly the base tokens, deletes hit present paths, puts differ from
 * the base bytes (no no-op changes), changes are sorted/unique, and the
 * serialized patch array is author-sorted with contiguous revisions.
 * Concurrency arises naturally: without a sync, an author's chain is
 * independent of the others, so same-path concurrent edits/puts/deletes
 * meet in replay exactly as in tests/09–11 — with the `sync` flag
 * producing multi-level histories that stack edits on top of imported
 * concurrent effects (the §6.3 aggregate-context-edit path).
 *
 * `replay`'s use inside the generator is not circular: the property under
 * test is order-independence of the *output* across patch-array
 * permutations and acceptance by the *full validation pipeline*, not
 * agreement with an independent model.
 */

import { it } from "@effect/vitest";
import * as FC from "fast-check";
import { Either } from "effect";
import { describe, expect } from "vitest";
import { diffTokens } from "../../src/domain/diff.js";
import { parseTrackedPath, type TrackedPath } from "../../src/domain/path.js";
import { decodePatch, type Patch } from "../../src/domain/patch.js";
import { tokenize } from "../../src/domain/text.js";
import { replay } from "../../src/replay/replay.js";
import type { Tree } from "../../src/replay/integrate.js";
import { validateRepository } from "../../src/replay/validate.js";
import { Version } from "../../src/domain/version.js";

// ---------------------------------------------------------------------------
// Generator vocabulary
// ---------------------------------------------------------------------------

/** Fixed contributor pool. */
const AUTHORS = ["a@x.com", "b@x.com", "c@x.com"] as const;

/**
 * Disjoint tracked paths (no prefix relationships), so generated change
 * sets are prefix-free by construction and namespace resolution never
 * interferes with the convergence property under test.
 */
const PATHS = ["p1", "p2", "p3"] as const;

/** Words for generated text files; LF-joined with a trailing LF so `tokenize` is canonical. */
const WORDS = ["alpha", "beta", "gamma"] as const;

/** The path pool as validated `TrackedPath`s (fails loudly if a pool entry is invalid). */
const TRACKED_PATHS: ReadonlyArray<TrackedPath> = PATHS.map((raw) => {
  const parsed = parseTrackedPath(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`generator path pool entry is not a valid tracked path: ${raw}`);
  }
  return parsed.right;
});

/** A non-text byte payload for generated `put` changes (the NUL byte forces binary classification). */
const BINARY_BYTES = Uint8Array.of(0x00, 0xff, 0x0a);

type OpSpec = {
  readonly pathIndex: number;
  /** 0 = text edit/create, 1 = put, 2 = delete. */
  readonly kind: number;
  readonly wordIndices: ReadonlyArray<number>;
  readonly binary: boolean;
};

type EventSpec = {
  readonly authorIndex: number;
  /** Import everything emitted so far into the author's base before patching. */
  readonly sync: boolean;
  readonly ops: ReadonlyArray<OpSpec>;
};

const eventSpecArb: FC.Arbitrary<EventSpec> = FC.record({
  authorIndex: FC.integer({ min: 0, max: AUTHORS.length - 1 }),
  sync: FC.boolean(),
  ops: FC.array(
    FC.record({
      pathIndex: FC.integer({ min: 0, max: PATHS.length - 1 }),
      kind: FC.integer({ min: 0, max: 2 }),
      wordIndices: FC.array(FC.integer({ min: 0, max: WORDS.length - 1 }), {
        minLength: 1,
        maxLength: 3,
      }),
      binary: FC.boolean(),
    }),
    { minLength: 1, maxLength: PATHS.length },
  ),
});

// ---------------------------------------------------------------------------
// Deterministic expansion: event specs -> valid repository
// ---------------------------------------------------------------------------

const textFromSpec = (spec: OpSpec): string =>
  spec.wordIndices.map((i) => WORDS[i]!).join("\n") + "\n";

/** Parses a plain-string version-pair list as a canonical `Version` (fails loudly on a bad fixture). */
const versionFromPairs = (pairs: ReadonlyArray<readonly [string, number]>): Version => {
  const canonical = `(${pairs.map(([id, revision]) => `${id}->${revision}`).join(",")})`;
  const parsed = Version.parse(canonical);
  if (Either.isLeft(parsed)) {
    throw new Error(`fixture version is not canonical: ${canonical}`);
  }
  return parsed.right;
};

/**
 * Expands the generated event sequence into a valid repository.
 *
 * Per-author knowledge is the latest known revision of each contributor
 * (vector-clock style); a patch's base is that knowledge serialized as
 * sorted unique pairs, and its changes are computed against the true
 * replayed base tree, so all of `validateRepository`'s structural rules
 * hold by construction. Throws (failing the property loudly) if any
 * generated patch fails to decode or any base fails to replay — that
 * would be a generator bug, not a tolerable skip.
 */
function expand(events: ReadonlyArray<EventSpec>): {
  readonly repositoryJson: Record<string, unknown>;
  readonly patches: ReadonlyArray<Patch>;
  readonly frontierPairs: ReadonlyArray<readonly [string, number]>;
  /** Causally closed versions: each emitted patch's base ∪ its own dot, plus the frontier. */
  readonly targets: ReadonlyArray<ReadonlyArray<readonly [string, number]>>;
} {
  /** Per-author latest known revision (0 = unknown). */
  const known = new Map<string, number>(AUTHORS.map((a) => [a, 0] as const));
  /** Counts of emitted patches per author. */
  const emitted = new Map<string, number>(AUTHORS.map((a) => [a, 0] as const));
  const rawPatches: Array<Record<string, unknown>> = [];
  const targets: Array<Array<readonly [string, number]>> = [];

  const buildChangeList = (
    baseTree: Tree,
    event: EventSpec,
  ): Array<Record<string, unknown>> => {
    const seen = new Set<string>();
    const changes: Array<Record<string, unknown>> = [];
    for (const opSpec of event.ops) {
      const path = TRACKED_PATHS[opSpec.pathIndex % TRACKED_PATHS.length]!;
      if (seen.has(path)) {
        continue; // at most one change per path — keep the first op
      }
      seen.add(path);
      const baseState = baseTree.get(path);
      const kind = opSpec.kind;

      if (kind === 2) {
        if (baseState === undefined) {
          continue; // deleting an absent path is invalid — drop the op
        }
        changes.push({ type: "delete", path });
        continue;
      }

      if (baseState !== undefined && baseState._tag === "Binary") {
        // A binary base path cannot take a text edit; coerce to put (or delete above).
        if (kind === 0) {
          const text = textFromSpec(opSpec);
          changes.push({ type: "put", path, content: Buffer.from(text, "utf8").toString("base64") });
          continue;
        }
        let bytes = BINARY_BYTES;
        if (Buffer.from(baseState.bytes).equals(Buffer.from(bytes))) {
          bytes = Uint8Array.of(...bytes, 0x01);
        }
        changes.push({ type: "put", path, content: Buffer.from(bytes).toString("base64") });
        continue;
      }

      const baseTokens = baseState !== undefined && baseState._tag === "Text" ? baseState.tokens : [];
      const baseText = baseTokens.join("");

      if (kind === 0) {
        let newText = textFromSpec(opSpec);
        if (newText === baseText) {
          newText = newText + "delta\n"; // no-op text edits are invalid
        }
        changes.push({ type: "text", path, edit: diffTokens(baseTokens, tokenize(newText)) });
        continue;
      }

      // kind 1: put. Content must differ from the base bytes.
      if (opSpec.binary) {
        let bytes = BINARY_BYTES;
        if (Buffer.from(bytes).equals(Buffer.from(baseText, "utf8"))) {
          bytes = Uint8Array.of(...bytes, 0x01);
        }
        changes.push({ type: "put", path, content: Buffer.from(bytes).toString("base64") });
        continue;
      }
      let text = textFromSpec(opSpec);
      if (text === baseText) {
        text = text + "delta\n";
      }
      changes.push({ type: "put", path, content: Buffer.from(text, "utf8").toString("base64") });
    }
    // §4.2: changes are sorted by path (they were collected in op order).
    return changes.sort((x, y) =>
      (x["path"] as string) < (y["path"] as string) ? -1 : (x["path"] as string) > (y["path"] as string) ? 1 : 0,
    );
  };

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex]!;
    const author = AUTHORS[event.authorIndex % AUTHORS.length]!;

    if (event.sync) {
      for (const a of AUTHORS) {
        const count = emitted.get(a) ?? 0;
        if (count > (known.get(a) ?? 0)) {
          known.set(a, count);
        }
      }
    }

    const basePairs: Array<readonly [string, number]> = [];
    for (const a of AUTHORS) {
      const revision = known.get(a) ?? 0;
      if (revision > 0) {
        basePairs.push([a, revision] as const);
      }
    }

    // The patch's exact base tree: the TRUE replay of its base version
    // over the patches emitted so far (all of which its base names).
    const baseVersion = versionFromPairs(basePairs);
    const baseReplay = replay(baseVersion, decodeAll(rawPatches));
    if (Either.isLeft(baseReplay)) {
      throw new Error(`generated base ${baseVersion.toCanonicalString()} failed to replay: ${baseReplay.left._tag}`);
    }

    const changes = buildChangeList(baseReplay.right.tree, event);
    if (changes.length === 0) {
      // Every op was dropped (e.g. deletes of absent paths): fall back to
      // a put on p1 with guaranteed-different content.
      const baseState = baseReplay.right.tree.get(TRACKED_PATHS[0]!);
      const previousBytes =
        baseState === undefined || baseState._tag === "Absent"
          ? Uint8Array.of()
          : baseState._tag === "Binary"
            ? Buffer.from(baseState.bytes)
            : Buffer.from(baseState.tokens.join(""), "utf8");
      changes.push({
        type: "put",
        path: TRACKED_PATHS[0]!,
        content: Buffer.concat([previousBytes, Uint8Array.of(0x02)]).toString("base64"),
      });
    }

    const revision = (emitted.get(author) ?? 0) + 1;
    rawPatches.push({
      author,
      revision,
      base: basePairs,
      message: `m${eventIndex + 1}`,
      changes,
    });
    emitted.set(author, revision);
    known.set(author, revision);

    // A causally closed target version: the new patch's own dot merged
    // over its complete base (overwriting the author's own base entry —
    // the newer revision subsumes it). Knowledge only grows across events,
    // so every base dot named here stays within later targets' revisions
    // (replay of these versions always passes the base-closure check).
    const targetPairs = new Map(basePairs);
    targetPairs.set(author, revision);
    targets.push([...targetPairs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  // Serialized patch array: sorted by (author UTF-8, revision) — §4.2.
  rawPatches.sort((a, b) =>
    a["author"] !== b["author"]
      ? (a["author"] as string) < (b["author"] as string)
        ? -1
        : 1
      : (a["revision"] as number) - (b["revision"] as number),
  );

  const frontierPairs: Array<readonly [string, number]> = [];
  for (const a of AUTHORS) {
    const count = emitted.get(a) ?? 0;
    if (count > 0) {
      frontierPairs.push([a, count] as const);
    }
  }

  targets.push(frontierPairs);

  return {
    repositoryJson: { format: 1, frontier: frontierPairs, patches: rawPatches },
    patches: decodeAll(rawPatches),
    frontierPairs,
    targets,
  };
}

/** Decodes raw patch JSON, failing loudly (a generator bug, not a skip). */
function decodeAll(rawPatches: ReadonlyArray<Record<string, unknown>>): Array<Patch> {
  return rawPatches.map((raw) => {
    const decoded = decodePatch(raw);
    if (Either.isLeft(decoded)) {
      throw new Error(`generated patch failed to decode: ${decoded.left.message}`);
    }
    return decoded.right;
  });
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Canonical comparable snapshot of a replayed tree: path-sorted tagged entries. */
const treeSnapshot = (tree: Tree): ReadonlyArray<readonly [string, string]> =>
  [...tree.entries()]
    .map(([path, state]) => {
      const rendered =
        state._tag === "Text"
          ? `T:${state.tokens.join("")}`
          : state._tag === "Binary"
            ? `B:${Buffer.from(state.bytes).toString("base64")}`
            : `A:`;
      return [path, rendered] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Canonical comparable snapshot of a replay outcome. The tree renders as
 * path-sorted entries; the warning list renders IN ITS GIVEN ORDER (SPEC
 * §6.4 mandates "sorted by path, then reason", so a replay whose warning
 * sequence depended on integration order must fail this property, not be
 * normalized away here).
 */
const outcomeSnapshot = (
  target: ReadonlyArray<readonly [string, number]>,
  patches: ReadonlyArray<Patch>,
): ReadonlyArray<readonly [string, string]> => {
  const replayed = replay(versionFromPairs(target), patches);
  if (Either.isLeft(replayed)) {
    throw new Error(`replay of target failed: ${replayed.left._tag}`);
  }
  return [
    ...treeSnapshot(replayed.right.tree),
    ...replayed.right.warnings.map((w, index) => [`warn:${index}:${w.path}`, w.reason] as const),
  ];
};

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("property-based convergence (plan.md Phase 12)", () => {
  it.prop(
    "replay converges to the same tree and warnings under every patch-array permutation",
    { events: FC.array(eventSpecArb, { minLength: 1, maxLength: 8 }) },
    ({ events }) => {
      const { repositoryJson, patches, targets } = expand(events);

      // The generator's validity is part of the property: every generated
      // repository passes the full six-point validation pipeline.
      const validated = validateRepository(repositoryJson);
      expect(Either.isRight(validated), JSON.stringify(repositoryJson)).toBe(true);

      // Deduplicated causally closed targets: every emitted patch's base ∪
      // its own dot, plus the joined frontier.
      const uniqueTargets = [
        ...new Set(targets.map((t) => JSON.stringify(t))),
      ].map((t) => JSON.parse(t) as ReadonlyArray<readonly [string, number]>);

      // Baseline snapshots over the sorted (serialized) patch order.
      const baseline = new Map(
        uniqueTargets.map((t) => [JSON.stringify(t), outcomeSnapshot(t, patches)] as const),
      );

      // Deterministic permutations of the input array: rotate by one,
      // reverse, rotate by two. §6.1's ready-set sequencing must make the
      // result independent of all of them.
      const permutations = [
        [...patches.slice(1), patches[0]!],
        [...patches].reverse(),
        [...patches.slice(2), ...patches.slice(0, 2)],
      ];
      for (const permuted of permutations) {
        for (const target of uniqueTargets) {
          expect(outcomeSnapshot(target, permuted)).toEqual(baseline.get(JSON.stringify(target)));
        }
      }
    },
    { fastCheck: { numRuns: 60 }, timeout: 60_000 },
  );
});
