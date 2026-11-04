// `#` references in the composer and the transcript, against the browser mock
// (src/dev/mock/references.ts stands in for references.rs).
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/app";
import { api } from "@/lib/api";
import { findReferenceTrigger, segments, standing } from "@/lib/references";

describe("finding the trigger", () => {
  const at = (text: string) => findReferenceTrigger(text, text.length);
  it("opens on #, github#, gitlab# and linear# as a word, and on a link", () => {
    expect(at("#")).toEqual({ start: 0, query: "", service: null, link: false });
    expect(at("see #webh")).toEqual({ start: 4, query: "webh", service: null, link: false });
    expect(at("fix github#acme")).toEqual({ start: 4, query: "acme", service: "github", link: false });
    expect(at("(GitLab#!45")).toEqual({ start: 1, query: "!45", service: "gitlab", link: false });
    expect(at("linear#ENG-1")).toEqual({ start: 0, query: "ENG-1", service: "linear", link: false });
    expect(at("github#acme/api#9")?.query).toBe("acme/api#9");
    expect(at("look https://github.com/acme/api/pull/9")).toEqual({
      start: 5,
      query: "https://github.com/acme/api/pull/9",
      service: null,
      link: true,
    });
  });
  it("stays shut inside words, code and after a space", () => {
    for (const text of ["C#", "issue#12", "`#x", "# heading", "github#acme done", "jira#X-1"]) expect(at(text), text).toBeNull();
  });
});

describe("marking sent references", () => {
  const ref = (token: string) => ({
    service: "github" as const,
    kind: "pr" as const,
    id: token.slice(7),
    token,
    title: "t",
    url: "u",
    state: "open" as const,
    scope: "a/b",
  });
  it("cuts the text at each token Rust read, any case, as its own word", () => {
    const r = ref("github#a/b#9");
    expect(segments("see github#a/b#9, and github#a/b#90 or xgithub#a/b#9", [r])).toEqual([
      { text: "see " },
      { text: "github#a/b#9", reference: r },
      { text: ", and github#a/b#90 or xgithub#a/b#9" },
    ]);
    expect(segments("GITHUB#A/B#9", [r])).toEqual([{ text: "GITHUB#A/B#9", reference: r }]);
    expect(segments("plain", undefined)).toEqual([{ text: "plain" }]);
    expect(standing("fix github#a/b#9.", "github#a/b#9")).toBe(true);
    expect(standing("fix github#a/b#99", "github#a/b#9")).toBe(false);
  });
});

async function quickChat() {
  const app = renderApp();
  await app.user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
  const composer = await screen.findByRole("combobox", { name: "Message" });
  return { ...app, composer };
}

/** The listed tokens (each option's value). */
const options = () => screen.queryAllByRole("option").map((o) => o.getAttribute("data-value") ?? "");
const texts = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");

