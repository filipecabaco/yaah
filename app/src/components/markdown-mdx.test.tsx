// Every text is read as MDX, drawn as data: frontmatter folded, ESM hidden, a few
// docs components on yaah's primitives, unknown ones in a labelled box, braces as
// text, and nothing ever evaluated. Plain Markdown renders as it did with
// react-markdown + remark-gfm alone, except for the HTML differences listed below.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { Markdown, WholeMarkdown } from "@/components/markdown";
import { mdxBlocks, openTags, prepareMdx, scanJsx, splitFrontmatter } from "@/lib/mdx";

const draw = (text: string) => render(<Markdown>{text}</Markdown>).container;
const html = (el: React.ReactElement) => {
  const { container, unmount } = render(el);
  // A fenced block's Copy button is drawn around its `pre`; these tests are about the text's own markup.
  container.querySelectorAll("[data-code-copy]").forEach((w) => w.replaceWith(...Array.from(w.children).filter((c) => c.tagName === "PRE")));
  // React ids (Radix tabs) differ from one render to the next.
  const out = container.innerHTML.replace(/_r_[a-z0-9]+_/g, "_r_");
  unmount();
  return out;
};

/** A Supabase-style docs page. */
const DOCS = `---
title: Realtime
description: Listen to database changes.
---

import Tabs from "@site/src/components/Tabs";
import { Admonition } from "ui";
export const meta = { sidebar: "realtime" };

# Postgres changes

Listen to inserts on the \`messages\` table for project {props.projectRef}.

<Admonition type="caution" title="Enable replication first">

Turn on **replication** for the table, then:

- subscribe
- listen

</Admonition>

<Tabs scrollable size="small" type="underlined" defaultActiveId="ts" queryGroup="language">
  <TabPanel id="js" label="JavaScript">

\`\`\`js
const channel = supabase.channel("room1");
\`\`\`

  </TabPanel>
  <TabPanel id="ts" label="TypeScript">

Typed *channels* with \`<T>\`.

  </TabPanel>
</Tabs>

{/* An MDX comment: not shown. */}

That's all.
`;

describe("the compatibility pass", () => {
  it("keeps a < that doesn't start JSX as text", () => {
    expect(prepareMdx("a < b, a<=b, Vec<T>, Option<String>, Map<K, V>, <Enter> to go, <foo>x</foo>, </div>")).toBe(
      "a \\< b, a\\<=b, Vec\\<T>, Option\\<String>, Map\\<K, V>, \\<Enter> to go, \\<foo>x\\</foo>, \\</div>",
    );
    // `<Tab>` is mapped, but only opens unclosed alone on its line; `<>` only as a fragment on lines of its own.
    expect(prepareMdx("Press <Tab> to complete, where a <> b")).toBe("Press \\<Tab> to complete, where a \\<> b");
    // A tag still streaming in is text until it ends.
    expect(prepareMdx('<Note type="x')).toBe('\\<Note type="x');
  });

  it("keeps closed, self-closing and void tags, and mapped components opening alone on a line", () => {
    expect(prepareMdx("<Badge>new</Badge>, <Thing />, <kbd>K</kbd>, a<br>b, <hr>")).toBe(
      "<Badge>new</Badge>, <Thing />, <kbd>K</kbd>, a<br />b, <hr />",
    );
    expect(prepareMdx("<Note>\n\nStreaming…")).toBe("<Note>\n\nStreaming…");
    expect(prepareMdx('  <Tabs defaultValue="a">')).toBe('  <Tabs defaultValue="a">');
    expect(prepareMdx("<>\n\nfragment\n\n</>")).toBe("<>\n\nfragment\n\n</>");
  });

  it("writes autolinks as links, and leaves link destinations alone", () => {
    expect(prepareMdx("See <https://example.com/a_b> or <me@example.com>.")).toBe(
      "See [https\\:\\/\\/example\\.com\\/a\\_b](<https://example.com/a_b>) or [me\\@example\\.com](<mailto:me@example.com>).",
    );
    expect(prepareMdx("[a](<b c>) and\n\n[ref]: <https://x.com>")).toBe("[a](<b c>) and\n\n[ref]: <https://x.com>");
  });

  it("takes out HTML and MDX comments, inline or over several lines", () => {
    expect(prepareMdx("a <!-- x --> b {/* y */} c\n<!--\nhidden\n-->\nd")).toBe("a  b  c\n\nd");
    expect(prepareMdx("a\n{/* own line */}\nb")).toBe("a\nb");
  });

  it("leaves braces, code spans, fenced and indented code alone", () => {
    const src = "{x} and `a < b` and ``<T>``\n\n```\n<T> {y}\n```\n\n    if a < b {}\n\n- item\n\n      <T> code\n\n- next";
    expect(prepareMdx(src)).toBe(src);
  });

  it("only takes out import and export lines that are ESM", () => {
    for (const text of ["export PATH=$HOME/bin:$PATH", "import os", "export default is the usual choice", "export function names, then import them"])
      expect(prepareMdx(text), text).toBe(text);
    expect(prepareMdx('import { A } from "a"\nexport const b = 1\nexport default function C() {}\n\nText')).toBe("\nText");
  });

  it("turns indented code off only for a block with a component on its own lines", () => {
    expect(scanJsx("Para.\n\n    code").flow).toBe(false);
    expect(scanJsx("Press <kbd>K</kbd>.").flow).toBe(false);
    expect(scanJsx("<Note>\n    indented content\n</Note>").flow).toBe(true);
    expect(scanJsx("- <Note>x</Note>").flow).toBe(true);
  });
});

