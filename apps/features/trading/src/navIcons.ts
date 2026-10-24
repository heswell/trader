/**
 * Nav icons for the trading modules (the portal's `navIconUrl`). These are
 * outline glyphs on a 24-unit grid, drawn at 18px with a 1.6 stroke and round
 * caps / joins, matching the left-nav design. PortalNav renders them as a
 * mask in the text colour, so the stroke colour here doesn't matter.
 */
export type TradingNavIcon =
  | "workspace"
  | "watchlist"
  | "orders"
  | "executions"
  | "ladder"
  | "depth"
  | "tape"
  | "chart"
  | "depth-chart"
  | "positions"
  | "pnl"
  | "exposure"
  | "execution-quality"
  | "oversight";

const NAV_ICON_SHAPES: Readonly<Record<TradingNavIcon, string>> = {
  workspace:
    '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  watchlist:
    '<path d="M4 6h9M4 12h9M4 18h9"/><path d="M16 9.5l2.5-2.5L21 9.5"/><path d="M16 14.5l2.5 2.5 2.5-2.5"/>',
  orders:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  executions:
    '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
  ladder: '<path d="M7 3v18M17 3v18M7 7h10M7 11h10M7 15h10M7 19h10"/>',
  depth:
    '<path d="M3 20h18"/><path d="M3 17h3v-3h3v-3h3"/><path d="M21 17h-3v-4h-3v-3h-3"/>',
  tape: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chart:
    '<path d="M7 3v3M7 16v5M17 4v4M17 15v4"/><rect x="5" y="6" width="4" height="10" rx="1"/><rect x="15" y="8" width="4" height="7" rx="1"/>',
  "depth-chart":
    '<path d="M3 20h18"/><path d="M3 6c3 0 5 4 6 8l1 6"/><path d="M21 6c-3 0-5 4-6 8l-1 6"/>',
  positions:
    '<path d="M12 3l8 4.5-8 4.5-8-4.5z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5L12 21l8-4.5"/>',
  pnl: '<path d="M3 20h18"/><path d="M4 15l5-5 4 3 7-7"/><path d="M15 6h5v5"/>',
  exposure:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M12 12h9M3 9h9"/>',
  "execution-quality":
    '<circle cx="7" cy="16" r="1.3"/><circle cx="11" cy="10" r="1.3"/><circle cx="15" cy="14" r="1.3"/><circle cx="18" cy="7" r="1.3"/><path d="M3 4v17h18"/>',
  oversight:
    '<path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
};

export const navIconSvg = (icon: TradingNavIcon) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON_SHAPES[icon]}</svg>`;

/** URL-encoded `data:` URI (no quotes, safe inside CSS `url('…')`). */
export const navIconDataUri = (icon: TradingNavIcon) =>
  `data:image/svg+xml,${encodeURIComponent(navIconSvg(icon))}`;