describe("the # list", () => {
  it("lists every connected service on #, and one service after its name", async () => {
    const { user, composer } = await quickChat();
    await user.type(composer, "#");
    expect(composer).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("option", { name: /acme\/api#231/ })).toBeInTheDocument();
    expect(screen.getByText("Pull requests, merge requests and issues")).toBeInTheDocument();
    expect(options().some((o) => o.includes("ENG-142"))).toBe(true);
    // GitLab's token was revoked: it says so, and the others still list.
    expect(screen.getByText(/GitLab refused the credential/)).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "linear#");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    await waitFor(() => expect(options().every((o) => o.startsWith("linear#"))).toBe(true));
    expect(screen.getByText("Linear issues")).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "github#");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    await waitFor(() => expect(options().every((o) => o.startsWith("github#"))).toBe(true));
    expect(texts().some((o) => o.includes("PR")) && texts().some((o) => o.includes("issue"))).toBe(true);
  });

  it("lists GitLab merge requests and issues once it can read them", async () => {
    const { user, composer, mock } = await quickChat();
    mock.gitlabRevoked = false;
    await user.type(composer, "gitlab#");
    expect(await screen.findByRole("option", { name: /acme\/platform\/billing!58/ })).toHaveTextContent("MR");
    expect(screen.getByRole("option", { name: /acme\/platform\/billing#19/ })).toHaveTextContent("issue");
  });

  it("narrows as you type, then shows what the search found", async () => {
    const { user, composer } = await quickChat();
    await user.type(composer, "#");
    await screen.findByRole("option", { name: /acme\/api#231/ });
    await user.type(composer, "dotfiles");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]).toContain("ghopper/dotfiles#3");
    await user.clear(composer);
    await user.type(composer, "#nothing-like-this");
    expect(await screen.findByText("Nothing matches. Keep typing to search, or paste a link.")).toBeInTheDocument();
  });

  it("moves with the arrows, inserts the token with Tab or Enter, and closes with Esc", async () => {
    const { user, composer } = await quickChat();
    await user.type(composer, "see #webhook");
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(composer).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{ArrowDown}");
    const second = screen.getAllByRole("option")[1];
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    expect(composer).toHaveAttribute("aria-activedescendant", second.id);
    const token = second.getAttribute("data-value")!;
    await user.keyboard("{Tab}");
    expect(composer).toHaveValue(`see ${token} `);
    expect(composer).toHaveAttribute("aria-expanded", "false");
    expect(composer).not.toHaveAttribute("aria-activedescendant");
    // What it will attach shows under the composer.
    expect(screen.getByLabelText("References this message attaches")).toHaveTextContent(token.replace(/^\w+#/, ""));

    await user.type(composer, "#");
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");
    expect(composer).toHaveAttribute("aria-expanded", "false");
    expect((composer as HTMLTextAreaElement).value).toMatch(/ #$/);
  });

  it("turns a pasted link into a reference", async () => {
    const { user, composer } = await quickChat();
    await user.click(composer);
    await user.paste("https://github.com/acme/api/pull/231/files");
    expect(await screen.findByRole("option", { name: /acme\/api#231/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("github#acme/api#231 ");
    // Any other link stays a link, with no list.
    await user.paste("https://example.com/page");
    await new Promise((r) => setTimeout(r, 400));
    expect(composer).toHaveAttribute("aria-expanded", "false");
  });

  it("offers Settings → Integrations when nothing is connected", async () => {
    const { user, composer, mock } = await quickChat();
    for (const s of Object.values(mock.integrations)) s.connected = false;
    await user.type(composer, "#");
    const row = await screen.findByRole("option", { name: /Connect GitHub, GitLab or Linear/ });
    expect(screen.getAllByRole("option")).toEqual([row]);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tab", { name: /Integrations/i, selected: true })).toBeInTheDocument();
  });
});

describe("sending references", () => {
  it("sends the text as typed and shows each reference as a link, or why it couldn't be read", async () => {
    const { user, composer } = await quickChat();
    const send = vi.spyOn(api, "sendPrompt");
    await user.type(composer, "#231");
    await waitFor(() => expect(options()[0]).toBe("github#acme/api#231"));
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("github#acme/api#231 ");
    await user.type(composer, "and github#acme/nope#1 {Enter}");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Rust parses and reads the tokens: the text goes as typed, nothing else is added for them.
    expect(send.mock.calls[0].slice(1, 3)).toEqual(["github#acme/api#231 and github#acme/nope#1", []]);

    const log = screen.getByRole("log", { name: "Conversation" });
    const link = await within(log).findByRole("link", { name: "GitHub PR acme/api#231, Retry webhooks once after a timeout, open" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/api/pull/231");
    expect(within(log).getByLabelText(/GitHub PR acme\/nope#1, couldn't be read: GitHub: not found/)).toBeInTheDocument();
    expect(within(log).getByText(/Sent without its details/)).toBeInTheDocument();
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(screen.queryByLabelText("References this message attaches")).toBeNull();
  });
});
