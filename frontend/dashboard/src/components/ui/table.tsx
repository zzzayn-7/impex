import type { ReactNode } from "react";

import { GlassPanel } from "./glass";

// Tables and paging. A table sits in a rounded container that scrolls sideways on its own when it must (never the whole page), so a dense table stays
// usable on a phone without cutting off its actions.

export function DataTable({ caption, children, className = "" }: { caption?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-2xl ${className}`} tabIndex={0} role="region" aria-label={caption ?? "Table"}>
      <table className="w-full min-w-[34rem] text-left text-sm text-slate-300">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export const TableHead = ({ children }: { children: ReactNode }) => (
  <thead className="border-b border-slate-800 text-xs uppercase text-slate-400"><tr>{children}</tr></thead>
);

export const Th = ({ children, right = false }: { children?: ReactNode; right?: boolean }) => (
  <th scope="col" className={`px-4 py-3 font-semibold ${right ? "text-right" : ""}`}>{children}</th>
);

/** A table card: an optional toolbar (filters) and the table, in one level-2 panel. */
export function TablePanel({ toolbar, children }: { toolbar?: ReactNode; children: ReactNode }) {
  return (
    <GlassPanel className="space-y-4 p-4 sm:p-5">
      {toolbar}
      {children}
    </GlassPanel>
  );
}

export function Pagination({ total, offset, shown, page, busy, onPage }: { total: number; offset: number; shown: number; page: number; busy?: boolean; onPage: (page: number) => void }) {
  if (total <= 0) return null;
  const first = shown > 0 ? offset + 1 : 0;
  const last = offset + shown;
  const button = "rounded-xl border border-ix-mist/20 bg-ix-mist/5 px-3.5 py-1.5 text-ix-text hover:bg-ix-mist/10 disabled:opacity-40";
  return (
    <div className="flex items-center justify-between text-xs text-ix-muted">
      <span>Showing {first}–{last} of {total}</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)} className={button}>Previous</button>
        <button type="button" disabled={last >= total || busy} onClick={() => onPage(page + 1)} className={button}>Next</button>
      </div>
    </div>
  );
}
