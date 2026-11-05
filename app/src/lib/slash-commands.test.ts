import { describe, expect, it } from "vitest";
import { commandOf } from "@/lib/slash-commands";

const commands = [
  { name: "usage", description: "" },
  { name: "compact", description: "" },
];

describe("commandOf", () => {
  it("finds the agent's command a message starts with, with or without arguments", () => {
    expect(commandOf("/usage", commands)?.name).toBe("usage");
    expect(commandOf("  /compact keep the tests", commands)?.name).toBe("compact");
  });
  it("leaves ordinary messages and unknown slashes alone", () => {
    expect(commandOf("what does /usage do", commands)).toBeUndefined();
    expect(commandOf("/nope", commands)).toBeUndefined();
  });
});
