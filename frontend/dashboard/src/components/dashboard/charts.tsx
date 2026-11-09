import { toPlot } from "@/lib/dashboard-metrics";
import { Tooltip } from "@/components/ui/tooltip";

// Lightweight server-rendered SVG charts in the dashboard's muted palette. No chart library and no client JavaScript: hover details are native
// <title> tooltips, and every chart has a text alternative (an aria-label that summarises it, and a visually hidden table of the exact values).
// Geometry uses numbers; every value that is READ on the screen is the exact string it came from.

// One accent: pale butter marks the series that matters most; everything else is slate-teal and mist, told apart by lightness, never by hue.
// Colours are theme variables, so the series follow the chosen background and accent: the accent (as a readable line colour) marks the series that matters,
// the others are neutrals of the foundation. Used through `style`, never as a literal.
export const SERIES_COLORS = { butter: "rgb(var(--ix-accent-text-rgb))", teal: "rgb(var(--ix-teal-rgb))", slate: "rgb(var(--ix-slate-500))", mist: "rgb(var(--ix-mist-rgb))" } as const;
const GRID = "rgb(var(--ix-mist-rgb))";
const AXIS_TEXT = "rgb(var(--ix-muted-rgb))";
const POINT_FILL = "rgb(var(--ix-deep-rgb))";

const BAR_GRADIENT = { teal: "from-ix-teal/70 to-ix-mist/80", butter: "from-ix-accent-text/55 to-ix-accent-text" } as const;

export type Point = { label: string; value: string; text: string }; // value: exact string (geometry only); text: how to write it
export type Series = { name: string; color: string; points: Point[] };

const W = 560;
const H = 220;
const PAD = { top: 14, right: 14, bottom: 28, left: 14 };

function scale(series: Series[]) {
  const max = Math.max(0, ...series.flatMap((s) => s.points.map((p) => toPlot(p.value))));
  return max > 0 ? max : 1;
}

