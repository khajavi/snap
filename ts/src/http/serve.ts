/**
 * `snap --serve` (SPEC.md §7.9, §9, plan.md Phase 10): the startup-
 * snapshot HTTP server.
 *
 * §7.9 + §9's contract, in its own words:
 *
 *   - "Validates and snapshots the current repository at startup" — the
 *     snapshot is the *validated* repository, encoded **once** through
 *     `repo-store/store.ts`'s canonical `encodeRepository` and reused for
 *     every response, never re-encoded per request (plan.md Phase 10:
 *     the HTTP body and the on-disk file can never independently drift);
 *   - "Binds only to `127.0.0.1`; port defaults to `8765`, while `0` asks
 *     the OS to select one";
 *   - "Prints and flushes
 *     `http://127.0.0.1:<actual-port>/repository.json`" — the actual
 *     bound port, and the URL stays plain in both presentations (§7.11);
 *   - "Serves the startup snapshot until SIGINT or SIGTERM, then exits
 *     0" — the shutdown handling is bespoke (plan.md §1.2's process-
 *     lifecycle note): the process's own signal handlers (installed in
 *     `main.ts`) call this module's stop function and exit 0 *after* the
 *     in-flight response finishes, bypassing Effect's default
 *     fiber-interrupt behavior;
 *   - GET returns the snapshot with `Content-Type: application/json;
 *     charset=utf-8`; HEAD the same status/headers without a body; other
 *     paths 404; other methods 405 with `Allow: GET, HEAD`.
 *
 * The serving loop itself is plain `node:http` behind a tiny callback
 * seam (`onReady`/`onRequest`), because §7.9's lifecycle is process-shaped
 * (bind, print, await signals) rather than Effect-shaped; the *content*
 * path is the pure pre-encoded snapshot string.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { locateRepository, RepositoryNotFoundError } from "../repo-store/locate.js";
import { RepoStore, encodeRepository, type RepoStoreLoadError } from "../repo-store/store.js";
import { isPlatformError, type PlatformError } from "@effect/platform/Error";

/** Every error `serveCmd`'s startup phase can produce. */
export type ServeStartupError = RepositoryNotFoundError | RepoStoreLoadError | PlatformError;

/** §9's fixed resource path. */
const RESOURCE_PATH = "/repository.json";

/** §9's Content-Type for the snapshot body. */
const CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Writes the response for one request against the pre-encoded snapshot.
 * Pure given the bytes; exported for direct unit tests of the routing
 * table (404/405/HEAD/GET).
 */
export function respondTo(
  method: string,
  target: string,
  snapshot: string,
  respond: (status: number, headers: ReadonlyArray<readonly [string, string]>, body: string | undefined) => void,
): void {
  // §9: "one fixed resource" — the request target must be exactly
  // `/repository.json`. Anything else, including a query string
  // (`?query=not-exact`, tests/12) or a subpath, is a 404.
  if (target !== RESOURCE_PATH) {
    respond(404, [], undefined);
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    respond(405, [["Allow", "GET, HEAD"]], undefined);
    return;
  }
  if (method === "HEAD") {
    respond(200, [["Content-Type", CONTENT_TYPE]], undefined);
    return;
  }
  respond(200, [["Content-Type", CONTENT_TYPE]], snapshot);
}

/** What `serveRepository` reports back to its caller. */
export interface ServeHandle {
  /** The actual bound port (OS-selected when `port` is 0). */
  readonly port: number;
  /** Stops accepting connections and closes the server. */
  readonly close: () => Promise<void>;
}

/**
 * Binds `127.0.0.1:<port>` and serves the fixed snapshot until `close`.
 * Each request is answered through `respondTo`; `close` resolves once the
 * server has fully stopped (in-flight responses finished), which is what
 * makes the §7.9 "exits 0 after the in-flight response finishes" sequence
 * observable to the caller.
 */
export async function serveSnapshot(
  port: number,
  snapshot: string,
  printUrl: (url: string) => void,
): Promise<ServeHandle> {
  const server: Server = createServer((request, response) => {
    answer(request, response, snapshot);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("serve server has no TCP address");
  }
  // §7.9: "Prints and flushes" — a synchronous stdout write through the
  // callback, then the caller's stream flush completes it.
  printUrl(`http://127.0.0.1:${address.port}/repository.json\n`);
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Answers one `node:http` request from the pre-encoded snapshot. */
function answer(request: IncomingMessage, response: ServerResponse, snapshot: string): void {
  respondTo(
    request.method ?? "GET",
    request.url ?? "/",
    snapshot,
    (status, headers, body) => {
      response.statusCode = status;
      for (const [name, value] of headers) {
        response.setHeader(name, value);
      }
      if (body === undefined) {
        response.end();
      } else {
        response.end(body);
      }
    },
  );
}

/**
 * §7.9's startup: locate, load+validate (which is the snapshot), encode
 * once, and hand the pre-encoded bytes to `serveSnapshot`. The returned
 * Effect completes when the server is *bound and the URL printed*; the
 * caller then owns the wait-for-signals lifecycle.
 */
export function serveRepository(
  port: number,
  printUrl: (url: string) => void,
): Effect.Effect<ServeHandle, ServeStartupError, FileSystem.FileSystem | RepoStore> {
  return Effect.gen(function* () {
    const repoRoot = yield* locateRepository(".");
    const store = yield* RepoStore;
    const repository = yield* store.load(repoRoot);
    // The one canonical encode, reused for every response (plan.md §5's
    // "byte-for-byte JSON shape and ordering compatibility" bullet).
    const snapshot = encodeRepository(repository);
    const handle = yield* Effect.tryPromise({
      try: () => serveSnapshot(port, snapshot, printUrl),
      catch: (error) => error as PlatformError,
    });
    return handle;
  });
}

/** Re-exported so `main.ts` can narrow startup failures structurally. */
export { isPlatformError };
