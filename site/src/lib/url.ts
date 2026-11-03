// Links to files in public/ must carry the site's base path (/yaah/ on GitHub Pages).
// BASE_URL is "/yaah" or "/yaah/" depending on Astro's trailingSlash setting, and "/" with
// no base, so join with exactly one slash either way.
const base = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** A root-relative URL for a file in public/, e.g. asset("shots/x.webp") → "/yaah/shots/x.webp". */
export function asset(path: string): string {
  return `${base}/${path.replace(/^\/+/, "")}`;
}

/** The same file as an absolute URL on the deployed site (for canonical and Open Graph tags). */
export function absolute(path: string, site: URL | undefined): string {
  const href = asset(path);
  return site ? new URL(href, site).href : href;
}

export const REPO = "https://github.com/filipecabaco/yaah";
export const RELEASES = `${REPO}/releases`;
export const INSTALL = "curl -fsSL https://raw.githubusercontent.com/filipecabaco/yaah/main/install.sh | sh";
