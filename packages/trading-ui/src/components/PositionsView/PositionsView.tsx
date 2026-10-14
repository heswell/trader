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
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { filterString } from "../../utils/filters";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { LinkGroupSelector } from "../LinkGroupSelector";
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
 */
export type PositionsGrouping = "none" | "sector" | "account" | "ric";

/** The positionPrices `groupBy` for each PositionsView grouping. */
export const POSITIONS_GROUP_BY: Record<PositionsGrouping, string[]> = {
  none: [],
  sector: ["currency", "sector"],
  account: ["currency", "account"],
  ric: ["currency", "ric"],
};

const aggregationsFor = (grouping: PositionsGrouping) =>
  grouping === "none" ? [] : SUMMED.map((column) => ({ column, aggType: SUM }));

export interface PositionsViewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** Initial grouping. Default "sector" (currency / sector). */
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
  "sector",
  "exchange",
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
    { name: "sector", width: 150 },
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
    { name: "exchange", hidden: true },
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
      defaultGrouping = "sector",
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      showLinkGroupSelector = false,
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
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `PositionsView:${htmlAttributes.id}`
        : "PositionsView",
    });
    const { setSelectedInstrument } = useSelectedInstrument({
      linkGroup: channel,
    });
    const [grouping, setGrouping] =
      useState<PositionsGrouping>(defaultGrouping);
    const filter = {
      filter: account ? `account = ${filterString(account)}` : "",
    };

    // Initial grouping goes in the constructor config: a groupBy set before
    // the Table subscribes is not applied by the remote data source.
    const dataSource = useTradingDataSource("positionPrices", {
      columns: COLUMNS,
      filterSpec: filter,
      groupBy: POSITIONS_GROUP_BY[defaultGrouping],
      aggregations: aggregationsFor(defaultGrouping),
    });
    const totalsSource = useTradingDataSource("positionPrices", {
      columns: ["currency", ...SUMMED],
      filterSpec: filter,
    });
    const { rows: records } = useDataSourceRows(totalsSource, {
      rowCount: 2_000,
    });
    const totals = useMemo(() => totalsByCurrency(records), [records]);

    useEffect(() => {
      const f = { filter: account ? `account = ${filterString(account)}` : "" };
      dataSource.filter = f;
      totalsSource.filter = f;
    }, [account, dataSource, totalsSource]);

    useEffect(() => {
      dataSource.groupBy = POSITIONS_GROUP_BY[grouping];
      dataSource.aggregations = aggregationsFor(grouping);
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
        data-link-group={linkGroup}
        data-testid="trading-positions-view"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <label>
            Group by{" "}
            <select
              onChange={(e) => setGrouping(e.target.value as PositionsGrouping)}
              value={grouping}
            >
              <option value="none">None</option>
              <option value="sector">Currency / sector</option>
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
 * P&L, grouping (currency then sector – the default – account or ric) with summed
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
