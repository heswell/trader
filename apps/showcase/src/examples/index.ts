import {
  FillsBlotterExample,
  OrderBlotterExample,
  PositionsViewExample,
  TradeTapeExample,
} from "./BlotterExamples";
import { InstrumentPricesTicking } from "./InstrumentPricesTicking";
import { MarketDepthExamples } from "./MarketDepthExamples";
import { PriceLadderLive, PriceLadderStress } from "./PriceLadderExamples";
import { SideLabelExamples } from "./SideLabelExamples";
import type { ShowcaseExample } from "./types";

export type { ShowcaseExample } from "./types";

/**
 * The showcase example registry. To add an example: create
 * `examples/<Component>Examples.tsx` exporting a component, then add an entry
 * here (keep groups together, ids unique).
 */
export const examples: ShowcaseExample[] = [
  {
    id: "stack-instrument-prices",
    group: "Stack",
    title: "Ticking prices + createOrder",
    description:
      "instrumentPrices with the vuu.price-move-background renderer; buy/sell the selected instrument and watch the parentOrders row.",
    Component: InstrumentPricesTicking,
  },
  {
    id: "side-label-variants",
    group: "SideLabel",
    title: "Variants",
    Component: SideLabelExamples,
  },
  {
    id: "order-blotter",
    group: "OrderBlotter",
    title: "Working / filled / closed with amend and cancel",
    Component: OrderBlotterExample,
  },
  {
    id: "fills-blotter",
    group: "FillsBlotter",
    title: "Fills with grouping, VWAP and CSV export",
    Component: FillsBlotterExample,
  },
  {
    id: "trade-tape",
    group: "TradeTape",
    title: "Time & sales for the selected order's instrument",
    Component: TradeTapeExample,
  },
  {
    id: "positions-view",
    group: "PositionsView",
    title: "Ticking P&L with per-currency totals",
    Component: PositionsViewExample,
  },
  {
    id: "market-depth-selected",
    group: "MarketDepth",
    title: "Selected instrument",
    description:
      "Aggregated depth following the selected instrument: own orders (ACC-US-01), flashes, depth bars, halt / resume, and a second depth pinned to a ric.",
    Component: MarketDepthExamples,
  },
  {
    id: "price-ladder-live",
    group: "PriceLadder",
    title: "Live ladder",
    description:
      "Click bid / ask to trade (ACC-US-01), drag or M+arrows+Enter to amend, Delete / double-click to cancel, C to centre.",
    Component: PriceLadderLive,
  },
  {
    id: "price-ladder-stress",
    group: "PriceLadder",
    title: "Stress (50+ updates/s)",
    description:
      "PriceLadderView with a synthetic book at 10-200 updates/s; React Profiler and rAF FPS stats.",
    Component: PriceLadderStress,
  },
];
