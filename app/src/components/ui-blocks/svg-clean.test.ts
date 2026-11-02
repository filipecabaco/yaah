// Diagram SVG keeps its drawing and links but loses everything that would
// fetch from the network on render.
import { describe, expect, it } from "vitest";
import { stripRemoteResources } from "@/components/ui-blocks/svg-clean";

const parse = (svg: string) => {
  const t = document.createElement("template");
  t.innerHTML = stripRemoteResources(svg);
  return t.content;
};

describe("stripRemoteResources", () => {
  it("removes images however they're spelled", () => {
    const out = parse(`<svg>
      <image href="https://evil.example/?k=secret" />
      <image xlink:href="https://evil.example/2" />
      <foreignObject><div><img src="https://evil.example/3"><span>label</span></div></foreignObject>
      <filter id="f"><feImage href="https://evil.example/4" /></filter>
      <set attributeName="href" to="https://evil.example/5" />
      <g><text>kept</text></g>
    </svg>`);
    expect(out.querySelectorAll("image, img")).toHaveLength(0);
    expect(Array.from(out.querySelectorAll("*")).some((el) => /feimage|^set$/i.test(el.localName))).toBe(false);
    expect(out.textContent).toContain("kept");
    expect(out.textContent).toContain("label");
    expect(out.querySelector("svg")!.outerHTML).not.toContain("evil.example");
  });

  it("keeps in-document references and links, drops other URLs", () => {
    const out = parse(`<svg>
      <use href="#node" />
      <use href="https://evil.example/sprite.svg#a" />
      <a href="https://docs.example/">docs</a>
      <path marker-end="url(#arrowhead)" fill="url(https://evil.example/f)" />
    </svg>`);
    const [local, remote] = Array.from(out.querySelectorAll("use"));
    expect(local).toHaveAttribute("href", "#node");
    expect(remote).not.toHaveAttribute("href");
    expect(out.querySelector("a")).toHaveAttribute("href", "https://docs.example/");
    const path = out.querySelector("path")!;
    expect(path).toHaveAttribute("marker-end", "url(#arrowhead)");
    expect(path).toHaveAttribute("fill", "none");
  });

  it("drops remote url() and image-set() from CSS, escapes included", () => {
    // Mermaid puts its <style> inside the <svg>; happy-dom's parser drops a
    // <style> there (browsers don't), so this one sits next to it.
    const out =
      parse(`<style>#d .node { background: url("https://evil.example/a"); } .x { marker: url(#m); } .y { background: \\75 rl(https://evil.example/b); } .z { background-image: image-set("https://evil.example/c" 1x); }</style>
    <svg><rect style="fill: url('https://evil.example/d'); stroke: red" /></svg>`);
    const css = out.querySelector("style")!.textContent ?? "";
    expect(css).not.toContain("evil.example/a");
    expect(css).toContain("url(#m)");
    expect(css).not.toMatch(/url\(https/);
    expect(css).not.toMatch(/image-set\(/);
    expect(out.querySelector("rect")!.getAttribute("style")).toBe("fill: none; stroke: red");
  });
});
