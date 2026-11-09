"use client";

import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { normalizeName } from "@/lib/order-form";
import type { Client } from "@/lib/sales";

// SELECT CLIENT: one search box with a dropdown. Clicking (or tabbing into) the box opens the list of the organization's clients; what is typed
// narrows the list; picking one selects it and its name stays in the box. Typing something else un-selects it again. A name that is not registered
// yet is offered at the bottom of the list as "Register ... as a new client" (an existing client is never offered twice). Enter never submits the
// order form: it picks the highlighted client.
const MAX_SHOWN = 50;

export default function ClientSelect({ clients, value, onSelect, onRegister, disabled = false }: {
  clients: Client[];
  /** The id of the selected client, or "". */
  value: string;
  onSelect: (clientId: string) => void;
  onRegister: (name: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const chosen = clients.find((c) => c.id === value) ?? null;
  const [text, setText] = useState(chosen?.name ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // A client picked (or just registered) shows its name in the box.
  useEffect(() => { if (chosen) setText(chosen.name); }, [chosen?.id, chosen?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  // With the selected client's own name in the box, the whole list is shown (that is what a click on the box is for).
  const typed = normalizeName(text);
  const narrowing = chosen && typed === normalizeName(chosen.name) ? "" : typed;
  const options = useMemo(
    () => (narrowing ? clients.filter((c) => normalizeName(c.name).includes(narrowing)) : clients).slice(0, MAX_SHOWN),
    [clients, narrowing],
  );
  const exists = typed !== "" && clients.some((c) => normalizeName(c.name) === typed);
  const canRegister = !chosen && text.trim() !== "" && !exists;
  const rows = options.length + (canRegister ? 1 : 0);

  function pick(client: Client) {
    onSelect(client.id);
    setText(client.name);
    setOpen(false);
    setActive(-1);
  }
  function register() {
    setOpen(false);
    setActive(-1);
    onRegister(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") return setOpen(false);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (rows > 0) setActive((i) => (event.key === "ArrowDown" ? (i + 1) % rows : (i - 1 + rows) % rows));
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault(); // never saves the order
    if (!open) return setOpen(true);
    // Enter picks the highlighted row, or (after typing) the first match. With nothing typed it does nothing: it must not pick the top of the list.
    const index = active >= 0 ? active : narrowing && options.length > 0 ? 0 : -1;
    if (index >= 0 && index < options.length) pick(options[index]);
    else if (index === options.length && canRegister) register();
  }

  return (
    <div ref={box} className="relative">
      <input
        type="text"
        role="combobox"
        aria-label="Select client"
        aria-expanded={open && rows > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        value={text}
        disabled={disabled}
        maxLength={255}
        placeholder="Select Client"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setOpen(true);
          setActive(-1);
          if (chosen && normalizeName(next) !== normalizeName(chosen.name)) onSelect(""); // typing something else un-selects the client
        }}
        className="block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 pr-9"
      />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ix-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      {open && rows > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label="Matching clients" className="ix-menu absolute left-0 right-0 z-20 mt-2 max-h-72 overflow-y-auto">
          {options.map((c, i) => (
            <li key={c.id} id={`${id}-opt-${i}`} role="option" aria-selected={c.id === value}>
              <button type="button" onClick={() => pick(c)} aria-current={i === active ? "true" : undefined} className="ix-menu-item justify-between">
                <span className="truncate font-medium">{c.name}</span>
                {c.email && <span className="truncate text-xs text-ix-muted">{c.email}</span>}
              </button>
            </li>
          ))}
          {canRegister && (
            <li id={`${id}-opt-${options.length}`} role="option" aria-selected={false}>
              <button type="button" onClick={register} aria-current={active === options.length ? "true" : undefined} className="ix-menu-item">
                <span aria-hidden="true" className="text-ix-butter">+</span> Register “{text.trim().replace(/\s+/g, " ")}” as a new client
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
