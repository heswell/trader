import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { Table } from "@vuu-ui/vuu-table";
import type {
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useDataSourceRecords } from "../../data/useDataSourceRecords";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import { formatNotional } from "../../utils/formatting";
import {
  InstrumentLookupProvider,
  useInstrumentLookup,
} from "../InstrumentLookup";
import { PnlValue } from "../PnlValue";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";

import positionsViewCss from "./PositionsView.css";

registerTradingCellRenderers();

const classBase = "tradingPositionsView";

/**
 * `none`: one row per account|ric. Grouped modes always group by currency
 * first so aggregated amounts are never summed across currencies.
 * (positions has no sector column, so there is no sector grouping.)
 */
export type PositionsGrouping = "none" | "account" | "ric";

export interface PositionsViewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Initial grouping. Default "none". */
  defaultGrouping?: PositionsGrouping;
  /** Restrict to one account. */
  account?: string;
  /** Show the per-currency totals table. Default true. */
  showTotals?: boolean;
}

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});
const pnl = renderer(TradingRenderer.Pnl);
const notional = renderer(TradingRenderer.Notional);

const COLUMNS = [
  "id",
  "account",
  "ric",
  "currency",
  "quantity",
  "avgCost",
  "markPx",
  "marketValue",
  "realizedPnl",
  "unrealizedPnl",
  "totalPnl",
  "bid",
  "ask",
  "last",
  "lastUpdate",
];

const tableConfig: TableConfig = {
  columnDefaultWidth: 100,
  rowSeparators: true,
  columns: [
    { name: "account", width: 110 },
    { name: "ric", width: 90 },
    { name: "currency", width: 70 },
    {
      name: "quantity",
      label: "Position",
      width: 130,
      align: "right",
      type: renderer(TradingRenderer.PositionQuantity),
    },
    {
      name: "avgCost",
      label: "Avg cost",
      align: "right",
      type: { name: "number", formatting: { decimals: 4 } },
    },
    {
      name: "markPx",
      label: "Mark",
      align: "right",
      type: { name: "number", formatting: { decimals: 4 } },
    },
    {
      name: "marketValue",
      label: "Market value",
      width: 140,
      align: "right",
      type: notional,
    },
    {
      name: "realizedPnl",
      label: "Realised",
      width: 130,
      align: "right",
      type: pnl,
    },
    {
      name: "unrealizedPnl",
      label: "Unrealised",
      width: 130,
      align: "right",
      type: pnl,
    },
    {
      name: "totalPnl",
      label: "Total P&L",
      width: 130,
      align: "right",
      type: pnl,
    },
    { name: "id", hidden: true },
    { name: "bid", hidden: true },
    { name: "ask", hidden: true },
    { name: "last", hidden: true },
    { name: "lastUpdate", hidden: true },
  ],
};

const SUM = 1 as const;
const SUMMED = ["marketValue", "realizedPnl", "unrealizedPnl", "totalPnl"];

export interface CurrencyTotals {
  currency: string;
  positions: number;
  marketValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
}

/** Sum position rows per currency (never across currencies). */
export const totalsByCurrency = (
  rows: readonly Record<string, unknown>[],
): CurrencyTotals[] => {
  const totals = new Map<string, CurrencyTotals>();
  for (const row of rows) {
    const currency = String(row.currency ?? "");
    let t = totals.get(currency);
    if (!t) {
      t = {
        currency,
        positions: 0,
        marketValue: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
      };
      totals.set(currency, t);
    }
    t.positions += 1;
    t.marketValue += Number(row.marketValue) || 0;
    t.realizedPnl += Number(row.realizedPnl) || 0;
    t.unrealizedPnl += Number(row.unrealizedPnl) || 0;
    t.totalPnl += Number(row.totalPnl) || 0;
  }
  return [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
};

const Inner = forwardRef<HTMLDivElement, PositionsViewProps>(
  function PositionsViewInner(
    {
      account,
      className,
      defaultGrouping = "none",
      showTotals = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-positions-view",
      css: positionsViewCss,
      window: targetWindow,
    });
    const lookup = useInstrumentLookup();
    const { setSelectedInstrument } = useSelectedInstrument();
    const [grouping, setGrouping] =
      useState<PositionsGrouping>(defaultGrouping);
    const filter = { filter: account ? `account = "${account}"` : "" };

    const dataSource = useTradingDataSource("positionPrices", {
      columns: COLUMNS,
      filterSpec: filter,
    });
    const totalsSource = useTradingDataSource("positionPrices", {
      columns: ["currency", ...SUMMED],
      filterSpec: filter,
    });
    const { records } = useDataSourceRecords(totalsSource, {
      range: { from: 0, to: 2_000 },
    });
    const totals = useMemo(() => totalsByCurrency(records), [records]);

    useEffect(() => {
      const f = { filter: account ? `account = "${account}"` : "" };
      dataSource.filter = f;
      totalsSource.filter = f;
    }, [account, dataSource, totalsSource]);

    useEffect(() => {
      dataSource.groupBy =
        grouping === "none"
          ? []
          : grouping === "account"
            ? ["currency", "account"]
            : ["currency", "ric"];
      dataSource.aggregations =
        grouping === "none"
          ? []
          : SUMMED.map((column) => ({ column, aggType: SUM }));
    }, [grouping, dataSource]);

    const handleSelect = useCallback<TableRowSelectHandler>(
      (row) => {
        if (row?.isLeaf && typeof row.ric === "string") {
          setSelectedInstrument(
            lookup.get(row.ric) ?? { ric: row.ric },
            "PositionsView",
          );
        }
      },
      [lookup, setSelectedInstrument],
    );

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-positions-view"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          <label>
            Group by{" "}
            <select
              onChange={(e) => setGrouping(e.target.value as PositionsGrouping)}
              value={grouping}
            >
              <option value="none">None</option>
              <option value="account">Currency / account</option>
              <option value="ric">Currency / RIC</option>
            </select>
          </label>
        </div>
        <div className={`${classBase}-table`}>
          <Table
            config={tableConfig}
            dataSource={dataSource}
            onSelect={handleSelect}
            selectionModel="single"
          />
        </div>
        {showTotals ? (
          <table
            aria-label="Totals by currency"
            className={`${classBase}-totals`}
          >
            <thead>
              <tr>
                <th>Totals</th>
                <th>Positions</th>
                <th>Market value</th>
                <th>Realised</th>
                <th>Unrealised</th>
                <th>Total P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr data-currency={t.currency} key={t.currency}>
                  <td>
                    {t.currency}
                    {t.currency === "GBX" ? " (pence)" : ""}
                  </td>
                  <td>{t.positions}</td>
                  <td>
                    {formatNotional(t.marketValue, { currency: t.currency })}
                  </td>
                  <td>
                    <PnlValue currency={t.currency} value={t.realizedPnl} />
                  </td>
                  <td>
                    <PnlValue currency={t.currency} value={t.unrealizedPnl} />
                  </td>
                  <td>
                    <PnlValue currency={t.currency} value={t.totalPnl} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className={`${classBase}-note`}>
          Amounts are in instrument currency (GBX = pence); totals are per
          currency, never converted or mixed.
        </div>
      </div>
    );
  },
);

/**
 * Positions on `positionPrices` with ticking realised / unrealised / total
 * P&L, optional grouping (currency then account or ric) with summed
 * aggregations, and per-currency totals. Selecting a row sets the selected
 * instrument.
 */
export const PositionsView = forwardRef<HTMLDivElement, PositionsViewProps>(
  function PositionsView(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
