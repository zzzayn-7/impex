"use client";

import type { InputHTMLAttributes, KeyboardEvent, Ref } from "react";

import { decrease, increase, isZero } from "@/lib/quantity";

// THE quantity selector of the portal: a minus button, the number, a plus button. It starts at zero and moves in jumps of 10 on every click; the
// number in the middle is a real text box, so the administrator can also click it and type any quantity. It has no fill of its own: it sits on the
// page's background (see .ix-qty in globals.css). The value is a decimal STRING and is passed through exactly as typed: the form that owns it
// validates it (unit rules, stock limits), as before.
//
// Pass the same `aria-label` / `id` / `aria-invalid` / `placeholder` you would give a plain <input>; they go to the number box. When the selector sits
// inside a wrapping <label>, give that label `htmlFor` = this `id`, otherwise the browser would take the first button for the label's control.

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "step" | "className" | "ref"> & {
  value: string;
  onChange: (value: string) => void;
  /** How much one click adds or removes. */
  step?: string;
  /** Sizing / spacing of the whole selector (for example "w-32" or "mt-1.5"). */
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
};

export default function QuantityInput({ value, onChange, step = "10", className = "", inputRef, disabled, onKeyDown, placeholder = "0", ...rest }: Props) {
  const name = rest["aria-label"];
  const lower = name ? name.charAt(0).toLowerCase() + name.slice(1) : "quantity";
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;
    if (event.key === "ArrowUp") { event.preventDefault(); onChange(increase(value, step)); }
    if (event.key === "ArrowDown") { event.preventDefault(); onChange(decrease(value, step)); }
  };
  return (
    <div className={`ix-qty ${className}`} data-disabled={disabled ? "true" : undefined}>
      <button type="button" className="ix-qty-step" disabled={disabled || isZero(value)} onClick={() => onChange(decrease(value, step))} aria-label={`Decrease ${lower}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <input
        {...rest}
        ref={inputRef}
        type="text"
        inputMode={rest.inputMode ?? "decimal"}
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={key}
        className="ix-qty-input font-mono text-sm"
      />
      <button type="button" className="ix-qty-step" disabled={disabled} onClick={() => onChange(increase(value, step))} aria-label={`Increase ${lower}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  );
}
