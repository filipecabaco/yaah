// Settings → Appearance → Fonts against the real App and the browser mock: picking
// a family or a size is what Rust is asked to store, lands as CSS variables on the
// root (which index.css turns into every component's fonts and sizes), and reaches
// the terminals, which re-fit their grid.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTerminalEngine } from "@/components/terminal/engine";
import { readTerminalFont, TERMINAL_FONT } from "@/components/terminal/theme";
import { api, FONT_VARS } from "@/lib/api";
import { applyFonts, codeScale, FONT_CACHE } from "@/lib/fonts";
import { renderApp } from "@/test/app";
import { engines, textEngine } from "@/test/text-engine";

const root = () => document.documentElement.style;

beforeEach(() => setTerminalEngine(textEngine));
afterEach(() => {
  setTerminalEngine(null);
  for (const v of FONT_VARS) root().removeProperty(v);
  localStorage.removeItem(FONT_CACHE);
});

async function openFonts(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: /^settings/i }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("tab", { name: "General" }));
  await within(dialog).findByText("Fonts");
  return dialog;
}

/** Pick `family` in the combobox named `label` ("Interface font", "Code font"). */
async function pick(user: ReturnType<typeof renderApp>["user"], dialog: HTMLElement, label: string, family: string) {
  await user.click(within(dialog).getByRole("combobox", { name: label }));
  const list = await screen.findByRole("listbox", { name: label.replace(" font", " fonts") });
  await user.click(within(list).getByRole("option", { name: family }));
}

describe("Settings → Fonts", () => {
  it("starts on the system default and sets no CSS of its own", async () => {
    const { user } = renderApp();
    const dialog = await openFonts(user);
    expect(within(dialog).getByRole("combobox", { name: "Interface font" })).toHaveTextContent("System default");
    expect(within(dialog).getByRole("combobox", { name: "Code font" })).toHaveTextContent("System default");
    expect(within(dialog).getByRole("slider", { name: "Interface size" })).toHaveAttribute("aria-valuenow", "14");
    expect(within(dialog).getByText(/· default/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /reset to defaults/i })).toBeDisabled();
    for (const v of FONT_VARS) expect(root().getPropertyValue(v)).toBe("");
  });

  it("picks an interface and a code font, each previewed in itself, onto the root and into Rust", async () => {
    const { user } = renderApp();
    const dialog = await openFonts(user);

    await user.click(within(dialog).getByRole("combobox", { name: "Interface font" }));
    const list = await screen.findByRole("listbox", { name: "Interface fonts" });
    expect(within(list).getByRole("option", { name: "Georgia" }).style.fontFamily).toMatch(/^"?Georgia"?, var\(--font-ui\)$/);
    await user.type(screen.getByRole("combobox", { name: "Interface fonts" }), "geor");
    await user.click(within(list).getByRole("option", { name: "Georgia" }));

    await waitFor(() => expect(root().getPropertyValue("--font-ui")).toBe('"Georgia", "Geist Variable", system-ui, sans-serif'));
    expect((await api.generalSettings()).fonts.ui).toBe("Georgia");
    expect(within(dialog).getByRole("combobox", { name: "Interface font" })).toHaveTextContent("Georgia");

    // The code picker lists monospace families first.
    await user.click(within(dialog).getByRole("combobox", { name: "Code font" }));
    const code = await screen.findByRole("listbox", { name: "Code fonts" });
    expect(within(within(code).getByRole("group", { name: "Monospace" })).queryByRole("option", { name: "Georgia" })).toBeNull();
    const options = within(code)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options.indexOf("Menlo")).toBeLessThan(options.indexOf("Georgia"));
    await user.click(within(code).getByRole("option", { name: "Menlo" }));
    await waitFor(() => expect(root().getPropertyValue("--font-code")).toMatch(/^"Menlo", "Geist Mono", ui-monospace, .*monospace$/));

    // Kept for the next start (public/theme-boot.js puts them up before the app loads).
    const cached = JSON.parse(localStorage.getItem(FONT_CACHE) ?? "{}") as Record<string, string>;
    expect(cached["--font-ui"]).toContain("Georgia");
    expect(cached["--font-code"]).toContain("Menlo");
  });

  it("scales the interface and code sizes within their range, and resets everything", async () => {
    const { user } = renderApp();
    const dialog = await openFonts(user);
    const ui = within(dialog).getByRole("slider", { name: "Interface size" });
    ui.focus();
    fireEvent.keyDown(ui, { key: "ArrowRight" });
    await waitFor(() => expect(root().getPropertyValue("--font-ui-scale")).toBe("1.0714"));
    fireEvent.keyDown(ui, { key: "ArrowRight" });
    await waitFor(() => expect(root().getPropertyValue("--font-ui-scale")).toBe("1.1429"));
    expect((await api.generalSettings()).fonts.uiSize).toBe(16);
    // Code follows the interface until it has a size of its own: 12px × 16/14.
    expect(root().getPropertyValue("--font-code-scale")).toBe("");
    expect(codeScale()).toBeCloseTo(1.1429);
    expect(within(dialog).getByText(/14 px · follows the interface/)).toBeInTheDocument();

    // The ends of the range hold.
    fireEvent.keyDown(ui, { key: "End" });
    await waitFor(() => expect(ui).toHaveAttribute("aria-valuenow", "20"));
    fireEvent.keyDown(ui, { key: "ArrowRight" });
    await waitFor(async () => expect((await api.generalSettings()).fonts.uiSize).toBe(20));

    const code = within(dialog).getByRole("slider", { name: "Code size" });
    code.focus();
    fireEvent.keyDown(code, { key: "Home" });
    await waitFor(() => expect(root().getPropertyValue("--font-code-scale")).toBe("0.8333"));
    expect((await api.generalSettings()).fonts.codeSize).toBe(10);

    await pick(user, dialog, "Interface font", "Avenir");
    await waitFor(() => expect(root().getPropertyValue("--font-ui")).toContain("Avenir"));

    await user.click(within(dialog).getByRole("button", { name: /reset to defaults/i }));
    await waitFor(() => expect(root().getPropertyValue("--font-ui")).toBe(""));
    for (const v of FONT_VARS) expect(root().getPropertyValue(v)).toBe("");
    expect((await api.generalSettings()).fonts).toMatchObject({ ui: null, code: null, uiSize: null, codeSize: null });
    expect(localStorage.getItem(FONT_CACHE)).toBeNull();
    expect(within(dialog).getByRole("combobox", { name: "Interface font" })).toHaveTextContent("System default");
  });

  it("refuses what Rust wouldn't build: an unknown family or a size out of range", async () => {
    renderApp();
    await expect(api.setFonts({ ui: "Comic Sans Nowhere", code: null, uiSize: null, codeSize: null })).rejects.toMatch(/installed/);
    await expect(api.setFonts({ ui: null, code: null, uiSize: 21, codeSize: null })).rejects.toMatch(/range/);
    // And the root only ever takes values shaped like Rust's.
    applyFonts({
      "--font-ui": '"x"; } body { display: none',
      "--font-code": "url(https://evil.example)",
      "--font-ui-scale": "1; color: red",
      "--font-code-scale": "2",
    });
    expect(root().getPropertyValue("--font-ui")).toBe("");
    expect(root().getPropertyValue("--font-code")).toBe("");
    expect(root().getPropertyValue("--font-ui-scale")).toBe("");
    expect(root().getPropertyValue("--font-code-scale")).toBe("2");
  });
});

