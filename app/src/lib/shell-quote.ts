// Paths typed into a shell: what dropping a file on a terminal inserts, as Terminal.app,
// iTerm and Ghostty do (backslash-escaped, so the prompt takes each path as one word).

const SAFE = /^[A-Za-z0-9_./~@%+=:,-]+$/;

/** `path` as one shell word: backslashes before anything special; single quotes when it has a control character (a newline in a name). */
export function shellQuote(path: string): string {
  if (SAFE.test(path)) return path;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return `'${path.replaceAll("'", `'\\''`)}'`;
  return path.replace(/[^A-Za-z0-9_./~@%+=:,-]/g, "\\$&");
}

/** What a drop of `paths` types: each quoted, a space after every one so the next word starts clean. */
export const dropText = (paths: string[]) => paths.map((p) => `${shellQuote(p)} `).join("");
