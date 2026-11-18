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

const ratio = (decimals: number): ColumnDescriptor["type"] => ({
  name: "number",
  formatting: { decimals },
});

/** Presets for the known columns of instrumentPrices / prices. */
const presets: Record<string, ColumnDescriptor> = {
  ric: { name: "ric", label: "RIC", width: 90 },
  description: { name: "description", label: "Description", width: 160 },
  isin: { name: "isin", label: "ISIN", width: 110 },
  exchange: { name: "exchange", label: "Exchange", width: 85 },
  currency: { name: "currency", label: "Ccy", width: 60 },
  sector: { name: "sector", label: "Sector", width: 120 },
  instrumentType: { name: "instrumentType", label: "Type", width: 75 },
  underlying: { name: "underlying", label: "Underlying", width: 90 },
  contract: { name: "contract", label: "Contract", width: 90 },
  expiry: {
    name: "expiry",
    label: "Expiry",
    width: 95,
    type: renderer(TradingRenderer.Date),
  },
  contractMultiplier: {
    name: "contractMultiplier",
    label: "Multiplier",
    width: 80,
    ...right,
  },
  settlementPrice: {
    name: "settlementPrice",
    label: "Settlement",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  bid: {
    name: "bid",
    label: "Bid",
    width: 95,
    ...right,
    type: renderer("trading.price-move"),
  },
  ask: {
    name: "ask",
    label: "Ask",
    width: 95,
    ...right,
    type: renderer("trading.price-move"),
  },
  last: {
    name: "last",
    label: "Last",
    width: 105,
    ...right,
    type: renderer("trading.price-move", { componentProps: { arrow: true } }),
  },
  bidSize: {
    name: "bidSize",
    label: "Bid Size",
    width: 80,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  askSize: {
    name: "askSize",
    label: "Ask Size",
    width: 80,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  lastSize: {
    name: "lastSize",
    label: "Last Size",
    width: 80,
    ...right,
    type: renderer("trading.quantity"),
  },
  open: {
    name: "open",
    label: "Open",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  high: {
    name: "high",
    label: "High",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  low: {
    name: "low",
    label: "Low",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  close: {
    name: "close",
    label: "Close",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  vwap: {
    name: "vwap",
    label: "VWAP",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  change: {
    name: "change",
    label: "Change",
    width: 100,
    ...right,
    type: renderer("trading.change"),
  },
  changePct: {
    name: "changePct",
    label: "Change %",
    width: 100,
    ...right,
    type: renderer("trading.change", { componentProps: { percent: true } }),
  },
  volume: {
    name: "volume",
    label: "Volume",
    width: 95,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  turnover: {
    name: "turnover",
    label: "Turnover",
    width: 105,
    ...right,
    type: renderer(TradingRenderer.Notional),
  },
  tickSize: { name: "tickSize", label: "Tick Size", width: 80, ...right },
  lotSize: { name: "lotSize", label: "Lot Size", width: 80, ...right },
  priceDecimals: {
    name: "priceDecimals",
    label: "Decimals",
    width: 80,
    ...right,
  },
  refPrice: {
    name: "refPrice",
    label: "Ref Price",
    width: 90,
    ...right,
    type: renderer(TradingRenderer.Price),
  },
  phase: {
    name: "phase",
    label: "Phase",
    width: 110,
    type: renderer("trading.phase"),
  },
  // screening: fundamentals (instruments) and live ratios (prices)
  marketCapUsd: {
    name: "marketCapUsd",
    label: "Mkt Cap $",
    width: 90,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
  pe: { name: "pe", label: "P/E", width: 70, ...right, type: ratio(1) },
  pb: { name: "pb", label: "P/B", width: 70, ...right, type: ratio(2) },
  dividendYield: {
    name: "dividendYield",
    label: "Yield %",
    width: 75,
    ...right,
    type: ratio(2),
  },
  roe: { name: "roe", label: "ROE %", width: 75, ...right, type: ratio(1) },
  eps: { name: "eps", label: "EPS", width: 80, ...right, type: ratio(2) },
  bookValuePerShare: {
    name: "bookValuePerShare",
    label: "Book / Share",
    width: 95,
    ...right,
    type: ratio(2),
  },
  dividendPerShare: {
    name: "dividendPerShare",
    label: "Div / Share",
    width: 90,
    ...right,
    type: ratio(2),
  },
  sharesOutstanding: {
    name: "sharesOutstanding",
    label: "Shares",
    width: 90,
    ...right,
    type: renderer("trading.quantity", { componentProps: { compact: true } }),
  },
};

/** Screening columns: hidden by default, offered by the column picker. */
export const SCREENING_COLUMNS = [
  "marketCapUsd",
  "pe",
  "pb",
  "dividendYield",
  "roe",
  "eps",
  "bookValuePerShare",
  "dividendPerShare",
  "sharesOutstanding",
] as const;

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

/** The screening column set offered alongside the default (watchlist) columns. */
export const SCREENING_SET_COLUMNS = [
  "ric",
  "description",
  "exchange",
  "sector",
  "last",
  "changePct",
  "marketCapUsd",
  "pe",
  "pb",
  "dividendYield",
  "roe",
  "volume",
];

/** "bidSize" → "Bid Size": the header for a column with no preset. */
export const titleCaseColumnName = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

/** Descriptor for a column of the grid; unknown columns get plain vuu defaults. */
export const instrumentGridColumn = (
  name: string,
  sparkline?: Partial<SparklineCellOptions>,
): ColumnDescriptor =>
  name === SPARKLINE_COLUMN
    ? {
        name: SPARKLINE_COLUMN,
        label: "Trend",
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
    : (presets[name] ?? { name, label: titleCaseColumnName(name) });

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
export const GROUPABLE_COLUMNS = [
  "exchange",
  "sector",
  "currency",
  "instrumentType",
  "underlying",
] as const;
