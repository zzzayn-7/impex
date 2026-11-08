import Link from "next/link";

import { amountOf, formatAmount, monthLabel, monthlyTotals, movementActivity, primaryCurrency, toPlot, type Money } from "@/lib/dashboard-metrics";
import { ACTIVITY_DAYS, TREND_MONTHS, type DashboardData } from "@/lib/dashboard-data";
import { formatDate, formatDecimal, normalizePreferences, type Preferences } from "@/lib/format";
import { MODULE_DESCRIPTIONS, MODULE_LABELS, MODULE_PAGES, usableModules } from "@/lib/modules";
import type { TenantOrganization, OrganizationResult } from "@/lib/organization";
import type { TenantAdmin } from "@/lib/tenant-auth";
import { AreaChart, ColumnChart, BarList, Legend, SERIES_COLORS, StackedBar, type Series } from "./charts";
import { CardHeader, CardNote, Footnote, GlassCard, Pill } from "./glass";
import { Tooltip } from "@/components/ui/tooltip";
import Icon, { type IconKey } from "./icons";

// The dashboard's content. Every number is computed from the records in `data` (see lib/dashboard-data.ts); a module that is not enabled has no
// entry in `data` and therefore no card, and the remaining cards share the row. An empty organization shows calm empty states, never zeros
// dressed up as results, and a service that could not answer says so in its own cards only.

type Props = { admin: TenantAdmin; organizationResult: OrganizationResult; data: DashboardData };

// ONE decorative accent (pale butter yellow). A figure or action is either "yellow" (the few that matter most) or "neutral" (slate-grey). Never a status.
type Tone = "yellow" | "neutral";
const WELL_TONE: Record<Tone, string> = { yellow: "bg-ix-butter/15 text-ix-butter", neutral: "bg-ix-mist/10 text-ix-mist" };

const unavailable = "Could not be loaded just now. Please refresh in a moment.";
const grid = "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))]";
const wideGrid = "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))]";

function Kpi({ icon, label, value, unit, context, tone, accent = "neutral" }: { icon: IconKey; label: string; value: string; unit?: string; context?: React.ReactNode; tone?: "warn"; accent?: Tone }) {
  return (
    <GlassCard small lift className="ix-kpi p-5" aria-label={label} data-accent={accent}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ix-muted">{label}</p>
        <span className="ix-kpi-icon grid h-9 w-9 shrink-0 place-items-center rounded-xl"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      </div>
      <p className="mt-3 flex items-baseline gap-1.5 text-[28px] font-semibold leading-none tracking-tight text-ix-text">
        <span className="tabular-nums">{value}</span>
        {unit && <span className="text-sm font-medium text-ix-muted">{unit}</span>}
      </p>
      {context && <div className={`mt-2.5 text-xs leading-relaxed ${tone === "warn" ? "text-amber-100/90" : "text-ix-muted"}`}>{context}</div>}
    </GlassCard>
  );
}

function KpiUnavailable({ icon, label, accent }: { icon: IconKey; label: string; accent?: Tone }) {
  return <Kpi icon={icon} label={label} accent={accent} value="—" context={<span role="alert">{unavailable}</span>} tone="warn" />;
}

/** The currencies other than the headline one, each on its own line (never added to it). */
function Others({ totals, shown, prefs }: { totals: Money[]; shown: string | null; prefs: Preferences }) {
  const rest = totals.filter((t) => t.currency !== shown && /[1-9]/.test(t.amount));
  if (rest.length === 0) return null;
  return <span className="block">Also in {rest.map((t) => `${formatAmount(t.amount, prefs)} ${t.currency}`).join(" · ")}</span>;
}

