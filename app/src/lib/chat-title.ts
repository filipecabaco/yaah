// A chat's title is the start of its first message, as typed. For display only, the Markdown markers
// in it are dropped (the stored text is not changed).

/** `**bold**`, `` `code` ``, `# heading`, `[text](url)`, `> quote` and list bullets, read as the plain words they carry. */
export function displayTitle(title: string): string {
  return title
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
