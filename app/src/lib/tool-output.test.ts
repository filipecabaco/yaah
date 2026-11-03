import { describe, expect, it } from "vitest";
import { isUnifiedDiff, readToolText, toolTextLayout } from "@/lib/tool-output";

// Real output, as Claude's adapter sends a Bash result: "```console\n" + output.trimEnd() + "\n```".
const fence = (text: string, info = "console", marker = "```") => `${marker}${info}\n${text}\n${marker}`;

const GIT_DIFF = `diff --git a/app/src/dev/mock/settings.ts b/app/src/dev/mock/settings.ts
index caba6c0..67be7e1 100644
--- a/app/src/dev/mock/settings.ts
+++ b/app/src/dev/mock/settings.ts
@@ -16,6 +16,12 @@ const cardDefaults: Record<string, CardMode> = {
   Skill: "collapsed",
   TodoWrite: "collapsed",
   "mcp__yaah-ui": "collapsed",
+  mcp__fetch: "collapsed",
+  "kind:fetch": "collapsed",
+  Fetch: "collapsed",
+  WebFetch: "collapsed",
+  WebSearch: "collapsed",
+  "kind:execute": "collapsed",
 };

 /** A made-up VS Code theme, as if dropped into ~/.config/yaah/themes. */`;

const GIT_LOG = `commit 5947a27182522711290300f7bdaed9361b61a267
Author: Filipe Cabaco <filipecabaco@gmail.com>
Date:   Tue Nov 3 11:29:49 2026 +0000

    Release 0.2.0

commit 4ca851056ac43ddc65cf82e2b969b88aab23e1cd
Author: Filipe Cabaco <filipecabaco@gmail.com>
Date:   Tue Nov 3 11:50:30 2026 +0000

    Let the Component library be closed`;

const CARGO = `   Compiling yaah v0.2.0 (/Users/dev/workspace/yaah/app/src-tauri)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 41.27s
     Running unittests src/lib.rs (target/debug/deps/yaah_lib-3c1f0b2e9a7d4e51)

running 2 tests
test settings::tests::appearance_is_checked ... ok
test settings::tests::web_fetches_searches_and_commands_start_collapsed_unless_the_user_says_otherwise ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 412 filtered out; finished in 0.01s`;

const DIFF_U = `--- a/notes.txt	2026-11-03 10:00:00.000000000 +0000
+++ b/notes.txt	2026-11-03 10:05:00.000000000 +0000
@@ -1,2 +1,2 @@
-hello
+hello, world
 bye`;

describe("readToolText", () => {
  it("takes a ```console fence off command output", () => {
    const t = readToolText(fence(CARGO));
    expect(t).toEqual({ text: CARGO, lang: "console", fenced: true, diff: false });
    expect(t.text).not.toContain("```");
  });

  it("finds a git diff inside the fence, and one that came without a fence", () => {
    expect(readToolText(fence(GIT_DIFF))).toEqual({ text: GIT_DIFF, lang: "console", fenced: true, diff: true });
    expect(readToolText(GIT_DIFF)).toEqual({ text: GIT_DIFF, lang: null, fenced: false, diff: true });
    expect(readToolText(fence(DIFF_U)).diff).toBe(true);
  });

  it("git log is code, not a diff", () => {
    expect(readToolText(fence(GIT_LOG))).toEqual({ text: GIT_LOG, lang: "console", fenced: true, diff: false });
  });

  it("any language, a longer fence for text that holds one, tildes, and no language", () => {
    const md = "# Notes\n\n```sh\nls\n```";
    expect(readToolText(fence(md, "md", "````"))).toEqual({ text: md, lang: "md", fenced: true, diff: false });
    expect(readToolText(fence("let x = 1;", "ts"))).toMatchObject({ text: "let x = 1;", lang: "ts" });
    expect(readToolText(fence("plain", "", "~~~"))).toMatchObject({ text: "plain", lang: null, fenced: true });
    expect(readToolText("```console\n```")).toMatchObject({ text: "", fenced: true });
    expect(readToolText("```console\nok\n```\n")).toMatchObject({ text: "ok", fenced: true });
  });

  it("leaves text alone when it isn't one whole fence", () => {
    const prose = "Done. Here's the command:\n```sh\nls\n```";
    expect(readToolText(prose)).toEqual({ text: prose, lang: null, fenced: false, diff: false });
    const unclosed = "```console\nstill running";
    expect(readToolText(unclosed).fenced).toBe(false);
    expect(readToolText("```console\na\n``").fenced).toBe(false);
  });
});

describe("isUnifiedDiff", () => {
  it("needs the diff to start the text", () => {
    expect(isUnifiedDiff(GIT_DIFF)).toBe(true);
    expect(isUnifiedDiff(`\n${GIT_DIFF}`)).toBe(true);
    expect(isUnifiedDiff(DIFF_U)).toBe(true);
    expect(isUnifiedDiff(`Summary\n${GIT_DIFF}`)).toBe(false);
    expect(isUnifiedDiff("--- a heading\nnot a diff")).toBe(false);
    expect(isUnifiedDiff(GIT_LOG)).toBe(false);
  });
});

describe("toolTextLayout", () => {
  it("keeps code blocks and diffs on their lines; anything else wraps", () => {
    expect(toolTextLayout(readToolText(fence(CARGO)))).toBe("code");
    expect(toolTextLayout(readToolText(GIT_DIFF))).toBe("diff");
    expect(toolTextLayout(readToolText(fence(DIFF_U)))).toBe("diff");
    expect(toolTextLayout(readToolText("[codex-acp] MCP server `fetch` was not started, because the Codex config already defines it."))).toBe(
      "prose",
    );
    expect(toolTextLayout(readToolText(GIT_LOG))).toBe("prose");
  });
});
