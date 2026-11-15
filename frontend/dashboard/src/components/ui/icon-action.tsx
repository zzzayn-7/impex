"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";

// THE row / toolbar action of the portal: an ICON with a tooltip, never a word. Edit is a pencil, Archive (and Deactivate, Retire) a box, Restore (and Reactivate)
// an arrow back, Delete (and Remove, Discard) a bin in red. The words are not lost: the tooltip shows them on hover and on keyboard focus, and the control carries them
// as its accessible name (`ariaLabel`, which a page can make more specific, for example "Edit Steel bolt"; by default it is the label).
//
//   variant "plain"  a bare icon, for a table row's Actions column
//   variant "boxed"  a small bordered square, for a page's or dialog's toolbar
// Pass `onClick` for a button or `href` for a link (an Edit that opens a page).

export type ActionKind = "edit" | "archive" | "restore" | "delete";

const PATHS: Record<ActionKind, string> = {
  edit: "M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
  archive: "M4 5h16v4H4zM5.5 9v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M10 13h4",
  restore: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  delete: "M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3",
};

export function ActionGlyph({ kind, className = "h-[18px] w-[18px]" }: { kind: ActionKind; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[kind]} />
    </svg>
  );
}

const TONE = {
  plain: { normal: "p-1.5 text-slate-400 hover:text-white focus-visible:text-white", danger: "p-1.5 text-red-400 hover:text-red-300 focus-visible:text-red-300" },
  boxed: {
    normal: "grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 focus-visible:bg-slate-800",
    danger: "grid h-10 w-10 place-items-center rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 focus-visible:bg-red-500/10",
  },
} as const;

export function IconAction({ kind, label, ariaLabel, onClick, href, disabled = false, danger = kind === "delete", variant = "plain", className = "" }: {
  kind: ActionKind;
  /** The word the tooltip shows ("Edit", "Deactivate", "Remove" ...). */
  label: string;
  /** The control's accessible name when it should say more than the tooltip, for example "Edit Steel bolt". */
  ariaLabel?: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
  variant?: "plain" | "boxed";
  className?: string;
}) {
  const classes = `${TONE[variant][danger ? "danger" : "normal"]} transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${className}`;
  return (
    <Tooltip label={label}>
      {href ? (
        <Link href={href} aria-label={ariaLabel ?? label} className={classes}><ActionGlyph kind={kind} /></Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel ?? label} className={classes}><ActionGlyph kind={kind} /></button>
      )}
    </Tooltip>
  );
}