describe("text helpers", () => {
  it("splits frontmatter off only when it is YAML", () => {
    expect(splitFrontmatter("---\ntitle: A\n---\nBody")).toEqual({ yaml: "title: A", body: "Body" });
    expect(splitFrontmatter("---\nnot yaml\n---\nBody").yaml).toBeNull();
  });

  it("takes ESM and HTML comments out, and closes void tags, but leaves code alone", () => {
    const src =
      'import A from "a";\nimport {\n  B,\n} from "b";\n\nText<br> <!-- gone -->\n\n```html\n<br><!-- kept -->\nimport x from "y";\n```\n\n`<br>`';
    expect(prepareMdx(src)).toBe('\nText<br /> \n\n```html\n<br><!-- kept -->\nimport x from "y";\n```\n\n`<br>`');
  });

  it("keeps the blocks of a JSX element together", () => {
    expect(openTags('<Tabs a="x>y">\n<Tab>\n</Tab>')).toEqual(["Tabs"]);
    expect(openTags("<Img src={a > b} />\n<br />")).toEqual([]);
    expect(openTags("`<Tabs>` and a < b")).toEqual([]);
    expect(mdxBlocks("Intro\n\n<Note>\n\nOne\n\nTwo\n\n</Note>\n\nAfter")).toEqual(["Intro", "\n<Note>\n\nOne\n\nTwo\n\n</Note>", "\nAfter"]);
  });
});

