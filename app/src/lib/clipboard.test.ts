import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, installCopyOnSelect, onCopied, setCopyOnSelect } from "@/lib/clipboard";

const select = (el: Node) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(range);
};
const release = async () => {
  window.dispatchEvent(new MouseEvent("mouseup"));
  await new Promise((r) => setTimeout(r, 5));
};

describe("copy on select", () => {
  const write = vi.fn(() => Promise.resolve());
  let off: () => void;
  beforeEach(() => {
    write.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    document.body.innerHTML = '<div data-copy-on-select><p id="in">inside</p></div><p id="out">outside</p>';
    setCopyOnSelect(true);
    off = installCopyOnSelect();
  });
  afterEach(() => {
    off();
    window.getSelection()?.removeAllRanges();
  });

  it("copies text selected inside a marked area, once", async () => {
    select(document.getElementById("in")!);
    await release();
    await release();
    expect(write).toHaveBeenCalledExactlyOnceWith("inside");
  });

  it("leaves text elsewhere, and everything when it is off", async () => {
    select(document.getElementById("out")!);
    await release();
    setCopyOnSelect(false);
    select(document.getElementById("in")!);
    await release();
    expect(write).not.toHaveBeenCalled();
  });

  it("says what was copied", async () => {
    const heard = vi.fn();
    const stop = onCopied(heard);
    await copyText("x", "Copied path");
    stop();
    expect(heard).toHaveBeenCalledWith("Copied path");
  });
});