export default function DashboardView({ admin, organizationResult, data }: Props) {
  const organization: TenantOrganization | null = organizationResult.ok ? organizationResult.organization : null;
  const prefs = normalizePreferences(organization);
  const enabled = usableModules(organization?.modules);
  const { inventory, purchasing, sales, finance } = data;
  const month = data.months[data.months.length - 1];

  // ---- sales and purchasing in the headline currency -----------------------------------------------------------------------
  const salesRows = sales?.status === "ok" ? sales.data.trend.rows : [];
  const purchaseRows = purchasing?.status === "ok" ? purchasing.data.trend.rows : [];
  const outstanding = sales?.status === "ok" ? sales.data.receivables.outstanding : [];
  const headline = primaryCurrency([...salesRows, ...purchaseRows, ...outstanding.map((o) => ({ currency: o.currency }))], prefs.default_currency) ?? prefs.default_currency;
  const salesByMonth = monthlyTotals(salesRows, data.months, headline);
  const purchasesByMonth = monthlyTotals(purchaseRows, data.months, headline);
  const salesThisMonth = salesByMonth[salesByMonth.length - 1] ?? "0.0000";
  const money = (amount: string, currency = headline) => `${formatAmount(amount, prefs)} ${currency}`;
  const otherSalesCurrencies = Array.from(new Set(salesRows.map((r) => r.currency))).filter((c) => c !== headline);
  const otherPurchaseCurrencies = Array.from(new Set(purchaseRows.map((r) => r.currency))).filter((c) => c !== headline);

  // ---- KPI cards ----------------------------------------------------------------------------------------------------------
  const kpis: React.ReactNode[] = [];
  if (inventory) {
    kpis.push(inventory.status === "ok" ? (
      <Kpi key="products" icon="products" accent="neutral" label="Active products" value={formatDecimal(String(inventory.data.products), prefs)}
        context={inventory.data.products === 0 ? "No products yet" : "In your product catalog"} />
    ) : <KpiUnavailable key="products" icon="products" accent="neutral" label="Active products" />);
  }
  if (purchasing) {
    kpis.push(purchasing.status === "ok" ? (
      <Kpi key="orders" icon="orders" accent="neutral" label="Open purchase orders" value={String(purchasing.data.open.count)}
        context={purchasing.data.open.count === 0 ? "Nothing waiting to be received" : (
          <>
            {purchasing.data.open.byCurrency.slice(0, 2).map((t) => <span key={t.currency} className="block">{money(t.amount, t.currency)} on order</span>)}
            {purchasing.data.open.byCurrency.length > 2 && <span className="block">+ {purchasing.data.open.byCurrency.length - 2} more {purchasing.data.open.byCurrency.length - 2 === 1 ? "currency" : "currencies"}</span>}
          </>
        )} />
    ) : <KpiUnavailable key="orders" icon="orders" accent="neutral" label="Open purchase orders" />);
  }
  if (sales) {
    kpis.push(sales.status === "ok" ? (
      <Kpi key="invoiced" icon="invoices" accent="yellow" label="Invoiced this month" value={formatAmount(salesThisMonth, prefs)} unit={headline}
        context={salesRows.length === 0 ? "No invoices issued yet" : <>Issued invoices, {monthLabel(month)}<Others totals={Array.from(new Set(salesRows.map((r) => r.currency))).filter((c) => c !== headline).map((c) => ({ currency: c, amount: monthlyTotals(salesRows, [month], c)[0] }))} shown={headline} prefs={prefs} /></>} />
    ) : <KpiUnavailable key="invoiced" icon="invoices" accent="yellow" label="Invoiced this month" />);
    kpis.push(sales.status === "ok" ? (
      <Kpi key="receivables" icon="clients" accent="yellow" label="Outstanding receivables" value={formatAmount(amountOf(outstanding, headline), prefs)} unit={headline}
        tone={/[1-9]/.test(amountOf(sales.data.receivables.overdue, headline)) ? "warn" : undefined}
        context={sales.data.receivables.count === 0 ? "No unpaid invoices" : (
          <>
            {/[1-9]/.test(amountOf(sales.data.receivables.overdue, headline)) ? <span className="block">{money(amountOf(sales.data.receivables.overdue, headline))} overdue</span> : <span className="block">Nothing overdue</span>}
            <span className="block">{sales.data.receivables.count} unpaid {sales.data.receivables.count === 1 ? "invoice" : "invoices"}</span>
            <Others totals={outstanding} shown={headline} prefs={prefs} />
          </>
        )} />
    ) : <KpiUnavailable key="receivables" icon="clients" accent="yellow" label="Outstanding receivables" />);
  }

  // ---- analytics ----------------------------------------------------------------------------------------------------------
  const analytics: React.ReactNode[] = [];
  if ((sales || purchasing) && (sales?.status === "ok" || purchasing?.status === "ok")) {
    const series: Series[] = [];
    const toSeries = (name: string, color: string, values: string[]): Series => ({ name, color, points: values.map((v, i) => ({ label: monthLabel(data.months[i]), value: v, text: money(v) })) });
    if (sales?.status === "ok") series.push(toSeries("Invoiced", SERIES_COLORS.butter, salesByMonth));
    if (purchasing?.status === "ok") series.push(toSeries("Purchase orders placed", SERIES_COLORS.teal, purchasesByMonth));
    const empty = series.every((s) => s.points.every((p) => !/[1-9]/.test(p.value)));
    const truncated = (sales?.status === "ok" && sales.data.trend.truncated) || (purchasing?.status === "ok" && purchasing.data.trend.truncated);
    const others = [...otherSalesCurrencies, ...otherPurchaseCurrencies.filter((c) => !otherSalesCurrencies.includes(c))];
    analytics.push(
      <GlassCard key="trend" className="p-5 sm:p-6" aria-label="Sales and purchasing trend">
        <CardHeader title="Sales & purchasing trend" subtitle={`Last ${TREND_MONTHS} months, in ${headline}`} action={<Legend items={series.map((s) => ({ name: s.name, color: s.color }))} />} />
        {empty ? <CardNote>No invoices or purchase orders in the last {TREND_MONTHS} months yet.</CardNote> : <AreaChart id="trend" series={series} label={`${series.map((s) => s.name).join(" and ")} per month in ${headline}, last ${TREND_MONTHS} months`} />}
        {others.length > 0 && <Footnote>Also in {others.join(", ")}: shown in its own currency elsewhere, never added to {headline}.</Footnote>}
        {truncated && <Footnote>Based on the latest records in this period (the list limit was reached).</Footnote>}
        {(sales?.status === "unavailable" || purchasing?.status === "unavailable") && <Footnote>{sales?.status === "unavailable" ? "Sales" : "Purchasing"} data could not be loaded, so its line is missing.</Footnote>}
      </GlassCard>
    );
  }
  if (sales) {
    analytics.push(
      <GlassCard key="collections" className="p-5 sm:p-6" aria-label="Collections">
        <CardHeader title="Collections" subtitle={`Open invoices in ${headline}: paid so far, still due, overdue`} />
        {sales.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : sales.data.receivables.count === 0 ? <CardNote>No open invoices. Issued invoices appear here until they are paid.</CardNote> : (() => {
          const r = sales.data.receivables;
          const overdue = amountOf(r.overdue, headline);
          const due = amountOf(outstanding, headline);
          const stillDue = subtractDisplay(due, overdue);
          return (
            <>
              <StackedBar label={`Open invoices in ${headline}`} parts={[
                { name: "Paid so far", color: SERIES_COLORS.butter, value: toPlot(amountOf(r.paid, headline)), text: money(amountOf(r.paid, headline)) },
                { name: "Still due", color: SERIES_COLORS.teal, value: toPlot(stillDue), text: money(stillDue) },
                { name: "Overdue", color: "#C9A27A", value: toPlot(overdue), text: money(overdue) },
              ]} />
              {r.truncated && <Footnote>Based on the latest open invoices (the list limit was reached).</Footnote>}
            </>
          );
        })()}
      </GlassCard>
    );
  }
  if (inventory) {
    const activity = inventory.status === "ok" ? movementActivity(inventory.data.movements, data.days, prefs.timezone) : [];
    const anyActivity = activity.some((d) => d.added + d.removed > 0);
    const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
    const mk = (name: string, color: string, pick: (d: (typeof activity)[number]) => number): Series => ({ name, color, points: activity.map((d) => ({ label: dayLabel(d.day), value: String(pick(d)), text: `${pick(d)} ${pick(d) === 1 ? "movement" : "movements"}` })) });
    analytics.push(
      <GlassCard key="activity" className="p-5 sm:p-6" aria-label="Inventory movement activity">
        <CardHeader title="Inventory activity" subtitle={`Stock movements per day, last ${ACTIVITY_DAYS} days`} action={<Legend items={[{ name: "Added", color: SERIES_COLORS.butter }, { name: "Removed", color: SERIES_COLORS.slate }]} />} />
        {inventory.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : !anyActivity ? <CardNote>No stock movements in the last {ACTIVITY_DAYS} days.</CardNote> : (
          <ColumnChart label={`Stock movements per day, last ${ACTIVITY_DAYS} days`} series={[mk("Added", SERIES_COLORS.butter, (d) => d.added), mk("Removed", SERIES_COLORS.slate, (d) => d.removed)]} />
        )}
        {inventory.status === "ok" && inventory.data.movementsTruncated && anyActivity && <Footnote>Based on the latest {inventory.data.movements.length} movements.</Footnote>}
      </GlassCard>
    );
  }

  // ---- operations ---------------------------------------------------------------------------------------------------------
  const operations: React.ReactNode[] = [];
  const row = (key: string, left: React.ReactNode, right: React.ReactNode) => <li key={key} className="flex items-center justify-between gap-3 py-2.5">{left}{right}</li>;
  if (sales) {
    operations.push(
      <GlassCard key="invoices" className="p-5 sm:p-6" aria-label="Recent invoices">
        <CardHeader title="Recent invoices" action={<Link href="/invoices" className="text-xs font-medium text-ix-butter hover:text-ix-text">View all</Link>} />
        {sales.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : sales.data.recent.length === 0 ? <CardNote>No invoices yet.</CardNote> : (
          <ul className="divide-y divide-ix-mist/10">
            {sales.data.recent.map((i) => row(i.id,
              <div className="min-w-0"><Link href={`/invoices/${i.id}`} className="font-mono text-sm font-semibold text-ix-butter hover:text-ix-text">{i.number ?? "Draft"}</Link><p className="truncate text-xs text-ix-muted">{i.client.name} · {formatDate(i.invoice_date, prefs)}</p></div>,
              <div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums text-ix-text">{money(i.total, i.currency_code)}</p><Pill tone={i.status === "paid" ? "good" : i.overdue ? "warn" : i.status === "draft" ? "muted" : "neutral"}>{i.overdue ? "Overdue" : i.status.replace("_", " ")}</Pill></div>))}
          </ul>
        )}
      </GlassCard>
    );
  }
  if (purchasing) {
    operations.push(
      <GlassCard key="pos" className="p-5 sm:p-6" aria-label="Open purchase orders">
        <CardHeader title="Open purchase orders" action={<Link href="/purchase-orders" className="text-xs font-medium text-ix-butter hover:text-ix-text">View all</Link>} />
        {purchasing.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : purchasing.data.recentOpen.length === 0 ? <CardNote>No purchase orders waiting to be received.</CardNote> : (
          <ul className="divide-y divide-ix-mist/10">
            {purchasing.data.recentOpen.map((o) => row(o.id,
              <div className="min-w-0"><Link href={`/purchase-orders/${o.id}`} className="font-mono text-sm font-semibold text-ix-butter hover:text-ix-text">{o.number}</Link><p className="truncate text-xs text-ix-muted">{o.supplier.name}{o.expected_delivery_date ? ` · due ${formatDate(o.expected_delivery_date, prefs)}` : ""}</p></div>,
              <div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums text-ix-text">{money(o.total_amount, o.currency_code)}</p><Pill tone="neutral">{o.status.replace("_", " ")}</Pill></div>))}
          </ul>
        )}
      </GlassCard>
    );
  }
  if (inventory) {
    operations.push(
      <GlassCard key="movements" className="p-5 sm:p-6" aria-label="Recent stock movements">
        <CardHeader title="Recent stock movements" action={<Link href="/movements" className="text-xs font-medium text-ix-butter hover:text-ix-text">View all</Link>} />
        {inventory.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : inventory.data.movements.length === 0 ? <CardNote>No stock movements yet.</CardNote> : (
          <ul className="divide-y divide-ix-mist/10">
            {inventory.data.movements.slice(0, 5).map((m) => row(m.id,
              <div className="min-w-0"><p className="truncate text-sm font-medium text-ix-text">{m.product_name}</p><p className="truncate text-xs text-ix-muted">{formatDate(m.created_at, prefs)}</p></div>,
              <div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums text-ix-text">{m.movement_type === "out" ? "−" : "+"}{plain(m.quantity, prefs)} {m.product_unit}</p><Pill tone="muted">{m.movement_type.replace("_", " ")}</Pill></div>))}
          </ul>
        )}
      </GlassCard>
    );
  }
  if (finance) {
    operations.push(
      <GlassCard key="finance" className="p-5 sm:p-6" aria-label="Finance snapshot">
        <CardHeader title="Finance snapshot" action={<Link href="/finance" className="text-xs font-medium text-ix-muted hover:text-ix-text">Open Finance</Link>} />
        {finance.status !== "ok" ? <CardNote tone="error">{unavailable}</CardNote> : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-center text-xs">
              {[["Posted entries", finance.data.posted_entries], ["Draft entries", finance.data.draft_entries], ["Expenses posted", finance.data.posted_expenses]].map(([name, value]) => (
                <div key={String(name)} className="rounded-2xl border border-ix-mist/10 bg-ix-deep/25 px-2 py-3"><dd className="text-xl font-semibold tabular-nums text-ix-text">{value}</dd><dt className="mt-0.5 text-ix-muted">{name}</dt></div>
              ))}
            </dl>
            {finance.data.totals_by_currency.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs text-ix-muted">
                {finance.data.totals_by_currency.map((t) => <li key={t.currency_code} className="flex justify-between gap-3"><span className="font-mono text-ix-text">{t.currency_code}</span><span className="tabular-nums">Revenue {formatAmount(t.revenue, prefs)} · Expenses {formatAmount(t.expenses, prefs)}</span></li>)}
              </ul>
            )}
            {finance.data.sync.failed > 0 && <p role="alert" className="mt-3 text-xs text-amber-100/90">{finance.data.sync.failed} automatic {finance.data.sync.failed === 1 ? "posting needs" : "postings need"} attention. <Link href="/finance" className="underline">Review</Link></p>}
          </>
        )}
      </GlassCard>
    );
  }

  const actions: { label: string; href: string; icon: IconKey; tone: Tone }[] = [];
  if (enabled.includes("inventory")) actions.push({ label: "Scan a product", href: "/scan", icon: "scan", tone: "yellow" }, { label: "Adjust stock", href: "/stock", icon: "stock", tone: "neutral" });
  if (enabled.includes("sales")) actions.push({ label: "New invoice", href: "/invoices/new", icon: "invoices", tone: "yellow" });
  if (enabled.includes("purchasing")) actions.push({ label: "Purchase orders", href: "/purchase-orders", icon: "orders", tone: "neutral" });
  if (enabled.includes("finance")) actions.push({ label: "Record an expense", href: "/finance/expenses/new", icon: "expenses", tone: "neutral" }, { label: "New journal entry", href: "/finance/journal/new", icon: "journal", tone: "neutral" });
  actions.push({ label: "Contact support", href: "/support/new", icon: "support", tone: "neutral" });

  return (
    <div className="space-y-5">
      <GlassCard className="overflow-hidden p-6 sm:p-7" aria-labelledby="welcome-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-ix-muted">Overview</p>
            <h2 id="welcome-heading" className="mt-1.5 text-2xl font-semibold tracking-tight text-ix-text sm:text-[28px]">Welcome, {admin.full_name}</h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ix-muted">
              You are signed in as an administrator of <span className="font-medium text-ix-text">{organization ? organization.name : "your organization"}</span>.
              {enabled.length > 0 ? " Here is where your business stands." : ""}
            </p>
          </div>
          {organization && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={organization.is_active ? "good" : "warn"}>{organization.is_active ? "Active" : "Inactive"}</Pill>
              <Pill tone="muted">{prefs.default_currency}</Pill>
              <Pill tone="muted">{prefs.timezone}</Pill>
            </div>
          )}
        </div>
        <dl className="mt-5 grid gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-2xl border border-ix-mist/10 bg-ix-deep/25 px-4 py-3">
            <dt className="text-ix-muted">Administrator</dt>
            <dd className="mt-0.5 text-sm font-medium text-ix-text">{admin.full_name}</dd>
            <dd className="text-ix-muted">{admin.email}</dd>
          </div>
          <div className="rounded-2xl border border-ix-mist/10 bg-ix-deep/25 px-4 py-3">
            <dt className="text-ix-muted">Organization ID</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px] text-ix-muted">{admin.organization_id}</dd>
          </div>
        </dl>
      </GlassCard>

      {!organization && (
        <GlassCard className="p-5">
          {!organizationResult.ok && organizationResult.reason === "forbidden" ? (
            <p role="alert" className="text-sm text-amber-100/90">Your organization is currently inactive or unavailable. Please contact your platform administrator.</p>
          ) : (
            <p role="alert" className="text-sm text-ix-muted">Organization details are temporarily unavailable. Please refresh in a moment.</p>
          )}
        </GlassCard>
      )}

      {kpis.length > 0 && <div className={grid} role="list" aria-label="Key figures">{kpis.map((k, i) => <div role="listitem" key={i} className="contents">{k}</div>)}</div>}
      {analytics.length > 0 && <div className={wideGrid}>{analytics}</div>}
      {operations.length > 0 && <div className={wideGrid}>{operations}</div>}

      {organization && (
        <div className={wideGrid}>
          <GlassCard className="p-5 sm:p-6" aria-labelledby="modules-heading">
            <CardHeader title="Your modules" subtitle="Where would you like to work?" />
            <h3 id="modules-heading" className="sr-only">Your modules</h3>
            {enabled.length === 0 ? (
              <CardNote>No business modules are enabled for your organization yet.</CardNote>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {enabled.map((key) => (
                  <div key={key} data-module={key} className="rounded-2xl border border-ix-mist/10 bg-ix-deep/25 p-4">
                    <h4 className="text-sm font-semibold text-ix-text">{MODULE_LABELS[key]}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-ix-muted">{MODULE_DESCRIPTIONS[key]}</p>
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {MODULE_PAGES[key].map((page) => (
                        <li key={page.href}><Link href={page.href} className={`inline-flex rounded-full border border-ix-mist/15 bg-ix-mist/5 px-2.5 py-1 text-xs font-medium transition-colors hover:border-ix-butter/30 hover:bg-ix-butter/10 hover:text-ix-butter text-ix-mist`}>{page.label}</Link></li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <Footnote>Need another module? <Link href="/support/new?module=other" className="text-ix-muted underline-offset-2 hover:underline">Ask the Impex team</Link>. Only the Impex team can enable it.</Footnote>
          </GlassCard>

          <GlassCard className="p-5 sm:p-6" aria-label="Quick actions">
            <CardHeader title="Quick actions" />
            <ul className="grid gap-2 sm:grid-cols-2">
              {actions.map((a) => (
                <li key={a.href}>
                  <Link href={a.href} className="flex h-12 items-center gap-3 rounded-2xl border border-ix-mist/12 bg-ix-mist/5 px-3 text-sm font-medium text-ix-text transition-colors hover:bg-ix-mist/12">
                    <span className={`grid h-8 w-8 place-items-center rounded-xl ${WELL_TONE[a.tone]}`}><Icon name={a.icon} className="h-4 w-4" /></span>{a.label}
                    <Icon name="arrowRight" className="ml-auto h-4 w-4 text-ix-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </GlassCard>

          <GlassCard className="p-5 sm:p-6" aria-labelledby="organization-heading">
            <CardHeader title="Organization" />
            <h3 id="organization-heading" className="sr-only">{organization.name}</h3>
            <dl className="grid grid-cols-2 gap-3 text-xs">
              {([
                ["Name", organization.name], ["Identifier", organization.slug], ["Country", organization.country_code], ["Tax identifier", organization.tax_identifier ?? "Not provided"],
                ["Contact email", organization.contact_email], ["Registered", formatDate(organization.created_at, prefs)],
              ] as const).map(([name, value]) => (
                <div key={name} className="min-w-0"><dt className="text-ix-muted">{name}</dt><Tooltip label={value}><dd tabIndex={0} className="mt-0.5 truncate rounded font-medium text-ix-text">{value}</dd></Tooltip></div>
              ))}
            </dl>
          </GlassCard>
        </div>
      )}
    </div>
  );
}

/** a - b for two exact decimal strings of the same currency (display only; never negative). */
function subtractDisplay(a: string, b: string): string {
  const units = (v: string) => { const [w, f = ""] = v.split("."); return BigInt(w + f.padEnd(4, "0").slice(0, 4)); };
  const diff = units(a) - units(b);
  const positive = diff < BigInt(0) ? BigInt(0) : diff;
  const digits = positive.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** A quantity as an exact decimal with the organization's separators and no trailing zeros ("10.0000" -> "10"). */
function plain(quantity: string, prefs: Preferences): string {
  const match = /^(-?\d+)(?:\.(\d*))?$/.exec(quantity);
  if (!match) return quantity;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return formatDecimal(`${match[1]}${fraction ? "." + fraction : ""}`, prefs);
}
