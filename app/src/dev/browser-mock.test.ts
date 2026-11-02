// The browser mock against the API contract: every command api.ts invokes has
// a reply, a reinstall starts from fresh state, and a replay pauses on its
// permission card until it is answered.
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { api, events, type Entry, type SessionInfo } from "@/lib/api";
import source from "@/lib/api.ts?raw";
import { installBrowserMock } from "./browser-mock";

afterEach(() => vi.restoreAllMocks());

it("answers every command src/lib/api.ts invokes", async () => {
  const commands = [...source.matchAll(/\binvoke\b(?:<.*?>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(commands).toHaveLength(source.match(/\binvoke\s*[<(]/g)?.length ?? -1);
  installBrowserMock({ delay: 0 });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Without arguments most fail; only a missing reply warns.
  await Promise.allSettled(commands.map((cmd) => invoke(cmd)));
  expect(warn.mock.calls.filter(([m]) => String(m).includes("no fixture"))).toEqual([]);
});

it("starts from fresh state on every install", async () => {
  installBrowserMock({ delay: 0 });
  await api.renameProject("p1", "renamed");
  expect((await api.listProjects()).map((p) => p.name)).toEqual(["renamed"]);
  installBrowserMock({ delay: 0 });
  expect((await api.listProjects()).map((p) => p.name)).toEqual(["billing revamp"]);
  // Failed commands reject with the message string, as Tauri does.
  await expect(api.saveAgent({ id: null, label: " ", preset: "claude", commandLine: "x", env: {}, configDir: null })).rejects.toBe(
    "give the agent a name",
  );
});

it("pauses a replay on its permission card until it is answered", async () => {
  installBrowserMock({ delay: 0 });
  const entries: Entry[] = [];
  let info: SessionInfo | undefined;
  const offEntry = await events.sessionEntry((e) => (entries[e.index] = e.entry));
  const offInfo = await events.sessionInfo((i) => (info = i));
  const chat = await api.newQuickChat("default");
  await api.sendPrompt(chat.sessionId, "write hello.txt");

  await vi.waitFor(() => expect(entries.some((e) => e.type === "permission")).toBe(true));
  const index = entries.findIndex((e) => e.type === "permission");
  expect(entries[0]).toMatchObject({ type: "user", text: "write hello.txt" });
  expect(info?.running).toBe(true);

  await api.respondPermission(chat.sessionId, index, "allow-once");
  await vi.waitFor(() => expect(info?.stopReason).toBe("end_turn"));
  expect(entries[index]).toMatchObject({ type: "permission", chosen: "Yes" });
  expect((await api.getTranscript(chat.sessionId)).entries).toHaveLength(entries.length);
  offEntry();
  offInfo();
});
