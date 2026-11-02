// Agent-built UI rendered for real: a recorded component, and what untrusted
// trees can and can't do (links, images, frames, raw HTML).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import liveUi from "@/dev/fixtures/live-ui.json";
import { installBrowserMock } from "@/dev/browser-mock";
import { UiTree } from "@/components/ui-render";
import { asObj } from "@/lib/narrow";

const rendered = asObj((liveUi as { payload: { entry?: { type: string } } }[]).find((e) => e.payload.entry?.type === "ui")?.payload.entry);

/** Every IPC call the UI makes, by command name. */
function ipcCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}

beforeEach(() => installBrowserMock({ delay: 0 }));

describe("a recorded component", () => {
  it("renders with its bindings resolved", () => {
    render(<UiTree tree={rendered.tree} props={rendered.props} />);
    expect(screen.getByRole("heading", { level: 3, name: "Service status" })).toBeInTheDocument();
    for (const name of ["api", "worker", "billing"]) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText("● Degraded")).toHaveClass("text-amber-700");
    expect(screen.getByText("p95 latency").nextSibling).toHaveTextContent("42ms");
  });

  it("shows unknown node types instead of failing", () => {
    render(<UiTree tree={{ type: "stack", children: [{ type: "hologram" }, "{{who}} was here", 42, null] }} props={{ who: "Ada" }} />);
    expect(screen.getByText("[unknown UI type “hologram”]")).toBeInTheDocument();
    expect(screen.getByText("Ada was here")).toBeInTheDocument();
  });
});

describe("untrusted UI", () => {
  it("only opens http(s) links, in the system browser", async () => {
    const user = userEvent.setup();
    const invoke = ipcCalls();
    render(
      <UiTree
        tree={{
          type: "stack",
          children: [
            { type: "link", props: { text: "docs", href: "https://example.com/docs" } },
            { type: "link", props: { text: "evil", href: "javascript:alert(1)" } },
            { type: "link", props: { text: "local", href: "file:///etc/passwd" } },
            { type: "button", props: { label: "Open", href: "tauri://localhost/" } },
          ],
        }}
        props={{}}
      />,
    );
    expect(screen.getByRole("button", { name: /evil/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /local/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /docs/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", expect.objectContaining({ url: "https://example.com/docs" }), undefined),
    );
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "plugin:opener|open_url")).toHaveLength(1);
  });

  it("loads remote images only on request, data: images at once, and nothing else", async () => {
    const user = userEvent.setup();
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    render(
      <UiTree
        tree={{
          type: "stack",
          children: [
            { type: "image", props: { src: pixel, alt: "screenshot" } },
            { type: "image", props: { src: "https://tracker.example/p.gif", alt: "chart" } },
            { type: "image", props: { src: "javascript:alert(1)" } },
          ],
        }}
        props={{}}
      />,
    );
    expect(screen.getByRole("img", { name: "screenshot" })).toHaveAttribute("src", pixel);
    expect(screen.queryByRole("img", { name: "chart" })).toBeNull();
    expect(screen.getByText(/image not available: javascript:alert/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /load image from tracker\.example/ }));
    expect(screen.getByRole("img", { name: "chart" })).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("frames other origins in a sandbox that can't reach the app", () => {
    render(
      <UiTree
        tree={{
          type: "stack",
          children: [
            { type: "browser", props: { src: "http://127.0.0.1:43117/preview/ab12/index.html", title: "Todo" } },
            { type: "browser", props: { src: `${window.location.origin}/` } },
            { type: "browser", props: { src: "http://tauri.localhost/" } },
            { type: "browser", props: { src: "javascript:alert(1)" } },
          ],
        }}
        props={{}}
      />,
    );
    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const sandbox = frames[0].getAttribute("sandbox")!.split(" ");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
    expect(screen.getByText("Todo — local · index.html")).toBeInTheDocument();
    expect(screen.getAllByText(/Can't preview/)).toHaveLength(3);
  });

  it("renders Markdown without raw HTML or script links", () => {
    render(
      <UiTree
        tree={{ type: "markdown", props: { text: "**hi** <img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com)" } }}
        props={{}}
      />,
    );
    const md = document.querySelector(".markdown") as HTMLElement;
    expect(within(md).getByText("hi").tagName).toBe("STRONG");
    expect(md.querySelector("img")).toBeNull();
    expect(within(md).getByText("click").tagName).toBe("SPAN");
    expect(within(md).getByRole("link", { name: "ok" })).toHaveAttribute("href", "https://example.com");
  });

  it("keeps agent class names out of the styling", () => {
    render(<UiTree tree={{ type: "stack", props: { gap: "constructor", align: "__proto__", justify: "toString" }, children: ["x"] }} props={{}} />);
    const stack = screen.getByText("x").parentElement!;
    expect(stack.className).not.toMatch(/function|object|constructor|proto/);
  });
});

describe("a form outside a chat", () => {
  it("shows what was answered, locked", () => {
    render(
      <UiTree
        tree={{ type: "form", children: [{ type: "textfield", props: { name: "title", label: "Title", required: true } }] }}
        props={{}}
        form={{ answer: { title: "Refund bug" }, onSubmit: () => Promise.resolve() }}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Refund bug");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  it("asks for required fields before sending, with the choices the agent gave as plain strings", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <UiTree
        tree={{
          type: "form",
          props: { submitLabel: "Go" },
          children: [{ type: "choice", props: { name: "size", label: "Size", options: ["S", "M", "L"], required: true } }],
        }}
        props={{}}
        form={{ onSubmit }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Fill in the highlighted fields");
    expect(onSubmit).not.toHaveBeenCalled();

    // A radio group: arrow keys move and pick.
    const group = screen.getByRole("radiogroup", { name: "Size" });
    await user.click(within(group).getByRole("radio", { name: "S" }));
    await user.keyboard("{ArrowDown}");
    expect(within(group).getByRole("radio", { name: "M" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: "M" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onSubmit).toHaveBeenCalledWith({ size: "M" });
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });
});
