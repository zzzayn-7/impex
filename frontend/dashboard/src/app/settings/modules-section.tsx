import Link from "next/link";

import { MODULE_DESCRIPTIONS, MODULE_KEYS, MODULE_LABELS, MODULE_PAGES, MODULE_REQUIRES, usableModules, type ModuleKey } from "@/lib/modules";
import { Card, linkClass } from "./settings-ui";

const PERMANENT = ["Authentication", "Organization Management", "Onboarding", "Help & Support"];

/** The modules the Super Admin enabled for this organization (the Organization Service's list, read with the administrator's own token).
 *  Read-only on purpose: an organization administrator cannot enable anything. "Request access" only opens a ticket in Help & Support. */
export default function ModulesSection({ modules }: { modules: unknown }) {
  const enabled = usableModules(modules);
  return (
    <Card id="modules" title="Enabled modules" description="Which parts of Impex your organization can use. Only the Impex team can switch a module on or off.">
      <ul className="space-y-3">
        {MODULE_KEYS.map((key) => {
          const on = enabled.includes(key);
          return <ModuleRow key={key} moduleKey={key} on={on} />;
        })}
      </ul>

      <div className="mt-5 rounded-xl border border-ix-mist/15 bg-ix-mist/10 px-4 py-3 text-xs text-ix-muted">
        <p><span className="font-semibold text-ix-text">How modules depend on each other.</span> Purchasing and Sales both need Inventory: they read your products and move stock through it. Inventory cannot be switched off while either of them is on. Finance stands on its own: it posts entries from your issued invoices, payments and goods receipts when those modules are also enabled.</p>
        <p className="mt-2"><span className="font-semibold text-ix-text">Always available, for everyone:</span> {PERMANENT.join(", ")}.</p>
        <p className="mt-2">Switching a module off never deletes anything: its records are kept and come back when it is enabled again. A request for a module never enables it by itself.</p>
      </div>
    </Card>
  );
}

function ModuleRow({ moduleKey, on }: { moduleKey: ModuleKey; on: boolean }) {
  const needs = MODULE_REQUIRES[moduleKey].map((k) => MODULE_LABELS[k]);
  return (
    <li data-module={moduleKey} data-enabled={on} className="rounded-xl border border-ix-mist/15 bg-ix-deep/55 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ix-text">{MODULE_LABELS[moduleKey]}</h3>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${on ? "border-ix-accent-text/40 bg-ix-butter/15 text-ix-accent-text" : "border-ix-mist/15 bg-ix-mist/10 text-ix-muted"}`}>{on ? "Enabled" : "Not enabled"}</span>
            {needs.length > 0 && <span className="text-xs text-ix-muted">Requires {needs.join(", ")}</span>}
          </div>
          <p className="mt-1 text-xs text-ix-muted">{MODULE_DESCRIPTIONS[moduleKey]}</p>
          <p className="mt-1 text-xs text-ix-muted">Includes: {MODULE_PAGES[moduleKey].map((p) => p.label).join(", ")}</p>
        </div>
        {on ? (
          <Link href={MODULE_PAGES[moduleKey][0].href} className={`${linkClass} text-sm`}>Open {MODULE_PAGES[moduleKey][0].label}</Link>
        ) : (
          <Link href={`/support/new?module=${moduleKey}`} className="inline-flex min-h-10 items-center rounded-xl border border-ix-accent-text px-4 py-2 text-sm font-semibold text-ix-accent-text hover:bg-ix-butter/15">Request access</Link>
        )}
      </div>
    </li>
  );
}
