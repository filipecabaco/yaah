// The components MDX boxes draw as (see lib/mdx-render.ts, which builds the
// boxes): yaah's own primitives, given only the literal props the parse kept.
import { Children, useState, type ReactNode } from "react";
import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { openExternal } from "@/lib/links";

type BoxProps = { children?: ReactNode; "data-title"?: string; "data-type"?: string; "data-name"?: string; "data-href"?: string };

const ADMONITION_STYLE = new Map<string, { icon: LucideIcon; tone: string }>(
  Object.entries({
    note: { icon: Info, tone: "" },
    info: { icon: Info, tone: "text-sky-700 dark:text-sky-400" },
    tip: { icon: Lightbulb, tone: "text-green-700 dark:text-green-400" },
    important: { icon: CircleAlert, tone: "text-sky-700 dark:text-sky-400" },
    warning: { icon: TriangleAlert, tone: "text-amber-700 dark:text-amber-400" },
    caution: { icon: TriangleAlert, tone: "text-amber-700 dark:text-amber-400" },
    deprecation: { icon: TriangleAlert, tone: "text-amber-700 dark:text-amber-400" },
    danger: { icon: OctagonAlert, tone: "text-destructive" },
  }),
);
/** Spacing between blocks inside a component, as `.markdown` has at its top level. */
const FLOW = "[&>*+*]:mt-[0.6em]";

export function Admonition({ children, "data-type": type = "note", "data-title": title }: BoxProps) {
  const style = ADMONITION_STYLE.get(type) ?? ADMONITION_STYLE.get("note")!;
  const Icon = style.icon;
  return (
    <Alert variant={type === "danger" ? "destructive" : "default"} data-mdx="admonition" data-type={type}>
      <Icon className={style.tone} />
      <AlertTitle className={style.tone}>{title ?? (type.charAt(0).toUpperCase() + type.slice(1) || "Note")}</AlertTitle>
      <AlertDescription className={cn("text-pretty text-foreground/90", FLOW)}>{children}</AlertDescription>
    </Alert>
  );
}

export function MdxTabs({ children, "data-tabs": json = "[]", "data-default": first }: BoxProps & { "data-tabs"?: string; "data-default"?: string }) {
  const tabs = JSON.parse(json) as { value: string; label: string }[];
  const [value, setValue] = useState(first ?? tabs[0]?.value ?? "");
  // A tab streamed in later doesn't move the selection; a value that went away falls back to the first.
  const current = tabs.some((t) => t.value === value) ? value : (tabs[0]?.value ?? "");
  return (
    <Tabs value={current} onValueChange={setValue} data-mdx="tabs">
      <TabsList className="max-w-full overflow-x-auto">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}

export function MdxTab({ children, "data-value": value }: BoxProps & { "data-value"?: string }) {
  // A panel outside <Tabs> just shows its content.
  if (value === undefined) return <div className={FLOW}>{children}</div>;
  return (
    <TabsContent value={value} className={FLOW}>
      {children}
    </TabsContent>
  );
}

export function MdxDetails({ children }: BoxProps) {
  return (
    <details data-mdx="details" className={cn("rounded-md border px-3 py-2", FLOW)}>
      {children}
    </details>
  );
}

export function MdxSummary({ children }: BoxProps) {
  return <summary className="cursor-pointer font-medium select-none [&>p]:inline">{children}</summary>;
}

export function MdxSteps({ children }: BoxProps) {
  return (
    <div data-mdx="steps" className="flex flex-col gap-4">
      {children}
    </div>
  );
}

export function MdxStep({ children, "data-title": title, "data-index": index }: BoxProps & { "data-index"?: string }) {
  return (
    <div data-mdx="step" className="grid grid-cols-[1.5rem_1fr] gap-x-3">
      <span className="flex size-6 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums">
        {index ?? "•"}
      </span>
      <div className={cn("min-w-0 pt-0.5", FLOW)}>
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function MdxCards({ children }: BoxProps) {
  return (
    <div data-mdx="cards" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {children}
    </div>
  );
}

export function MdxCard({ children, "data-title": title, "data-href": href }: BoxProps) {
  return (
    <Card size="sm" data-mdx="card">
      {title && (
        <CardHeader>
          <CardTitle>
            {href ? (
              <a
                href={href}
                title={href}
                rel="noreferrer noopener"
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(href);
                }}
              >
                {title}
              </a>
            ) : (
              title
            )}
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className={cn("text-muted-foreground", FLOW)}>{children}</CardContent>
    </Card>
  );
}

/** A component yaah doesn't know: its content, in a quiet box named after it. */
export function Unknown({ children, "data-name": name }: BoxProps) {
  const empty = Children.count(children) === 0;
  return (
    <div data-mdx="unknown" className={cn("rounded-md border border-dashed px-3 py-2", FLOW)}>
      <div className="font-mono text-xs text-muted-foreground">{empty ? `<${name} />` : `<${name}>`}</div>
      {children}
    </div>
  );
}

export function UnknownInline({ children, "data-name": name }: BoxProps) {
  if (Children.count(children) === 0) return <code className="text-muted-foreground">{`<${name} />`}</code>;
  return (
    <span data-mdx="unknown" title={`<${name}>`} className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-2">
      {children}
    </span>
  );
}
