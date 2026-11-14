"use client";

import StockList from "../stock-list";

// The Full view's list: the same scrolling list as the Stock page, with no height limit of its own (the page scrolls).
export default function FullStockList(props: { initial: React.ComponentProps<typeof StockList>["initial"]; total: number; filters: { q: string; status: "active" | "archived" | "all" } }) {
  return <StockList key={`${props.filters.q}|${props.filters.status}`} {...props} full filtered={Boolean(props.filters.q || props.filters.status !== "active")} />;
}