function VisuallyHiddenTable({ caption, series }: { caption: string; series: Series[] }) {
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  return (
    // A <table> ignores width/overflow clipping, so the visually hidden wrapper is a <div>: that is what keeps it from widening the page.
    <div className="sr-only"><table>
      <caption>{caption}</caption>
      <thead>
        <tr><th scope="col">Period</th>{series.map((s) => <th key={s.name} scope="col">{s.name}</th>)}</tr>
      </thead>
      <tbody>
        {labels.map((label, i) => (
          <tr key={label}><th scope="row">{label}</th>{series.map((s) => <td key={s.name}>{s.points[i]?.text}</td>)}</tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ix-muted">
      {items.map((item) => (
        <li key={item.name} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: item.color }} />{item.name}</li>
      ))}
    </ul>
  );
}

/** Smooth area/line chart with soft fills, thin grid lines and hover points. One or more series over the same labels. */
export function AreaChart({ series, label, id }: { series: Series[]; label: string; id: string }) {
  const max = scale(series);
  const count = Math.max(1, (series[0]?.points.length ?? 1) - 1);
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / count;
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const curve = (pts: [number, number][]) =>
    pts.map(([px, py], i) => {
      if (i === 0) return `M${px},${py}`;
      const [ppx, ppy] = pts[i - 1];
      const mid = (ppx + px) / 2;
      return `C${mid},${ppy} ${mid},${py} ${px},${py}`;
    }).join(" ");
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full overflow-visible">
        <defs>
          {series.map((s, si) => (
            <linearGradient key={s.name} id={`${id}-fill-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: s.color }} stopOpacity="0.32" />
              <stop offset="100%" style={{ stopColor: s.color }} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={PAD.left} x2={W - PAD.right} y1={y(max * t)} y2={y(max * t)} style={{ stroke: GRID }} strokeOpacity={t === 0 ? 0.22 : 0.09} strokeWidth="1" />
        ))}
        {series.map((s, si) => {
          const pts = s.points.map((p, i) => [x(i), y(toPlot(p.value))] as [number, number]);
          const line = curve(pts);
          return (
            <g key={s.name}>
              <path d={`${line} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${id}-fill-${si})`} />
              <path d={line} fill="none" style={{ stroke: s.color }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {pts.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r="3.2" style={{ fill: POINT_FILL, stroke: s.color }} strokeWidth="1.6">
                  <title>{`${s.name} · ${s.points[i].label}: ${s.points[i].text}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {(series[0]?.points ?? []).map((p, i) => (
          <text key={p.label} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === count ? "end" : "middle"} fontSize="11" style={{ fill: AXIS_TEXT }}>{p.label}</text>
        ))}
      </svg>
      <VisuallyHiddenTable caption={label} series={series} />
    </figure>
  );
}

/** Rounded grouped columns (counts per day, for example). */
export function ColumnChart({ series, label }: { series: Series[]; label: string }) {
  const max = scale(series);
  const n = series[0]?.points.length ?? 0;
  const slot = (W - PAD.left - PAD.right) / Math.max(1, n);
  const barW = Math.max(3, Math.min(14, (slot * 0.7) / Math.max(1, series.length)));
  const base = H - PAD.bottom;
  const top = PAD.top;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full overflow-visible">
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={PAD.left} x2={W - PAD.right} y1={base - (base - top) * t} y2={base - (base - top) * t} style={{ stroke: GRID }} strokeOpacity={t === 0 ? 0.22 : 0.09} strokeWidth="1" />
        ))}
        {Array.from({ length: n }).map((_, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          return (
            <g key={i}>
              {series.map((s, si) => {
                const v = toPlot(s.points[i].value);
                const h = v > 0 ? Math.max(3, ((base - top) * v) / max) : 0;
                const bx = cx - (barW * series.length) / 2 + si * barW + 1;
                return h > 0 ? (
                  <rect key={s.name} x={bx} y={base - h} width={Math.max(2, barW - 2)} height={h} rx={Math.min(4, (barW - 2) / 2)} style={{ fill: s.color }} fillOpacity="0.9">
                    <title>{`${s.name} · ${s.points[i].label}: ${s.points[i].text}`}</title>
                  </rect>
                ) : null;
              })}
              {(i === 0 || i === n - 1 || i % 3 === 0) && <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" style={{ fill: AXIS_TEXT }}>{series[0].points[i].label}</text>}
            </g>
          );
        })}
      </svg>
      <VisuallyHiddenTable caption={label} series={series} />
    </figure>
  );
}

/** Horizontal rounded bars with the exact value at the end of each. */
export function BarList({ items, label, accent = "teal" }: { items: { name: string; hint?: string; value: number; text: string }[]; label: string; accent?: keyof typeof BAR_GRADIENT }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul aria-label={label} className="space-y-3">
      {items.map((item) => (
        <li key={item.name}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <Tooltip label={item.name}><span tabIndex={0} className="min-w-0 truncate rounded text-ix-text">{item.name}{item.hint && <span className="ml-1.5 text-ix-muted">{item.hint}</span>}</span></Tooltip>
            <span className="shrink-0 font-medium tabular-nums text-ix-mist">{item.text}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-ix-deep/50" role="presentation">
            <div className={`h-full rounded-full bg-gradient-to-r ${BAR_GRADIENT[accent]}`} style={{ width: `${Math.max(item.value > 0 ? 4 : 0, (item.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One stacked rounded bar (parts of a whole), with a legend carrying the exact values. */
export function StackedBar({ parts, label }: { parts: { name: string; color: string; value: number; text: string }[]; label: string }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div>
      <div role="img" aria-label={label} className="flex h-3.5 w-full overflow-hidden rounded-full bg-ix-deep/50">
        {total > 0 && parts.filter((p) => p.value > 0).map((p) => <Tooltip key={p.name} label={`${p.name}: ${p.text}`}><div style={{ width: `${(p.value / total) * 100}%`, background: p.color }} /></Tooltip>)}
      </div>
      <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.name} className="rounded-xl border border-ix-mist/10 bg-ix-deep/25 px-3 py-2">
            <span className="flex items-center gap-1.5 text-ix-muted"><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
            <span className="mt-0.5 block font-medium tabular-nums text-ix-text">{p.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
