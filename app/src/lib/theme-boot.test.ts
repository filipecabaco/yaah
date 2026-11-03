// No theme flash: theme.ts keeps the last theme it applied, and public/theme-boot.js
// (run from index.html before the bundle) puts it back up before anything paints.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../../index.html?raw";

const root = document.documentElement;
let runs = 0;
/** Run public/theme-boot.js again (it does its work when loaded, as the page's <script> does). */
const runBoot = () => import(/* @vite-ignore */ `../../public/theme-boot.js?run=${++runs}`);
function reset() {
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  root.className = "";
  localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe("theme-boot.js", () => {
  it("applies the cached theme's colours and polarity", async () => {
    localStorage.setItem(
      "yaah:theme",
      JSON.stringify({ dark: true, tokens: { "--background": "rgb(40 42 54)", "--foreground": "rgb(248 248 242)" } }),
    );
    await runBoot();
    expect(root.style.getPropertyValue("--background")).toBe("rgb(40 42 54)");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("takes only plain colours under variable names (nothing else gets into the page's CSS)", async () => {
    localStorage.setItem(
      "yaah:theme",
      JSON.stringify({
        dark: false,
        tokens: { "--background": "url(https://evil.example/x)", "--ok": "rgb(1 2 3)", "background-image": "rgb(1 2 3)" },
      }),
    );
    await runBoot();
    expect(root.style.getPropertyValue("--background")).toBe("");
    expect(root.style.getPropertyValue("background-image")).toBe("");
    expect(root.style.getPropertyValue("--ok")).toBe("rgb(1 2 3)");
    expect(root.dataset.theme).toBe("light");
  });

  it("does nothing on a first start or with junk in storage", async () => {
    await runBoot();
    localStorage.setItem("yaah:theme", "{not json");
    await runBoot();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.getAttribute("style")).toBeNull();
  });

  it("runs from index.html before the app's code, as a file (script-src 'self' covers it)", () => {
    const boot = html.indexOf('<script src="/theme-boot.js"></script>');
    expect(boot).toBeGreaterThan(0);
    expect(boot).toBeLessThan(html.indexOf('<script type="module"'));
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
  });
});

describe("theme.ts", () => {
  it("caches what it applies, and keeps a restored theme up until the saved settings arrive", async () => {
    vi.resetModules();
    // A dark custom theme from the last run is up (theme-boot.js ran).
    localStorage.setItem("yaah:theme", JSON.stringify({ dark: true, tokens: { "--background": "rgb(1 2 3)" } }));
    await runBoot();
    const theme = await import("@/lib/theme");
    theme.followTheme();
    // Nothing reverted it to yaah's colours while the settings load.
    expect(root.style.getPropertyValue("--background")).toBe("rgb(1 2 3)");
    expect(root.classList.contains("dark")).toBe(true);

    // The settings say: light appearance, a bundled light theme.
    const light = theme.BUNDLED.find((t) => !t.dark && t.palette)!;
    theme.setThemes({ light: light.id, dark: "yaah" });
    theme.setAppearance("light");
    await vi.waitFor(() => expect(root.dataset.theme).toBe("light"));
    // The restored variable is gone, the new theme's are set and cached for the next start.
    const cached = JSON.parse(localStorage.getItem(theme.THEME_CACHE) ?? "null") as { dark: boolean; tokens: Record<string, string> };
    expect(cached.dark).toBe(false);
    expect(root.style.getPropertyValue("--background")).toBe(cached.tokens["--background"]);
    expect(cached.tokens["--background"]).not.toBe("rgb(1 2 3)");
  });

  it("doesn't cache a theme the picker is only previewing", async () => {
    vi.resetModules();
    const theme = await import("@/lib/theme");
    theme.setAppearance("dark");
    await vi.waitFor(() => expect(root.dataset.theme).toBe("dark"));
    const saved = localStorage.getItem(theme.THEME_CACHE);
    const other = theme.BUNDLED.find((t) => !t.dark && t.palette)!;
    theme.previewTheme(other.id);
    await vi.waitFor(() => expect(root.dataset.theme).toBe("light"));
    expect(localStorage.getItem(theme.THEME_CACHE)).toBe(saved);
  });
});