describe("terminals follow the code font", () => {
  it("draw in it from the start, and redraw and re-fit when it or the size changes", async () => {
    expect(readTerminalFont(12)).toEqual({ fontFamily: TERMINAL_FONT, fontSize: 12 });
    root().setProperty("--font-code", '"Menlo", monospace');
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(engines.at(-1)?.font).toEqual({ family: '"Menlo", monospace', size: 12 }));
    const term = engines.at(-1)!;
    const fitted = term.fits;

    // Settings → Fonts sets the root's variables: the open terminal takes them and fits its grid again.
    applyFonts({
      "--font-ui": null,
      "--font-code": '"Courier New", "Geist Mono", monospace',
      "--font-ui-scale": "1.2857",
      "--font-code-scale": "1.5",
    });
    await waitFor(() => expect(term.font).toEqual({ family: '"Courier New", "Geist Mono", monospace', size: 18 }));
    expect(term.fits).toBeGreaterThan(fitted);

    // A change that isn't to the fonts (a theme) doesn't re-fit.
    const after = term.fits;
    root().setProperty("--background", "rgb(1 2 3)");
    await new Promise((r) => setTimeout(r, 20));
    expect(term.fits).toBe(after);
    root().removeProperty("--background");

    // Back to the default: the interface scale alone sizes it.
    applyFonts({ "--font-ui": null, "--font-code": null, "--font-ui-scale": "1.2857", "--font-code-scale": null });
    await waitFor(() => expect(term.font).toEqual({ family: TERMINAL_FONT, size: 15.4 }));
  });
});
