import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// Buttons and form fields in one consistent hierarchy. The class strings are exported too, for the many places that still build a <button> or a
// <Link> by hand: they all draw from the same three looks.
//   primary      the general action: a calm deep sea-glass fill (not every primary button takes the section accent)
//   secondary    translucent glass with a thin border
//   destructive  an unmistakable red: deletion and reversal are never styled like a cheerful action

const base = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:cursor-not-allowed disabled:opacity-60";

export const buttonClass = {
  primary: `${base} bg-ix-action text-white shadow-md shadow-black/20 hover:bg-ix-action-hover`,
  secondary: `${base} border border-ix-mist/20 bg-ix-mist/5 text-ix-text hover:bg-ix-mist/10`,
  destructive: `${base} border border-red-300/40 bg-red-400/10 text-red-200 hover:bg-red-400/20`,
} as const;

export const fieldClass =
  "mt-1.5 block w-full rounded-xl border border-ix-mist/15 bg-ix-deep/50 px-3 py-2.5 text-sm text-ix-text placeholder:text-ix-muted/60 outline-none transition focus:border-ix-accent/70 focus:ring-2 focus:ring-ix-accent/20 disabled:opacity-60";

type Kind = keyof typeof buttonClass;

export function Button({ kind = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind }) {
  return <button type="button" {...rest} className={`${buttonClass[kind]} ${className}`} />;
}
export const PrimaryButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <Button {...props} kind="primary" />;
export const SecondaryButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <Button {...props} kind="secondary" />;
export const DestructiveButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <Button {...props} kind="destructive" />;

export function LinkButton({ href, kind = "secondary", className = "", children }: { href: string; kind?: Kind; className?: string; children: ReactNode }) {
  return <Link href={href} className={`${buttonClass[kind]} ${className}`}>{children}</Link>;
}

/** A labelled field. A validation error is announced and shown under the control. */
export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="text-xs font-medium text-ix-muted">
      <label className="block">
        {label}
        {children}
      </label>
      {hint && !error && <p className="mt-1 font-normal text-ix-muted/80">{hint}</p>}
      {error && <p role="alert" className="mt-1 font-normal text-red-300">{error}</p>}
    </div>
  );
}

export const TextInput = ({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input {...rest} className={`${fieldClass} ${className}`} />;
export const SelectInput = ({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...rest} className={`${fieldClass} ${className}`} />;
export const TextArea = ({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...rest} className={`${fieldClass} ${className}`} />;

/** A search box with a visible, accessible label. */
export function SearchField({ label = "Search", className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block text-xs font-medium text-ix-muted">
      {label}
      <input type="search" {...rest} className={`${fieldClass} ${className}`} />
    </label>
  );
}
