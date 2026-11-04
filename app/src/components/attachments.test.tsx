// Drag and drop, paste and the Attach button in a chat's composer, and images in the transcript,
// against the real App and the browser mock (src/dev/mock/attachments.ts).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, sendInQuickChat } from "@/test/app";
import { addDropZone, capabilityText, countText, dropHeadline, handleDragEvent, type DragState } from "@/lib/attachments";
import type { AgentReport } from "@/lib/api";

type MockDrag = {
  dragFiles: (files: { name: string; type?: string; size?: number; folder?: boolean }[], x: number, y: number) => Promise<void>;
  moveTo: (x: number, y: number) => Promise<void>;
  dropFiles: (files: { name: string; type?: string; size?: number; folder?: boolean }[], x: number, y: number) => Promise<void>;
  leave: () => Promise<void>;
};
const drag = () => (window as unknown as { __yaahMock: MockDrag }).__yaahMock;

function ipcCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}
const callsOf = (spy: ReturnType<typeof ipcCalls>, cmd: string) => spy.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);

/** Every point is over `el` (happy-dom has no layout to hit-test). */
function pointAt(el: () => Element | null) {
  const spy = vi.spyOn(document, "elementFromPoint").mockImplementation(() => el());
  return () => spy.mockRestore();
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

async function openQuickChat(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
  const composer = await screen.findByRole("combobox", { name: "Message" });
  restore = pointAt(() => composer);
  return composer;
}

const report = (image: boolean, embeddedContext: boolean) => ({ image, embeddedContext }) as AgentReport;

describe("what the drop overlay says", () => {
  it("counts what's dragged", () => {
    expect(
      dropHeadline([
        { name: "a.png", kind: "image" },
        { name: "b.png", kind: "image" },
        { name: "c.md", kind: "file" },
      ]),
    ).toBe("Drop to attach 2 images and 1 file to this message");
    expect(countText([{ kind: "folder" }])).toBe("1 folder");
    expect(countText([{ kind: "image" }, { kind: "file" }, { kind: "folder" }])).toBe("1 image, 1 file and 1 folder");
  });

  it("says what the agent takes", () => {
    const img = [{ name: "a.png", kind: "image" as const }];
    const mixed = [...img, { name: "b.md", kind: "file" as const }];
    expect(capabilityText("Claude", report(true, true), img)).toBe("Claude takes images");
    expect(capabilityText("Claude", report(true, false), mixed)).toBe("Claude takes images; other files go as file references");
    expect(capabilityText("Claude", report(true, true), mixed)).toBe(
      "Claude takes images; small text files go inline, other files as file references",
    );
    expect(capabilityText("Cline", report(false, false), mixed)).toBe(
      "Cline doesn't take images, so they go as file references, like the other files",
    );
    expect(capabilityText("Agent", null, img)).toMatch(/^If Agent takes images/);
    expect(capabilityText("Codex", report(true, true), [{ name: "x.rs", kind: "file" }])).toBe(
      "Small text files go inline, other files as file references",
    );
  });
});

describe("drop zones", () => {
  it("only the pane under the pointer reacts, and only it gets the drop", async () => {
    renderApp();
    const [a, b] = [document.createElement("div"), document.createElement("div")];
    document.body.append(a, b);
    const seen = { a: [] as (DragState | null)[], b: [] as (DragState | null)[] };
    const dropped = { a: [] as string[][], b: [] as string[][] };
    const offA = addDropZone({ el: a, onDrag: (s) => seen.a.push(s), onDrop: (p) => dropped.a.push(p) });
    const offB = addDropZone({ el: b, onDrag: (s) => seen.b.push(s), onDrop: (p) => dropped.b.push(p) });
    let under: Element = a;
    restore = pointAt(() => under);

    handleDragEvent({ type: "enter", paths: ["/x/shot.png", "/x/notes.md"], position: { x: 1, y: 1 } });
    await waitFor(() => expect(seen.a.at(-1)?.items.map((i) => i.kind)).toEqual(["image", "file"]));
    expect(seen.b).toEqual([]);
    // Moving to the other pane moves the overlay.
    under = b;
    handleDragEvent({ type: "over", position: { x: 2, y: 2 } });
    expect(seen.a.at(-1)).toBeNull();
    expect(seen.b.at(-1)?.items).toHaveLength(2);
    handleDragEvent({ type: "drop", paths: ["/x/shot.png", "/x/notes.md"], position: { x: 2, y: 2 } });
    expect(dropped).toEqual({ a: [], b: [["/x/shot.png", "/x/notes.md"]] });
    expect(seen.b.at(-1)).toBeNull();
    // Text from another app has no paths: nothing shows.
    handleDragEvent({ type: "enter", paths: [], position: { x: 2, y: 2 } });
    expect(seen.b.at(-1)).toBeNull();
    offA();
    offB();
    a.remove();
    b.remove();
  });
});

describe("attachments in the composer", () => {
  it("shows the overlay while files are dragged over the chat", async () => {
    const { user } = renderApp();
    await openQuickChat(user);
    await act(() => drag().dragFiles([{ name: "shot.png" }, { name: "plan.png" }, { name: "notes.md" }], 10, 10));
    const overlay = await screen.findByText("Drop to attach 2 images and 1 file to this message");
    expect(overlay).toHaveAttribute("role", "status");
    expect(screen.getByText("Claude takes images; small text files go inline, other files as file references")).toBeInTheDocument();
    await act(() => drag().leave());
    await waitFor(() => expect(screen.queryByText(/Drop to attach/)).toBeNull());
  });

  it("attaches dropped files as chips, removes one, and sends the rest by id", async () => {
    const { user } = renderApp();
    const composer = await openQuickChat(user);
    const invoke = ipcCalls();
    await act(() => drag().dropFiles([{ name: "mockup.png", type: "image/png" }, { name: "notes.md" }, { name: "shop", folder: true }], 10, 10));

    const chips = await screen.findByRole("list", { name: "Attachments" });
    await within(chips).findByText("notes.md");
    expect(within(chips).getByRole("button", { name: /^Open mockup\.png/ })).toBeInTheDocument();
    expect(within(chips).getByText("shop")).toBeInTheDocument();
    expect(within(chips).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/Attached mockup\.png, notes\.md, shop\. 1 image, 1 file and 1 folder attached/)).toBeInTheDocument();
    expect(callsOf(invoke, "stage_attachments")).toEqual([
      expect.objectContaining({ paths: ["/Users/dev/Downloads/mockup.png", "/Users/dev/Downloads/notes.md", "/Users/dev/workspace/shop"] }),
    ]);

    await user.click(within(chips).getByRole("button", { name: "Remove notes.md" }));
    expect(within(chips).queryByText("notes.md")).toBeNull();
    expect(callsOf(invoke, "discard_attachments")).toHaveLength(1);
    expect(screen.getByText(/Removed notes\.md/)).toBeInTheDocument();

    // Attachments alone can be sent; the message carries their ids.
    await user.click(composer);
    await user.type(composer, "what do you think?{Enter}");
    const sent = callsOf(invoke, "send_prompt")[0] as { text: string; attachments: string[] };
    expect(sent.text).toBe("what do you think?");
    expect(sent.attachments).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());

    // The sent message shows them: the image as a thumbnail, the folder as a chip.
    const log = screen.getByRole("log", { name: "Conversation" });
    const attached = await within(log).findByLabelText("1 image and 1 folder attached");
    expect(within(attached).getByRole("button", { name: /^Open mockup\.png/ })).toBeInTheDocument();
    expect(within(attached).getByText("shop")).toBeInTheDocument();
  });

  it("says why something can't be attached", async () => {
    const { user } = renderApp();
    await openQuickChat(user);
    await act(() => drag().dropFiles([{ name: "huge.png" }], 10, 10));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("huge.png is 82 MB; images over 50 MB can't be attached");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("attaches a pasted image by handing its bytes to Rust, and leaves pasted text to the textarea", async () => {
    const { user } = renderApp();
    const composer = await openQuickChat(user);
    const invoke = ipcCalls();
    const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "image.png", { type: "image/png" });
    const event = fireEvent.paste(composer, { clipboardData: { files: [png], getData: () => "" } });
    expect(event).toBe(false); // handled: the textarea doesn't get the file's name
    const chips = await screen.findByRole("list", { name: "Attachments" });
    expect(await within(chips).findByText("Pasted image.png")).toBeInTheDocument();
    const [body] = callsOf(invoke, "stage_pasted_image");
    expect(body).toBeInstanceOf(Uint8Array);

    expect(fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "hello" } })).toBe(true);
    // A pasted file with no path and no image can't be attached.
    fireEvent.paste(composer, { clipboardData: { files: [new File(["x"], "doc.pdf", { type: "application/pdf" })], getData: () => "" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("doc.pdf has no path yaah can attach");
  });

  it("attaches from the OS file picker with the Attach button", async () => {
    const { user } = renderApp();
    await openQuickChat(user);
    const invoke = ipcCalls();
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    const chips = await screen.findByRole("list", { name: "Attachments" });
    expect(await within(chips).findByText("README.md")).toBeInTheDocument();
    expect(within(chips).getByText("mockup.png")).toBeInTheDocument();
    const [picked] = callsOf(invoke, "plugin:dialog|open") as { options: { multiple: boolean; title: string } }[];
    expect(picked.options).toMatchObject({ multiple: true, title: "Attach to this message" });
  });

  it("puts dropped text in the message at the cursor", async () => {
    const { user } = renderApp();
    const composer = await openQuickChat(user);
    await user.type(composer, "see  please");
    (composer as HTMLTextAreaElement).setSelectionRange(4, 4);
    fireEvent.select(composer);
    const log = screen.getByRole("log", { name: "Conversation" });
    fireEvent.drop(log, { dataTransfer: { files: [], getData: (t: string) => (t === "text/plain" ? "the log" : ""), types: ["text/plain"] } });
    await waitFor(() => expect(composer).toHaveValue("see the log please"));
  });
});

