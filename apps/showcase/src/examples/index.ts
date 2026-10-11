import { InstrumentPricesTicking } from "./InstrumentPricesTicking";
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
];
