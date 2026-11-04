# One MDX-first Markdown renderer (2026-11-04)

Branch `fix/close-pane-on-shell-exit`. Checked with vitro on the dev mock (`pnpm dev`, http://localhost:1420) after
removing the plain Markdown path: every text now goes through the MDX pipeline (`app/src/lib/mdx.ts`,
`app/src/lib/mdx-render.ts`), and a compatibility pass first makes ordinary Markdown read as it always has (stray `<`
escaped, autolinks written as links, comments taken out, braces left as text, indented code kept outside components).

- `mdx-light.png`, `mdx-dark.png`: "Summarise the Realtime docs page as MDX" (`mdxReply` in
  `app/src/dev/mock/chats.ts`). It looks as it did in [2026-11-03-mdx](../2026-11-03-mdx/): frontmatter folded with its
  title, the admonition, the tabs, numbered steps, details closed and the unknown `<RealtimeLimits>` in a dashed box. The
  one change is deliberate: `{props.projectRef}` is now plain text, as braces are in Markdown, not inline code.
- `markdown-light.png`, `markdown-dark.png`: "Explain the retry logic in markdown, with links" (`markdownReply`). The
  web link opens in the browser, the local `config.toml` is inert dotted text, and the `sh` fence is code. The DOM is the
  same as before (`<p>…<a>…</a>…<span>config.toml</span>.</p>`, `<pre><code>`).

The browser console had no errors. The page reloaded a few times during the check because of unrelated edits elsewhere
in the tree (`src/lib/fonts.ts`, `src/dev/mock/settings.ts`), so each reply was sent in a fresh quick chat.
