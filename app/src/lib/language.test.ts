import { describe, expect, it } from "vitest";
import { detectLanguage, languageForName, languageForPath, parseNumbered, sniffLanguage } from "@/lib/language";

describe("languageForPath", () => {
  it.each([
    ["/a/composer-mode.test.tsx", "tsx"],
    ["src/main.rs", "rust"],
    ["lib/a.ex", "elixir"],
    ["script.exs", "elixir"],
    ["Cargo.toml", "toml"],
    ["ci.yml", "yaml"],
    ["ci.YAML", "yaml"],
    ["README.md", "markdown"],
    ["run.sh", "bash"],
    ["x.zsh", "bash"],
    ["a.css", "css"],
    ["a.html", "html"],
    ["q.sql", "sql"],
    ["a.py", "python"],
    ["main.go", "go"],
    ["x/Dockerfile", "dockerfile"],
    ["Dockerfile.dev", "dockerfile"],
    ["Makefile", "make"],
    [".env", "ini"],
    [".env.local", "ini"],
    ["tsconfig.json", "jsonc"],
    ["package.json", "json"],
    ["C:\\proj\\a.ts", "typescript"],
  ])("%s -> %s", (path, lang) => expect(languageForPath(path)).toBe(lang));

  it("is null for unknown, extensionless or empty paths (and never a prototype key)", () => {
    for (const p of ["a.unknownext", "LICENSE", "", null, undefined, "dir/", "a.constructor", "constructor"]) expect(languageForPath(p)).toBeNull();
  });
});

describe("sniffLanguage and detectLanguage", () => {
  it("reads a shebang and JSON", () => {
    expect(sniffLanguage("#!/usr/bin/env bash\nls")).toBe("bash");
    expect(sniffLanguage("#!/usr/bin/python3\nprint(1)")).toBe("python");
    expect(sniffLanguage('{"a": [1, 2]}')).toBe("json");
    expect(sniffLanguage("[1, 2")).toBeNull();
    expect(sniffLanguage("just words")).toBeNull();
  });
  it("prefers a fence's language, then the path, then the text", () => {
    expect(detectLanguage({ language: "rust", path: "a.py", text: "" })).toBe("rust");
    expect(detectLanguage({ language: "console", path: "a.py", text: "" })).toBe("python");
    expect(detectLanguage({ text: "{}" })).toBe("json");
  });
  it("maps fence names", () => {
    expect(languageForName("ts")).toBe("typescript");
    expect(languageForName("shell")).toBeNull();
    expect(languageForName("nope")).toBeNull();
  });
});

describe("parseNumbered", () => {
  it("strips tab and arrow prefixes, keeping the start", () => {
    expect(parseNumbered("     1\ta\n     2\tb\n")).toEqual({ start: 1, code: "a\nb" });
    expect(parseNumbered("12→  x\n13→y")).toEqual({ start: 12, code: "  x\ny" });
    expect(parseNumbered("   98\ta\n   99\t\n  100\tc")).toEqual({ start: 98, code: "a\n\nc" });
  });
  it("is null for text that is not numbered in order", () => {
    expect(parseNumbered("plain\ntext")).toBeNull();
    expect(parseNumbered("1\ta\n3\tb")).toBeNull();
    expect(parseNumbered("1\ta\nb")).toBeNull();
    expect(parseNumbered("")).toBeNull();
  });
});
