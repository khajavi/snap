/**
 * Presentation-layer unit tests (SPEC.md §7.11, §11 item 12): the
 * `SNAP_COLOR`/`NO_COLOR` selection table — including §11's explicit
 * requirement that each implementation unit-test `auto` selection for
 * TTY and non-TTY stdout and stderr independently — and the exact ANSI
 * bytes of every terminal layout family against tests/28's pins.
 */

import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { CODE, styled } from "../../src/presentation/ansi.js";
import {
  errorLine,
  logScreen,
  parseLogPlain,
  parseStatusPlain,
  renderFamilyOutput,
  styleDiffLine,
  statusScreen,
  successBanner,
  versionScreen,
  warningLine,
} from "../../src/presentation/render.js";
import { parseSnapColor, resolveStreamModes } from "../../src/presentation/mode.js";

describe("presentation mode: SNAP_COLOR parsing", () => {
  it("accepts the three legal values and treats unset as auto", () => {
    expect(parseSnapColor(undefined)._tag).toBe("Right");
    expect(parseSnapColor("auto")._tag).toBe("Right");
    expect(parseSnapColor("always")._tag).toBe("Right");
    expect(parseSnapColor("never")._tag).toBe("Right");
  });

  it("rejects any other value with the pinned detail", () => {
    const result = parseSnapColor("sometimes");
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBe("SNAP_COLOR must be auto, always, or never");
    }
    expect(parseSnapColor("")._tag).toBe("Left");
    expect(parseSnapColor("ALWAYS")._tag).toBe("Left");
  });
});

/** Asserts the selection resolved to exactly `expected` modes. */
function expectModes(result: ReturnType<typeof resolveStreamModes>, expected: { stdout: string; stderr: string }): void {
  expect(Either.isRight(result)).toBe(true);
  if (Either.isRight(result)) {
    expect(result.right).toStrictEqual(expected);
  }
}

describe("presentation mode: per-stream resolution (§11's independent-TTY matrix)", () => {
  it("never: plain on both streams regardless of TTY", () => {
    for (const out of [true, false]) {
      for (const err of [true, false]) {
        expectModes(resolveStreamModes("never", false, out, err), { stdout: "plain", stderr: "plain" });
      }
    }
  });

  it("always: terminal on both streams even when redirected and under NO_COLOR", () => {
    for (const out of [true, false]) {
      for (const err of [true, false]) {
        expectModes(resolveStreamModes("always", true, out, err), { stdout: "terminal", stderr: "terminal" });
      }
    }
  });

  it("auto without NO_COLOR selects terminal exactly per stream TTY", () => {
    expectModes(resolveStreamModes("auto", false, true, true), { stdout: "terminal", stderr: "terminal" });
    expectModes(resolveStreamModes("auto", false, true, false), { stdout: "terminal", stderr: "plain" });
    expectModes(resolveStreamModes("auto", false, false, true), { stdout: "plain", stderr: "terminal" });
    expectModes(resolveStreamModes("auto", false, false, false), { stdout: "plain", stderr: "plain" });
  });

  it("auto with NO_COLOR present (even empty) forces complete plain presentation", () => {
    for (const out of [true, false]) {
      for (const err of [true, false]) {
        expectModes(resolveStreamModes("auto", true, out, err), { stdout: "plain", stderr: "plain" });
      }
    }
  });

  it("unset SNAP_COLOR behaves like auto", () => {
    expectModes(resolveStreamModes(undefined, false, true, false), { stdout: "terminal", stderr: "plain" });
  });

  it("an invalid value errors before any presentation is selected", () => {
    expect(resolveStreamModes("sometimes", false, true, true)._tag).toBe("Left");
  });
});

describe("ansi: the S(n, text) primitive", () => {
  it("wraps text in ESC[nm ... ESC[0m", () => {
    expect(styled(CODE.bold, "x")).toBe("\u001b[1mx\u001b[0m");
    expect(styled(CODE.green, "✓")).toBe("\u001b[32m✓\u001b[0m");
  });
});

