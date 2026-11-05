import { describe, expect, it } from "vitest";
import { commandLines, shellDescription, toolLabel } from "@/lib/ui-tool-label";

describe("shell calls", () => {
  it("labels a call by its description, not its command", () => {
    const rawInput = { command: "ls $V && pkill -f x", description: "Restart the daemon" };
    expect(shellDescription(rawInput)).toBe("Restart the daemon");
    expect(toolLabel({ title: "ls $V && pkill -f x", status: "pending", rawInput })?.text).toBe("Restart the daemon");
  });

  it("keeps the title when there is no description", () => {
    expect(toolLabel({ title: "ls", status: "completed", rawInput: { command: "ls" } })).toBeNull();
  });

  it("splits a command into steps outside quotes", () => {
    expect(commandLines(`cd a && echo "x && y"; ls | grep 'a;b'\nrc=$?`)).toEqual(["cd a &&", 'echo "x && y";', "ls | grep 'a;b'", "rc=$?"]);
  });
});

describe("shellCommandFromJson", () => {
  it("decodes the command of an input echoed as JSON text, escapes and all", async () => {
    const { shellCommandFromJson } = await import("@/lib/ui-tool-label");
    const text = JSON.stringify({ command: "cd /p && perl -pi -e 's/a\\n/b/' f.rs", description: "x" }, null, 2);
    expect(shellCommandFromJson(text)).toBe("cd /p && perl -pi -e 's/a\\n/b/' f.rs");
    expect(shellCommandFromJson("not json")).toBeNull();
    expect(shellCommandFromJson('{"path": "a"}')).toBeNull();
  });
});
