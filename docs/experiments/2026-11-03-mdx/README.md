# MDX in the Markdown renderer (2026-11-03)

Branch `feat/mdx-permissions-chat-layout`. Checked with vitro on the dev mock (`pnpm dev`, http://localhost:1420): a quick
chat with "Summarise the Realtime docs page as MDX", which replays `mdxReply` in `app/src/dev/mock/chats.ts` (streamed, 48
characters a chunk). The reply is a Supabase-style docs section: YAML frontmatter, an `import` and an `export`, a heading
with `{props.projectRef}`, an `<Admonition type="caution" title=…>`, `<Tabs defaultActiveId="js">` with two `<TabPanel>`s
holding code fences, `<Steps>`, `<details>`/`<summary>`, an unknown `<RealtimeLimits>` and an MDX comment.

Nothing in it runs: MDX is parsed for its syntax only (`micromark-extension-mdx`, no JavaScript parser) and drawn as data.

- `light.png`: as it arrives. Frontmatter folded to one line with its title, imports and the comment gone, the expression
  as inline code, the admonition as an alert (amber for caution), tabs on the JavaScript panel, numbered steps, details
  closed, and the unknown component in a dashed box labelled `<RealtimeLimits>`.
- `light-expanded.png`: frontmatter and details opened, the Dart tab chosen.
- `dark-expanded.png`, `dark.png`: the same in dark mode (`prefers-color-scheme: dark`).

The browser console had no errors. The `[TAURI] Couldn't find callback id` warnings during streaming come from the
browser mock and show up for the plain Markdown reply too.