describe("terminal renderers: exact bytes (tests/28 pins)", () => {
  it("success banner", () => {
    expect(successBanner("Initialized repository", "()")).toBe(
      "\u001b[32m✓\u001b[0m \u001b[1mInitialized repository\u001b[0m \u001b[36m()\u001b[0m\n",
    );
    expect(successBanner("Committed", "(alice@x->1)")).toBe(
      "\u001b[32m✓\u001b[0m \u001b[1mCommitted\u001b[0m \u001b[36m(alice@x->1)\u001b[0m\n",
    );
  });

  it("status screen: dirty rows and the clean line", () => {
    expect(statusScreen("()", [
      { code: "A", path: "added.txt" },
      { code: "D", path: "gone.txt" },
      { code: "M", path: "modified.txt" },
    ])).toBe(
      "\u001b[1mSnap status\u001b[0m  \u001b[36m()\u001b[0m\n\n" +
        "  \u001b[32m+\u001b[0m added.txt \u001b[2m(added)\u001b[0m\n" +
        "  \u001b[31m−\u001b[0m gone.txt \u001b[2m(deleted)\u001b[0m\n" +
        "  \u001b[33m~\u001b[0m modified.txt \u001b[2m(modified)\u001b[0m\n",
    );
    expect(statusScreen("(alice@x->1)", [])).toBe(
      "\u001b[1mSnap status\u001b[0m  \u001b[36m(alice@x->1)\u001b[0m\n\n  \u001b[32m✓\u001b[0m Working tree clean\n",
    );
  });

  it("status plain parser keeps whole-rest-of-line paths (trailing spaces)", () => {
    const parsed = parseStatusPlain("version ()\nA trailing \n");
    expect(parsed.rows).toStrictEqual([{ code: "A", path: "trailing " }]);
  });

  it("log screen: entries with one LF between and none after the last", () => {
    const entries = [
      { version: "(alice@x->2)", author: "alice@x", message: "second" },
      { version: "(alice@x->1)", author: "alice@x", message: "first" },
    ];
    expect(logScreen(entries)).toBe(
      "\u001b[36m●\u001b[0m \u001b[1msecond\u001b[0m\n" +
        "  \u001b[36m(alice@x->2)\u001b[0m \u001b[2mby\u001b[0m \u001b[35malice@x\u001b[0m\n" +
        "\n" +
        "\u001b[36m●\u001b[0m \u001b[1mfirst\u001b[0m\n" +
        "  \u001b[36m(alice@x->1)\u001b[0m \u001b[2mby\u001b[0m \u001b[35malice@x\u001b[0m\n",
    );
    expect(logScreen(parseLogPlain(""))).toBe("");
  });

  it("diff line styles by first applicable literal prefix", () => {
    expect(styleDiffLine("--- a/f")).toBe("\u001b[1m--- a/f\u001b[0m");
    expect(styleDiffLine("@@ -1,2 +1,2 @@")).toBe("\u001b[36m@@ -1,2 +1,2 @@\u001b[0m");
    expect(styleDiffLine("-old")).toBe("\u001b[31m-old\u001b[0m");
    expect(styleDiffLine("+new")).toBe("\u001b[32m+new\u001b[0m");
    expect(styleDiffLine("\\ No newline at end of file")).toBe(
      "\u001b[2m\\ No newline at end of file\u001b[0m",
    );
    expect(styleDiffLine("Binary files a/x and b/y differ")).toBe(
      "\u001b[33mBinary files a/x and b/y differ\u001b[0m",
    );
    expect(styleDiffLine(" context")).toBe(" context");
  });

  it("diff precedence: header prefixes win over deletion/insertion (Issue 6)", () => {
    // A deleted token whose content begins `-- ` prints as `--- ...` and
    // therefore takes the header style, not red — the literal-prefix rule.
    expect(styleDiffLine("--- note")).toBe("\u001b[1m--- note\u001b[0m");
    expect(styleDiffLine("+++ note")).toBe("\u001b[1m+++ note\u001b[0m");
  });

  it("version screen is bold including the semver", () => {
    expect(versionScreen("1.0.0")).toBe("\u001b[1msnap 1.0.0\u001b[0m\n");
  });

  it("warning lines restyle the detail after the plain prefix", () => {
    expect(warningLine("warning: auto-resolved same: later-create-wins")).toBe(
      "\u001b[33m⚠\u001b[0m \u001b[33mauto-resolved same: later-create-wins\u001b[0m\n",
    );
  });

  it("error lines wrap the entire plain line including the snap: prefix", () => {
    expect(errorLine("snap: invalid command or arguments\n")).toBe(
      "\u001b[31m✗ snap: invalid command or arguments\u001b[0m\n",
    );
  });
});

describe("family composition: plain bytes through, terminal restyled", () => {
  const banner = { stdout: "(alice@x->1)\n", stderr: "", family: { kind: "banner", label: "Committed" } as const };

  it("plain mode emits the command bytes untouched", () => {
    expect(renderFamilyOutput(banner, { stdout: "plain", stderr: "plain" })).toStrictEqual({
      stdout: "(alice@x->1)\n",
      stderr: "",
    });
  });

  it("terminal stdout mode restyles per family while stderr mode is independent", () => {
    expect(renderFamilyOutput(banner, { stdout: "terminal", stderr: "plain" }).stdout).toBe(
      "\u001b[32m✓\u001b[0m \u001b[1mCommitted\u001b[0m \u001b[36m(alice@x->1)\u001b[0m\n",
    );
  });

  it("merge warnings restyle only in terminal stderr mode", () => {
    const merge = {
      stdout: "(a@x->1,b@x->1)\n",
      stderr: "warning: auto-resolved same: later-create-wins\n",
      family: { kind: "banner", label: "Merged" } as const,
    };
    expect(renderFamilyOutput(merge, { stdout: "terminal", stderr: "terminal" })).toStrictEqual({
      stdout: "\u001b[32m✓\u001b[0m \u001b[1mMerged\u001b[0m \u001b[36m(a@x->1,b@x->1)\u001b[0m\n",
      stderr: "\u001b[33m⚠\u001b[0m \u001b[33mauto-resolved same: later-create-wins\u001b[0m\n",
    });
    expect(renderFamilyOutput(merge, { stdout: "terminal", stderr: "plain" }).stderr).toBe(
      "warning: auto-resolved same: later-create-wins\n",
    );
  });

  it("silent (config) and url (--serve) families stay plain even in terminal mode", () => {
    expect(renderFamilyOutput({ stdout: "", stderr: "", family: { kind: "silent" } }, { stdout: "terminal", stderr: "terminal" })).toStrictEqual({
      stdout: "",
      stderr: "",
    });
    expect(
      renderFamilyOutput(
        { stdout: "http://127.0.0.1:8765/repository.json\n", stderr: "", family: { kind: "url" } },
        { stdout: "terminal", stderr: "terminal" },
      ).stdout,
    ).toBe("http://127.0.0.1:8765/repository.json\n");
  });
});
