// A streamed chunk re-renders only the chat it belongs to: a chunk for a chat in the
// background commits nothing at all, and each chat keeps its own "stay at bottom".
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { Profiler } from "react";
import { describe, expect, it } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { TranscriptsContext, useTranscript } from "@/hooks/use-transcript";
import { api, type Entry } from "@/lib/api";
import { flushTranscripts, TranscriptStore } from "@/lib/transcripts";
import { setCardRules } from "@/lib/tool-cards";

const agent = (text: string): Entry => ({ type: "agent", text, messageId: null });

describe("the per-session store", () => {
  it("re-renders only the chat a chunk belongs to", async () => {
    const mock = installBrowserMock({ delay: 0 });
    mock.transcripts.a = [agent("in a")];
    mock.transcripts.b = [agent("in b")];
    const store = new TranscriptStore(
      (id, from, limit) => api.getEntries(id, from, limit),
      8,
      () => () => undefined,
    );
    const renders: Record<string, number> = { a: 0, b: 0 };
    function Probe({ id }: { id: string }) {
      const t = useTranscript(id);
      renders[id]++;
      const e = t?.entries[0];
      return <p data-testid={id}>{e && "text" in e ? e.text : "…"}</p>;
    }
    mock.sessions.a = { ...(await api.newQuickChat("default")), sessionId: "a" };
    mock.sessions.b = { ...(await api.newQuickChat("default")), sessionId: "b" };
    render(
      <TranscriptsContext.Provider value={store}>
        <Probe id="a" />
        <Probe id="b" />
      </TranscriptsContext.Provider>,
    );
    await screen.findByText("in b");
    await screen.findByText("in a");
    const before = { ...renders };
    act(() => {
      store.append({ sessionId: "b", index: 0, field: "text", text: " grows", len: 10 });
      store.flush();
    });
    expect(screen.getByTestId("b")).toHaveTextContent("in b grows");
    expect(renders.a).toBe(before.a);
    expect(renders.b).toBe(before.b + 1);
  });

  it("a chunk for a chat in the background commits nothing in the app; the open chat's commits", async () => {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    const a = await api.newQuickChat("default");
    const b = await api.newQuickChat("default");
    Object.assign(mock.sessions[a.sessionId], { title: "chat A" });
    Object.assign(mock.sessions[b.sessionId], { title: "chat B" });
    mock.transcripts[a.sessionId] = [agent("hello from A")];
    mock.transcripts[b.sessionId] = [agent("hello from B")];
    let commits = 0;
    render(
      <Profiler id="app" onRender={() => commits++}>
        <App />
      </Profiler>,
    );
    // Open B (so its transcript is in memory), then A.
    fireEvent.click(await screen.findByRole("button", { name: "chat B" }));
    await screen.findByText("hello from B");
    fireEvent.click(screen.getByRole("button", { name: "chat A" }));
    await screen.findByText("hello from A");
    await new Promise((r) => setTimeout(r, 50));

    commits = 0;
    await act(async () => {
      for (const [i, add] of [" — more", " and more"].entries())
        await emit("session-append", { sessionId: b.sessionId, index: 0, field: "text", text: add, len: [19, 28][i] });
      flushTranscripts();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(commits).toBe(0);

    await act(async () => {
      await emit("session-append", { sessionId: a.sessionId, index: 0, field: "text", text: ", still here", len: 24 });
      flushTranscripts();
    });
    expect(await screen.findByText("hello from A, still here")).toBeInTheDocument();
    expect(commits).toBeGreaterThan(0);
    // B got its chunks too, without being drawn: open it and they're there.
    fireEvent.click(screen.getByRole("button", { name: "chat B" }));
    expect(await screen.findByText("hello from B — more and more")).toBeInTheDocument();
  });
});

describe("stay at bottom", () => {
  it("is per chat: scrolling up in one chat doesn't stop another from following its stream", async () => {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    const a = await api.newQuickChat("default");
    const b = await api.newQuickChat("default");
    Object.assign(mock.sessions[a.sessionId], { title: "chat A" });
    Object.assign(mock.sessions[b.sessionId], { title: "chat B" });
    mock.transcripts[a.sessionId] = [agent("long chat A")];
    mock.transcripts[b.sessionId] = [agent("chat B starts")];
    render(<App />);
    /** The scrolling box around a chat's log, given a size (happy-dom has no layout). */
    const scroller = (height: number) => {
      const el = screen.getByRole("log", { name: "Conversation" }).parentElement as HTMLElement;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: height });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
      return el;
    };

    fireEvent.click(await screen.findByRole("button", { name: "chat A" }));
    await screen.findByText("long chat A");
    const inA = scroller(5000);
    // The user scrolls up to read.
    inA.scrollTop = 100;
    fireEvent.scroll(inA);

    fireEvent.click(screen.getByRole("button", { name: "chat B" }));
    await screen.findByText("chat B starts");
    const inB = scroller(3000);
    expect(inB).not.toBe(inA);
    await act(async () => {
      await emit("session-entry", { sessionId: b.sessionId, index: 1, entry: agent("a new reply in B") });
      flushTranscripts();
    });
    await within(screen.getByRole("log")).findByText("a new reply in B");
    // B follows its stream: it's at the bottom.
    await waitFor(() => expect(inB.scrollTop).toBe(3000));
  });

  it("scrolling up offers Jump to latest, which goes back to the end and follows again", async () => {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    const a = await api.newQuickChat("default");
    Object.assign(mock.sessions[a.sessionId], { title: "chat A" });
    mock.transcripts[a.sessionId] = [agent("a long chat")];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "chat A" }));
    await screen.findByText("a long chat");
    const el = screen.getByRole("log", { name: "Conversation" }).parentElement as HTMLElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    // At the end, then the user scrolls up to read.
    el.scrollTop = 4600;
    fireEvent.scroll(el);
    el.scrollTop = 1000;
    fireEvent.scroll(el);
    const jump = await screen.findByRole("button", { name: "Jump to latest" });
    // A new reply doesn't pull them down while they read.
    await act(async () => {
      await emit("session-entry", { sessionId: a.sessionId, index: 1, entry: agent("a reply") });
      flushTranscripts();
    });
    await screen.findByText("a reply");
    expect(el.scrollTop).toBe(1000);

    fireEvent.click(jump);
    expect(el.scrollTop).toBe(5000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("content growing below doesn't count as scrolling away", async () => {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    const a = await api.newQuickChat("default");
    Object.assign(mock.sessions[a.sessionId], { title: "chat A" });
    mock.transcripts[a.sessionId] = [agent("a chat")];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "chat A" }));
    await screen.findByText("a chat");
    const el = screen.getByRole("log", { name: "Conversation" }).parentElement as HTMLElement;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    // A map below finishes loading: the end moves away, but nobody scrolled up.
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 3000 });
    el.scrollTop = 700;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    await act(async () => {
      await emit("session-entry", { sessionId: a.sessionId, index: 1, entry: agent("more") });
      flushTranscripts();
    });
    await screen.findByText("more");
    await waitFor(() => expect(el.scrollTop).toBe(3000));
  });
});
