// The sidebar never lets the page behind it scroll: with the pointer over it, the mouse wheel / trackpad either scrolls its own list (the nav) or does
// nothing at all. CSS `overscroll-behavior: contain` already stops the list from handing leftover scroll to the page, but it cannot cover the parts of the
// sidebar that are not scrollable (the logo row, a list that fits, the moment the list reaches its end on some browsers), so this does the rest.
// Pinch-zoom (Ctrl + wheel) is left alone. This file is an identical copy in both portals.

/** Starts containing wheel scrolling inside `panel`; `scroller` is its scrollable list. Returns the function that stops it. */
export function containWheel(panel: HTMLElement, scroller: () => HTMLElement | null): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return; // browser zoom
    const list = scroller();
    if (list && event.deltaY !== 0 && event.target instanceof Node && list.contains(event.target)) {
      const atTop = list.scrollTop <= 0;
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return; // the list scrolls itself
    }
    event.preventDefault(); // otherwise the page behind would move
  };
  panel.addEventListener("wheel", onWheel, { passive: false });
  return () => panel.removeEventListener("wheel", onWheel);
}