describe("images agents send", () => {
  it("shows a tool call's screenshots inline, and a folded group keeps them in sight", async () => {
    const { user } = renderApp({ groupToolCalls: true });
    const log = await sendInQuickChat(user, "take a screenshot of the browser");
    await within(log).findByText(/nothing looks broken/);

    // Four tool calls in a row fold into one row; its two screenshots stay under it.
    const strip = log.querySelector('[data-slot="tool-group-images"]') as HTMLElement;
    expect(strip).not.toBeNull();
    const shots = within(strip).getAllByRole("button", { name: /^Open vitro: screenshot, 960 × 600/ });
    expect(shots).toHaveLength(2);

    // A click opens the large view, titled by the tool call.
    await user.click(shots[1]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("vitro: screenshot")).toBeInTheDocument();
    expect(within(dialog).getByText(/960 × 600 · 55\.9 KB · PNG/)).toBeInTheDocument();
    // An agent's screenshot isn't a file of the user's: nothing to reveal.
    expect(within(dialog).queryByRole("button", { name: /Reveal|Show in file manager/ })).toBeNull();
    await user.keyboard("{Escape}");

    // Opened, the group shows the cards, each with its image under its title.
    await user.click(within(log).getByRole("button", { name: /4 tool calls/ }));
    await waitFor(() => expect(log.querySelector('[data-slot="tool-group-images"]')).toBeNull());
    expect(within(log).getAllByRole("button", { name: /^Open vitro: screenshot/ })).toHaveLength(2);
  });
});
