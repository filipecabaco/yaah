// `table` primitive — TanStack Table (the engine behind shadcn's data table).
// Sortable columns; a filter box past 8 rows; pages past 25. Loaded on demand.
import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFind } from "@/components/ui-blocks/find";
import { plural } from "@/lib/format";
import { asArray, isObj, optText, show, type Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";
import { growAttr, growClass, useUiView } from "@/components/ui-view";

type Column = { key: string; label: string; align?: "left" | "right" };

const FILTER_FROM = 8;
const PAGE = 25;

/** Columns may be plain names (what a database query returns) or `{ key, label?, align? }`. */
function toColumns(raw: unknown): Column[] {
  return asArray(raw).flatMap((c): Column[] => {
    if (typeof c === "string") return [{ key: c, label: c }];
    if (!isObj(c) || typeof c.key !== "string") return [];
    const align = c.align === "left" || c.align === "right" ? c.align : undefined;
    return [{ key: c.key, label: optText(c.label) ?? c.key, align }];
  });
}

/** Numbers sort as numbers, everything else as text. */
function compare(x: unknown, y: unknown): number {
  if (typeof x === "number" && typeof y === "number") return x - y;
  return show(x).localeCompare(show(y), undefined, { numeric: true });
}

export default function UiDataTable({
  columns: rawColumns,
  rows: rawRows,
  empty,
  find,
}: {
  columns: unknown;
  rows: unknown;
  empty?: string;
  find?: string;
}) {
  const cols = useMemo(() => toColumns(rawColumns), [rawColumns]);
  const rows = useMemo(() => asArray(rawRows).filter(isObj), [rawRows]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useFind(find);
  const { expanded } = useUiView();

  // Numbers line up on the right unless the column says otherwise (query results don't).
  const right = useMemo(
    () =>
      new Set(
        cols
          .filter((c) => (c.align ? c.align === "right" : rows.length > 0 && rows.every((r) => r[c.key] == null || typeof r[c.key] === "number")))
          .map((c) => c.key),
      ),
    [cols, rows],
  );

  const columns = useMemo<ColumnDef<Obj>[]>(
    () =>
      cols.map((c) => ({
        id: c.key,
        accessorFn: (r) => r[c.key],
        header: c.label,
        cell: (info) => show(info.getValue()),
        sortingFn: (a, b, id) => compare(a.getValue(id), b.getValue(id)),
      })),
    [cols],
  );

  const needle = filter.toLowerCase();
  // The React Compiler isn't used here, so its "can't memoise this" notice doesn't apply.
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    globalFilterFn: (row) => cols.some((c) => show(row.original[c.key]).toLowerCase().includes(needle)),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE } },
    // Live re-renders shouldn't throw the user back to page 1.
    autoResetPageIndex: false,
  });

  const visible = table.getFilteredRowModel().rows.length;
  const pages = table.getPageCount();
  const pageRows = table.getRowModel().rows;

  return (
    <div className="flex flex-col gap-2">
      {/* Also while a filter is active, so it can always be cleared. */}
      {(rows.length > FILTER_FROM || filter) && (
        <div className="flex items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rows"
              aria-label="Filter rows"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {visible === rows.length ? plural(rows.length, "row") : `${visible.toLocaleString()} of ${plural(rows.length, "row")}`}
          </span>
        </div>
      )}
      <div {...growAttr(expanded, false)} className={cn("overflow-x-auto rounded-md border", growClass(expanded, "", false))}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((g) => (
              <TableRow key={g.id}>
                {g.headers.map((h) => {
                  const end = right.has(h.column.id);
                  const sorted = h.column.getIsSorted();
                  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
                  return (
                    <TableHead
                      key={h.id}
                      className={cn(end && "text-right")}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                    >
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className={cn("inline-flex items-center gap-1 hover:text-foreground", end && "flex-row-reverse")}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <Icon aria-hidden className={cn("size-3", !sorted && "opacity-40")} />
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={Math.max(1, cols.length)} className="text-muted-foreground">
                  {filter ? "No rows match." : (empty ?? "Nothing to show")}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((r) => (
                <TableRow key={r.id}>
                  {r.getVisibleCells().map((c) => (
                    <TableCell key={c.id} className={cn(right.has(c.column.id) && "text-right tabular-nums")}>
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Page {table.getState().pagination.pageIndex + 1} of {pages}
          </span>
          <Button variant="outline" size="xs" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            Previous
          </Button>
          <Button variant="outline" size="xs" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
