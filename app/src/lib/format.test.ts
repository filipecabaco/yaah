import { describe, expect, it } from "vitest";
import { baseName, compactPath, formatAgo, formatBytes, formatDuration, plural } from "@/lib/format";

describe("format", () => {
  it("counts with the right noun", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
    expect(plural(1204, "match", "matches")).toBe("1,204 matches");
  });

  it("sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3482)).toBe("3.4 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(-7_620_000)).toBe("2h 07m");
    expect(formatDuration(4 * 86_400_000 + 3 * 3_600_000)).toBe("4d 3h");
  });

  it("how long ago", () => {
    const now = 1_800_000_000;
    expect(formatAgo(now - 30, now)).toBe("just now");
    expect(formatAgo(now - 600, now)).toBe("10 min ago");
    expect(formatAgo(now - 3 * 3600, now)).toBe("3 h ago");
    expect(formatAgo(now - 5 * 86400, now)).toBe("5 d ago");
    // Clock skew never reads as the future.
    expect(formatAgo(now + 100, now)).toBe("just now");
  });

  it("paths", () => {
    expect(compactPath("/Users/me/src/x")).toBe("~/src/x");
    expect(compactPath("/home/me/src")).toBe("~/src");
    expect(compactPath("/opt/tools")).toBe("/opt/tools");
    expect(baseName("~/src/app/")).toBe("app");
  });
});
