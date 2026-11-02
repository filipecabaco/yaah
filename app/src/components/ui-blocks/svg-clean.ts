// Mermaid's SVG with nothing left in it that fetches. Agent-written diagram
// text could otherwise put a secret in an image URL and send it just by being
// drawn (the app's CSP allows https images), with no click and no approval.
// Applied after Mermaid's own sanitising, which keeps http(s) image URLs.
//
// - `<image>`, `<img>` and `<feImage>` are removed outright, and so are
//   `<set>`/`<animate>` that would write a URL attribute;
// - on every other element, `src`/`href`-style attributes survive only as
//   in-document `#fragment` references (`<use href="#…">`), except on links,
//   which fetch nothing until clicked and then open in the system browser;
// - CSS in `<style>`, `style` and presentation attributes keeps only
//   `url(#…)` (Mermaid's arrowhead markers); other `url()` and `image-set()`
//   become `none`, and escapes (`\75 rl(`) are dropped so nothing can spell them.

const FETCHING_ELEMENTS = new Set(["image", "img", "feimage"]);
const ANIMATIONS = new Set(["set", "animate"]);
const URL_ATTRIBUTES = new Set(["src", "srcset", "href", "xlink:href", "poster", "background", "data", "action", "formaction"]);
/** Attributes read as CSS, where `url()` can point anywhere. */
const CSS_ATTRIBUTES = new Set(["style", "fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"]);

const local = (value: string) => value.trim().startsWith("#");

function cleanCss(css: string): string {
  return css
    .replace(/\\/g, "")
    .replace(/(?:-webkit-)?image(?:-set)?\(/gi, "none(")
    .replace(/url\(([^)]*)\)/gi, (whole, inner: string) => (local(inner.trim().replace(/^['"]/, "")) ? whole : "none"));
}

export function stripRemoteResources(svg: string): string {
  // A template's content is inert: nothing in it loads while it's cleaned.
  const template = document.createElement("template");
  template.innerHTML = svg;
  for (const el of Array.from(template.content.querySelectorAll("*"))) {
    const tag = el.localName.toLowerCase();
    if (FETCHING_ELEMENTS.has(tag) || (ANIMATIONS.has(tag) && URL_ATTRIBUTES.has((el.getAttribute("attributeName") ?? "").toLowerCase()))) {
      el.remove();
      continue;
    }
    if (tag === "style") el.textContent = cleanCss(el.textContent ?? "");
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (URL_ATTRIBUTES.has(name)) {
        if (tag !== "a" && !local(attr.value)) el.removeAttribute(attr.name);
      } else if (CSS_ATTRIBUTES.has(name)) {
        const clean = cleanCss(attr.value);
        if (clean !== attr.value) el.setAttribute(attr.name, clean);
      }
    }
  }
  return template.innerHTML;
}
