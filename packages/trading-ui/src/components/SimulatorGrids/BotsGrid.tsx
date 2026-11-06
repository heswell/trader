import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useEffect, useState } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import type { LinkGroupProps } from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { renderer, simGridClass, useSimGridSetup } from "./useSimGridSetup";

registerTradingCellRenderers();

/** Groupings offered by the BotsGrid toolbar. */
export const BOTS_GROUP_BY = Object.freeze({
  none: [],
  kind: ["kind"],
  ric: ["ric"],
  account: ["account"],
} as const);

export type BotsGrouping = keyof typeof BOTS_GROUP_BY;

/** Summed on group rows. */
const SUMMED = [
  "position",
  "positionUsd",
  "realisedPnlUsd",
  "unrealisedPnlUsd",
  "totalPnlUsd",
  "orders",
  "fills",
  "volume",
  "notionalUsd",
  "restingOrders",
];

const COLUMNS = [
  "botId",
  "ric",
  "kind",
  "localId",
  "account",
  "position",
  "avgPrice",
  "positionUsd",
  "realisedPnlUsd",
  "unrealisedPnlUsd",
  "totalPnlUsd",
  "orders",
  "modifies",
  "cancels",
  "fills",
  "makerFills",
  "volume",
  "notionalUsd",
  "restingOrders",
  "restingBidQty",
  "restingAskQty",
  "rate",
  "effectiveRate",
  "skewTicks",
  "quotes",
  "updated",
];

const right = { align: "right" as const };
const pnl = { ...right, width: 110, type: renderer(TradingRenderer.Pnl) };

const tableConfig: TableConfig = {
  columnDefaultWidth: 80,
  rowSeparators: true,
  columns: [
    { name: "botId", label: "Bot", width: 130 },
    { name: "ric", width: 90 },
    { name: "kind", width: 110 },
    { name: "account", width: 90 },
    {
      name: "position",
      width: 120,
      type: renderer(TradingRenderer.PositionQuantity),
    },
    {
      name: "avgPrice",
      label: "Avg px",
      ...right,
      width: 90,
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "positionUsd",
      label: "Position $",
      ...right,
      width: 120,
      type: renderer(TradingRenderer.Notional),
    },
    { name: "totalPnlUsd", label: "P&L $", ...pnl },
    { name: "realisedPnlUsd", label: "Realised $", ...pnl },
    { name: "unrealisedPnlUsd", label: "Unrealised $", ...pnl },
    { name: "orders", ...right },
    { name: "fills", ...right },
    { name: "makerFills", label: "Maker", ...right },
    { name: "volume", ...right, width: 100 },
    {
      name: "notionalUsd",
      label: "Traded $",
      ...right,
      width: 130,
      type: renderer(TradingRenderer.Notional),
    },
    { name: "restingOrders", label: "Resting", ...right },
    { name: "restingBidQty", label: "Bid qty", ...right },
    { name: "restingAskQty", label: "Ask qty", ...right },
    { name: "rate", label: "Rate /s", ...right },
    { name: "effectiveRate", label: "Orders /s", ...right },
    { name: "skewTicks", label: "Skew", ...right, width: 60 },
    { name: "modifies", ...right },
    { name: "cancels", ...right },
    { name: "localId", hidden: true },
    { name: "quotes", hidden: true },
    { name: "updated", width: 110, type: renderer(TradingRenderer.Time) },
  ],
};

export interface BotsGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** Initial grouping. Default "kind". */
  defaultGrouping?: BotsGrouping;
  /** Restrict to one instrument. */
  ric?: string;
  /** Called with the selected bot's id (undefined when cleared). */
  onBotSelect?: (botId: string | undefined) => void;
}

const Inner = forwardRef<HTMLDivElement, BotsGridProps>(function BotsGridInner(
  {
    className,
    defaultGrouping = "kind",
    showLinkGroupSelector = false,
    defaultLinkGroup,
    linkGroup: linkGroupProp,
    onLinkGroupChange,
    onBotSelect,
    ric,
    ...htmlAttributes
  },
  ref,
) {
  const { staleProps } = useStaleData();
  const { linkGroup, setLinkGroup, handleSelect } = useSimGridSetup(
    "BotsGrid",
    { defaultLinkGroup, linkGroup: linkGroupProp, onLinkGroupChange },
    htmlAttributes.id,
    (row) =>
      onBotSelect?.(typeof row?.botId === "string" ? row.botId : undefined),
  );
  const [grouping, setGrouping] = useState<BotsGrouping>(defaultGrouping);
  const dataSource = useTradingDataSource("bots", {
    columns: COLUMNS,
    filterSpec: { filter: ric ? `ric = ${filterString(ric)}` : "" },
    sort: { sortDefs: [{ column: "botId", sortType: "A" }] },
  });

  useEffect(() => {
    dataSource.filter = { filter: ric ? `ric = ${filterString(ric)}` : "" };
  }, [ric, dataSource]);

  useEffect(() => {
    dataSource.groupBy = [...BOTS_GROUP_BY[grouping]];
    dataSource.aggregations =
      grouping === "none"
        ? []
        : SUMMED.map((column) => ({ column, aggType: 1 }));
  }, [grouping, dataSource]);

  return (
    <div
      {...htmlAttributes}
      {...staleProps}
      className={cx(simGridClass, className, staleProps.className)}
      data-link-group={linkGroup}
      data-testid="trading-bots-grid"
      ref={ref}
    >
      <div className={`${simGridClass}-toolbar`}>
        {showLinkGroupSelector ? (
          <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
        ) : null}
        <label>
          Group by{" "}
          <select
            onChange={(e) => setGrouping(e.target.value as BotsGrouping)}
            value={grouping}
          >
            <option value="none">None</option>
            <option value="kind">Kind</option>
            <option value="ric">RIC</option>
            <option value="account">Account</option>
          </select>
        </label>
      </div>
      <div className={`${simGridClass}-table`}>
        <Table
          config={tableConfig}
          dataSource={dataSource}
          onSelect={handleSelect}
          selectionModel="single"
        />
      </div>
    </div>
  );
});

/**
 * The simulator's bots from `bots` (sim-admin only): position, average
 * price, realised / unrealised P&L in USD, order and fill counts, resting
 * quotes and order rates. Groups by kind, instrument or account with summed
 * positions and P&L. Selecting a bot links its instrument.
 */
export const BotsGrid = forwardRef<HTMLDivElement, BotsGridProps>(
  function BotsGrid(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