describe("MDX", () => {
  it("folds frontmatter into a closed metadata block", () => {
    const c = draw(DOCS);
    const fm = c.querySelector('details[data-mdx="frontmatter"]')!;
    expect(fm).not.toHaveAttribute("open");
    expect(fm.querySelector("summary")).toHaveTextContent("Frontmatter · Realtime");
    expect(fm.querySelector("pre")).toHaveTextContent("description: Listen to database changes.");
    // Not a rule and a setext heading.
    expect(c.querySelector("hr")).toBeNull();
    expect(c.querySelector('[data-md="h2"]')).toBeNull();
  });

  it("hides import and export lines", () => {
    const c = draw(DOCS);
    expect(c.textContent).not.toMatch(/import|export|@site|sidebar/);
    // An agent's `#` sits one level under the pane's title (SR-5): an h2 that remembers it was an h1.
    expect(c.querySelector('h2[data-md="h1"]')).toHaveTextContent("Postgres changes");
  });

  it("shows braces as text, as Markdown does, and drops MDX comments", () => {
    const c = draw(DOCS);
    expect(c.querySelector('[data-md="h1"] + p')).toHaveTextContent("Listen to inserts on the messages table for project {props.projectRef}.");
    expect([...c.querySelectorAll("code")].map((e) => e.textContent)).not.toContain("{props.projectRef}");
    expect(c.textContent).not.toContain("An MDX comment");
    expect(c.textContent).toContain("That's all.");
  });

  it("maps admonitions onto an alert, with their Markdown inside", () => {
    const c = draw(DOCS);
    const alert = c.querySelector('[data-mdx="admonition"]')!;
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("data-type", "caution");
    expect(within(alert as HTMLElement).getByText("Enable replication first")).toBeInTheDocument();
    expect(alert.querySelector("strong")).toHaveTextContent("replication");
    expect(alert.querySelectorAll("li")).toHaveLength(2);
  });

  it.each([
    ["<Note>\n\nA note.\n\n</Note>", "note", "Note"],
    ['<Tip title="Faster">\n\nCache it.\n\n</Tip>', "tip", "Faster"],
    ["<Info>Short info.</Info>", "info", "Info"],
    ["<Warning>\nCareful.\n</Warning>", "warning", "Warning"],
    ['<Caution label="Mind it">x</Caution>', "caution", "Mind it"],
    ["<Danger>\n\nDrops the table.\n\n</Danger>", "danger", "Danger"],
    ['<Callout type="warning">\n\nCallout.\n\n</Callout>', "warning", "Warning"],
  ])("draws %j as a %s alert", (src, type, title) => {
    const alert = draw(src).querySelector('[data-mdx="admonition"]')!;
    expect(alert).toHaveAttribute("data-type", type);
    expect(alert.querySelector('[data-slot="alert-title"]')).toHaveTextContent(title);
  });

  it("maps Tabs and TabPanel onto tabs, opening the default one", async () => {
    const user = userEvent.setup();
    draw(DOCS);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["JavaScript", "TypeScript"]);
    expect(screen.getByRole("tab", { name: "TypeScript" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Typed channels with <T>.");
    await user.click(screen.getByRole("tab", { name: "JavaScript" }));
    expect(screen.getByRole("tabpanel").querySelector("pre code")).toHaveTextContent('const channel = supabase.channel("room1");');
  });

  it("takes tab labels from label, title or value (Docusaurus and Mintlify style)", () => {
    draw('<Tabs>\n<TabItem value="npm" label="npm" default>\nnpm i\n</TabItem>\n<TabItem value="pnpm">\npnpm add\n</TabItem>\n</Tabs>');
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["npm", "pnpm"]);
    render(<Markdown>{'<Tabs>\n  <Tab title="First">One</Tab>\n  <Tab title="Second">Two</Tab>\n</Tabs>'}</Markdown>);
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
  });

  it("maps details and summary", () => {
    const c = draw("<details>\n<summary>More **info**</summary>\n\nHidden text.\n\n</details>");
    const d = c.querySelector("details")!;
    expect(d.firstElementChild?.tagName).toBe("SUMMARY");
    expect(d.querySelector("summary strong")).toHaveTextContent("info");
    expect(d).toHaveTextContent("Hidden text.");
    expect(d).not.toHaveAttribute("open");
    const bare = draw("<details>\n\nNo summary.\n\n</details>").querySelector("details")!;
    expect(bare.firstElementChild).toHaveTextContent("Details");
    expect(bare.querySelectorAll("summary")).toHaveLength(1);
  });

  it("numbers Steps", () => {
    const c = draw('<Steps>\n<Step title="Install">Run `pnpm i`.</Step>\n<Step title="Use">\n\nCall it.\n\n</Step>\n</Steps>');
    const steps = [...c.querySelectorAll('[data-mdx="step"]')];
    expect(steps.map((s) => s.textContent)).toEqual(["1InstallRun pnpm i.", "2UseCall it."]);
  });

  it("maps Cards and Card, linking only to the web", () => {
    const c = draw(
      '<Cards>\n<Card title="Docs" href="https://supabase.com/docs">Read them.</Card>\n<Card title="Local" href="file:///etc/passwd">No.</Card>\n</Cards>',
    );
    const cards = c.querySelectorAll('[data-mdx="card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("a")).toHaveAttribute("href", "https://supabase.com/docs");
    expect(cards[1].querySelector("a")).toBeNull();
    expect(cards[1]).toHaveTextContent("LocalNo.");
  });

  it("draws images exactly as Markdown's: remote after a click, others as Markdown would", async () => {
    const user = userEvent.setup();
    const c = draw('<Image src="https://example.com/a.png" alt="Diagram" />\n\n<img src="./local.png" alt="local" />\n\n<Image src={logo} />');
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).not.toContain("local");
    await user.click(screen.getByRole("button", { name: /Diagram · load image from example.com/ }));
    expect(c.querySelector('img[src="https://example.com/a.png"]')).toHaveAttribute("referrerpolicy", "no-referrer");
    // The same element Markdown's ![…](…) draws, for every kind of source.
    for (const src of ["https://example.com/b.png", "./local.png", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
      const md = html(<Markdown>{`![pic](${src})\n\n<Note>x</Note>`}</Markdown>);
      const mdx = html(<Markdown>{`<img src="${src}" alt="pic" />\n\n<Note>x</Note>`}</Markdown>);
      expect(mdx).toBe(md);
    }
  });

  it("shows an unknown component's children in a box labelled with its name", () => {
    const c = draw('<Mystery kind="x">\n\nInside **mystery**.\n\n</Mystery>\n\n<Thing />\n\nInline <Badge>new</Badge> here.');
    const [box, empty] = c.querySelectorAll('div[data-mdx="unknown"]');
    expect(box).toHaveTextContent("<Mystery>Inside mystery.");
    expect(box.querySelector("strong")).toHaveTextContent("mystery");
    expect(empty).toHaveTextContent("<Thing />");
    expect(c.querySelector('span[data-mdx="unknown"]')).toHaveAttribute("title", "<Badge>");
    expect(c).toHaveTextContent("Inline new here.");
  });

  it("draws Markdown nested in JSX nested in JSX", () => {
    const c = draw(
      '<Tabs>\n  <TabPanel id="a" label="A">\n    <Note>\n      1. **one**\n      2. [two](https://example.com)\n    </Note>\n  </TabPanel>\n</Tabs>',
    );
    const alert = c.querySelector('[role="tabpanel"] [data-mdx="admonition"]')!;
    expect(alert.querySelectorAll("ol li")).toHaveLength(2);
    expect(alert.querySelector("strong")).toHaveTextContent("one");
    expect(alert.querySelector("a")).toHaveAttribute("href", "https://example.com");
  });

  it("passes no attributes to the DOM, and draws HTML elements as themselves", () => {
    const c = draw(
      '<div className="evil" style={{color: "red"}} onClick="alert(1)">\n\n<kbd>⌘K</kbd> then <a href="javascript:alert(1)">this</a>\n\n</div>\n\n<Note>\n\nok\n\n</Note>',
    );
    expect(c.querySelector("[onclick], [style], .evil")).toBeNull();
    expect(c.querySelector("kbd")).toHaveTextContent("⌘K");
    expect(c.querySelector("a")).toBeNull();
    expect(c).toHaveTextContent("⌘K then this");
  });

  it("treats names and props that look like object keys as unknown", () => {
    const c = draw(
      '<Admonition type="constructor">\n\nA\n\n</Admonition>\n\n<Admonition type="">\n\nB\n\n</Admonition>\n\n<toString>\n\nC\n\n</toString>\n\n<__proto__ x="1">D</__proto__>\n\n<Tabs>\n<Tab value="__proto__">E</Tab>\n</Tabs>',
    );
    const [a, b] = c.querySelectorAll('[data-mdx="admonition"]');
    expect(a).toHaveTextContent("ConstructorA");
    expect(b).toHaveTextContent("NoteB");
    expect([...c.querySelectorAll('div[data-mdx="unknown"]')].map((e) => e.textContent)).toEqual(["<toString>C", "<__proto__>D"]);
    expect(screen.getByRole("tab")).toHaveTextContent("__proto__");
  });

  it("draws block by block exactly as one whole render does", () => {
    expect(html(<Markdown>{DOCS}</Markdown>)).toBe(html(<WholeMarkdown>{DOCS}</WholeMarkdown>));
  });
});

describe("never evaluates anything", () => {
  it("leaves globals untouched by expressions, attributes and exports", () => {
    const g = globalThis as { __pwned?: unknown };
    delete g.__pwned;
    const c = draw(
      [
        "export const x = (globalThis.__pwned = 1)",
        "export default function Layout() { globalThis.__pwned = 2 }",
        "",
        "Text {globalThis.__pwned = 3} here.",
        "",
        "{(() => { globalThis.__pwned = 4 })()}",
        "",
        "<Note title={globalThis.__pwned = 5} {...(globalThis.__pwned = 6)}>",
        "",
        "Body",
        "",
        "</Note>",
        "",
        '<img src="x" onError={() => (globalThis.__pwned = 7)} />',
      ].join("\n"),
    );
    expect(g.__pwned).toBeUndefined();
    // Braces are text: shown as written.
    expect(c).toHaveTextContent("Text {globalThis.__pwned = 3} here. {(() => { globalThis.__pwned = 4 })()}");
    // The title was an expression: ignored, so the alert falls back to its type.
    expect(c.querySelector('[data-slot="alert-title"]')).toHaveTextContent("Note");
  });
});

describe("malformed and partial MDX", () => {
  it("never throws, and draws block by block as a whole render does, at any point of a streamed docs page", () => {
    for (let n = 1; n <= DOCS.length; n += 3) {
      const text = DOCS.slice(0, n);
      expect(html(<Markdown>{text}</Markdown>), text).toBe(html(<WholeMarkdown>{text}</WholeMarkdown>));
    }
  });

  it("shows the words of a streamed admonition as they arrive", () => {
    const words = "Turn on replication for the table before you subscribe.";
    for (let n = 1; n <= words.length; n++) {
      const c = draw(`import A from "a"\n\n<Admonition type="note">\n\n${words.slice(0, n)}`);
      expect(c.querySelector('[data-mdx="admonition"]')).toHaveTextContent(words.slice(0, n).trim());
      c.remove();
    }
  });

  it("draws an unclosed <Tabs> mid-stream as tabs so far", () => {
    draw('<Tabs>\n  <TabPanel id="a" label="First">\n\nOne\n\n  </TabPanel>\n  <TabPanel id="b" label="Sec');
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["First"]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("One");
  });

  it("shows a half-written tag or expression as text", () => {
    expect(draw('---\ntitle: A\n---\n\nIntro\n\n<Note type="x')).toHaveTextContent('Intro <Note type="x');
    expect(draw("import A from 'a'\n\nTotal {count")).toHaveTextContent("Total {count");
  });

  it("keeps prose MDX can't read as text, beside components", () => {
    const c = draw("<Note>\n\nCareful\n\n</Note>\n\nIf a<b then <!-- hidden --> x {y.\n\nAn autolink <https://example.com>.");
    expect(c.querySelector('[data-mdx="admonition"]')).toBeInTheDocument();
    expect(c).toHaveTextContent("If a<b then x {y.");
    expect(c.querySelector("a")).toHaveAttribute("href", "https://example.com");
    expect(c.textContent).not.toContain("hidden");
  });

  it("shows inline JSX that doesn't close in its own paragraph as text", () => {
    const c = draw("Use <b>bold\n\nstill</b> here, then <Note>x</Note>");
    expect(c).toHaveTextContent("Use <b>bold");
    expect(c).toHaveTextContent("still</b> here, then");
  });
});

describe("plain Markdown", () => {
  const plain = (text: string) =>
    html(
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>,
    );
  // (No links or images here: the baseline is react-markdown without yaah's overrides.)
  it.each([
    "a < b, and b > c",
    "Braces {like this} and {unclosed",
    "Vec<T> and Option<String> and <div>",
    "<Enter> to continue",
    "Press <Tab> to complete, and x <= y, a <> b, Map<K, V>",
    "export PATH=$HOME/bin:$PATH",
    "Install it:\n\n```tsx\nimport { Tabs } from 'ui';\n<Tabs>{x}</Tabs>\n```",
    "Run `<Tabs>` and ``a ` <b> ``.",
    "---\n\nBetween rules\n\n---",
    "Para.\n\n    if a < b { Vec<T> }\n\n    more\n\nPara.",
    "- item\n\n      code <T>\n\n- next",
    "| a < b | {c} |\n|---|---|\n| x | y |",
  ])("draws %j exactly as before", (text) => {
    expect(html(<Markdown>{text}</Markdown>)).toBe(plain(text));
  });

  it("draws autolinks as the same links", () => {
    for (const url of ["https://example.com/a_b*c", "me@example.com"]) {
      const href = url.includes("@") ? `mailto:${url}` : url;
      expect(html(<Markdown>{`See <${url}>.`}</Markdown>)).toBe(html(<Markdown>{`See [${url.replace(/[_*]/g, "\\$&")}](${href}).`}</Markdown>));
    }
  });

  // Deliberate differences: closed HTML that yaah draws is drawn (it used to show as
  // its source), and comments are hidden (they used to show).
  it.each([
    ["Line one<br>line two", "<p>Line one<br>line two</p>"],
    ["Before <!-- a comment --> after", "<p>Before  after</p>"],
    ["Text {/* an MDX comment */} after", "<p>Text  after</p>"],
    ["A tag-like <T> in *emphasis*, and <span>html</span>.", "<p>A tag-like &lt;T&gt; in <em>emphasis</em>, and html.</p>"],
    ["Press <kbd>Ctrl</kbd>+<kbd>C</kbd>", "<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd></p>"],
    [
      "| a | b |\n|---|---|\n| <br> | <!-- x --> |",
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><br></td><td></td></tr></tbody></table>",
    ],
    ["<div>\n*inside*\n</div>", "<p><em>inside</em></p>"],
  ])("draws %j as HTML would", (text, expected) => {
    expect(html(<Markdown>{text}</Markdown>)).toBe(`<div class="markdown">${expected}</div>`);
  });
});
