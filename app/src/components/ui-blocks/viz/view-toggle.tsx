// The figure/table switch every chart, map and graph carries (the table is the accessible
// equivalent and the way to read small marks), and the table itself.
import type { ReactNode } from "react";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { inlineMax, useUiView } from "@/components/ui-view";
import { cn } from "@/lib/utils";

export function ViewToggle<V extends string>({ value, onChange, views }: { value: V; onChange: (v: V) => void; views: readonly V[] }) {
  return (
    <div className="flex justify-end">
      <div className="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="View">
        {views.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={cn("rounded px-2 py-0.5 capitalize", value === v ? "bg-muted font-medium" : "text-muted-foreground")}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

export type Column = { key: string; label: string; numeric?: boolean };

/** The data as a table: one row per mark, numbers right-aligned in tabular figures. */
export function VizTable({ columns, rows, caption }: { columns: Column[]; rows: Record<string, ReactNode>[]; caption?: string }) {
  const { expanded } = useUiView();
  return (
    <div className={cn("overflow-auto rounded-md border", inlineMax(expanded, "max-h-80"))}>
      <Table>
        {caption && <TableCaption className="mt-0 mb-2 px-2 text-left text-xs">{caption}</TableCaption>}
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key} className={c.numeric ? "text-right" : undefined}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c.key} className={c.numeric ? "text-right tabular-nums" : undefined}>
                  {row[c.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
