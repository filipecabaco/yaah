import { beforeEach, describe, expect, it } from "vitest";
import { loadDraft, pruneDrafts, removeDraft, saveDraft } from "@/lib/composer-draft";

describe("composer drafts", () => {
  beforeEach(() => {
    saveDraft("a", { text: "", mentions: {}, picked: {} });
    saveDraft("b", { text: "", mentions: {}, picked: {} });
  });

  it("keeps each chat's unsent text apart", () => {
    saveDraft("a", { text: "hello", mentions: { f: "/x/f" }, picked: {} });
    saveDraft("b", { text: "other", mentions: {}, picked: {} });
    expect(loadDraft("a")).toEqual({ text: "hello", mentions: { f: "/x/f" }, picked: {} });
    expect(loadDraft("b")?.text).toBe("other");
  });

  it("forgets the draft once the text is empty, as after a send", () => {
    saveDraft("a", { text: "hello", mentions: {}, picked: {} });
    saveDraft("a", { text: "", mentions: {}, picked: {} });
    expect(loadDraft("a")).toBeNull();
    expect(localStorage.getItem("yaah.draft.a")).toBeNull();
  });

  it("restores from storage after a reload", () => {
    localStorage.setItem("yaah.draft.c", JSON.stringify({ text: "saved", mentions: {}, picked: {} }));
    expect(loadDraft("c")?.text).toBe("saved");
  });

  const d = (text: string) => ({ text, mentions: {}, picked: {} });
  it("removeDraft forgets a draft in memory and in storage", () => {
    saveDraft("gone", d("x"));
    removeDraft("gone");
    expect(loadDraft("gone")).toBeNull();
    expect(localStorage.getItem("yaah.draft.gone")).toBeNull();
  });
  it("pruneDrafts drops drafts of chats that no longer exist", () => {
    saveDraft("kept", d("a"));
    saveDraft("old", d("b"));
    pruneDrafts(["kept"]);
    expect(localStorage.getItem("yaah.draft.old")).toBeNull();
    expect(localStorage.getItem("yaah.draft.kept")).not.toBeNull();
  });
  it("keeps at most 50 drafts, the least recently edited going first", () => {
    for (let i = 0; i < 52; i++) saveDraft(`s${i}`, d(`t${i}`));
    saveDraft("s2", d("edited"));
    saveDraft("s52", d("last"));
    expect(localStorage.getItem("yaah.draft.s0")).toBeNull();
    expect(localStorage.getItem("yaah.draft.s1")).toBeNull();
    expect(localStorage.getItem("yaah.draft.s2")).not.toBeNull();
    expect(localStorage.getItem("yaah.draft.s3")).toBeNull();
    expect(localStorage.getItem("yaah.draft.s52")).not.toBeNull();
    expect(Object.keys(localStorage).length).toBeLessThanOrEqual(51);
  });
});
