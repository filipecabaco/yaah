import { describe, expect, it } from "vitest";
import { dropText, shellQuote } from "./shell-quote";

describe("shellQuote", () => {
  it("leaves plain paths alone", () => expect(shellQuote("/Users/me/a-b_c.txt")).toBe("/Users/me/a-b_c.txt"));
  it("escapes spaces and shell characters", () => {
    expect(shellQuote("/tmp/My File (1).png")).toBe("/tmp/My\\ File\\ \\(1\\).png");
    expect(shellQuote("it's $HOME;rm")).toBe("it\\'s\\ \\$HOME\\;rm");
  });
  it("single-quotes a name with a newline in it", () => expect(shellQuote("a\nb'c")).toBe("'a\nb'\\''c'"));
});

describe("dropText", () => {
  it("is each path, quoted, then a space", () => expect(dropText(["/a b", "/c"])).toBe("/a\\ b /c "));
});
