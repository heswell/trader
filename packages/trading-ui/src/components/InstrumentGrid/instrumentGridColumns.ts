import type {
  ColumnDescriptor,
  ColumnTypeRendering,
} from "@vuu-ui/vuu-table-types";
import { TradingRenderer } from "../TradingCellRenderers";
import type { SparklineCellOptions } from "../Sparkline/Sparkline";

export const SPARKLINE_COLUMN = "sparkline";

const renderer = (
  name: string,
  rest: Omit<ColumnTypeRendering, "name"> = {},
): ColumnDescriptor["type"] => ({
  name: "number",
  renderer: { name, ...rest },
});

const right = { align: "right" as const };

/** Presets for the known columns of instrumentPrices / prices. */
const presets: Record<string, ColumnDescriptor> = {
  ric: { name: "ric", width: 90 },
  description: { name: "description", width: 160 },
  isin: { name: "isin", width: 110 },
  exchange: { name: "exchange", width: 70 },
  currency: { name: "currency", width: 60 },
  sector: { name: "sector", width: 120 },
  bid: {
    name: "bid",
    width: 95,
    ...right,
    type: renderer("trading.price-move"),
  },
  ask: {
    name: "ask",
    width: 95,
    ...right,
    type: renderer("trading.price-move"),
  },
  last: {
    name: "last",
    width: 105,
    ...right,
    type: renderer("trading.price-move", { componentProps: { arrow: true } }),
  },
  bidSize: {
    name: "bidSize",
    width: 80,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  askSize: {
    name: "askSize",
    width: 80,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  lastSize: {
    name: "lastSize",
    width: 80,
    ...right,
    type: renderer("trading.quantity"),
  },
  open: {
    name: "open",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  high: {
    name: "high",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  low: {
    name: "low",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  close: {
    name: "close",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  vwap: {
    name: "vwap",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  change: {
    name: "change",
    width: 100,
    ...right,
    type: renderer("trading.change"),
  },
  changePct: {
    name: "changePct",
    label: "change %",
    width: 100,
    ...right,
    type: renderer("trading.change", { componentProps: { percent: true } }),
  },
  volume: {
    name: "volume",
    width: 95,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  turnover: {
    name: "turnover",
    width: 105,
    ...right,
    type: renderer(TradingRenderer.Notional),
  },
  tickSize: { name: "tickSize", width: 80, ...right },
  lotSize: { name: "lotSize", width: 80, ...right },
  priceDecimals: {
    name: "priceDecimals",
    label: "decimals",
    width: 80,
    ...right,
  },
  refPrice: {
    name: "refPrice",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  phase: {
    name: "phase",
    width: 110,
    type: renderer("trading.phase"),
  },
};

/** Visible by default, in this order (those present in the data source). */
export const DEFAULT_INSTRUMENT_GRID_COLUMNS = [
  "ric",
  "description",
  "exchange",
  "currency",
  "bid",
  "ask",
  "last",
  "change",
  "changePct",
  "phase",
  "sparkline",
  "volume",
  "turnover",
];

/** Descriptor for a column of the grid; unknown columns get plain vuu defaults. */
export const instrumentGridColumn = (
  name: string,
  sparkline?: Partial<SparklineCellOptions>,
): ColumnDescriptor =>
  name === SPARKLINE_COLUMN
    ? {
        name: SPARKLINE_COLUMN,
        label: "trend",
        source: "client",
        sortable: false,
        resizeable: true,
        width: 110,
        type: {
          name: "string",
          renderer: {
            name: "trading.sparkline",
            componentProps: {
              valueColumn: sparkline?.valueColumn ?? "last",
              length: sparkline?.length ?? 40,
              bucketMs: sparkline?.bucketMs ?? 0,
            },
          },
        },
      }
    : (presets[name] ?? { name });

export interface InstrumentGridColumnOptions {
  /** Column names of the data source; columns not present are dropped. */
  available: readonly string[];
  /** Visible columns in order. Defaults to DEFAULT_INSTRUMENT_GRID_COLUMNS. */
  visible?: readonly string[];
  /** false removes the sparkline column. */
  sparkline?: false | Partial<SparklineCellOptions>;
}

/**
 * Column descriptors for the grid (`visible`) and every column the column
 * picker can offer (`all`). Works for any subset of the instrumentPrices
 * columns, e.g. `prices` only has no description / currency / sector.
 */
export const instrumentGridColumns = ({
  available,
  sparkline,
  visible = DEFAULT_INSTRUMENT_GRID_COLUMNS,
}: InstrumentGridColumnOptions) => {
  const sparklineOptions = sparkline === false ? undefined : (sparkline ?? {});
  const exists = (name: string) =>
    name === SPARKLINE_COLUMN
      ? sparklineOptions !== undefined &&
        available.includes(sparklineOptions.valueColumn ?? "last")
      : available.includes(name);
  const describe = (name: string) =>
    instrumentGridColumn(name, sparklineOptions);
  const all = [
    ...available.filter((name) => name !== SPARKLINE_COLUMN),
    ...(exists(SPARKLINE_COLUMN) ? [SPARKLINE_COLUMN] : []),
  ].map(describe);
  return {
    all,
    visible: visible.filter(exists).map(describe),
  };
};

/** Columns a user can group by (when present). */
export const GROUPABLE_COLUMNS = ["exchange", "sector", "currency"] as const;
