import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useEffect, useState } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import type { LinkGroupProps } from "../../instrument-context/useComponentLinkGroup";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { renderer, simGridClass, useSimGridSetup } from "./useSimGridSetup";

registerTradingCellRenderers();

/** Sort orders offered by the SimBooksGrid toolbar. */
export const SIM_BOOKS_SORT = Object.freeze({
  ric: { column: "ric", sortType: "A" },
  gap: { column: "gapBps", sortType: "D" },
  spread: { column: "spreadBps", sortType: "D" },
  inventory: { column: "mmInventory", sortType: "D" },
  volume: { column: "volume", sortType: "D" },
} as const);

export type SimBooksSort = keyof typeof SIM_BOOKS_SORT;

const COLUMNS = [
  "ric",
  "phase",
  "haltReason",
  "fair",
  "mid",
  "gapBps",
  "spreadBps",
  "volatility",
  "realisedVolatility",
  "mmRate",
  "takerRate",
  "activity",
  "imbalance",
  "mmInventory",
  "bots",
  "tradeCount",
  "volume",
  "updated",
];

const right = { align: "right" as const };

const tableConfig: TableConfig = {
  columnDefaultWidth: 80,
  rowSeparators: true,
  columns: [
    { name: "ric", width: 90 },
    { name: "phase", width: 100 },
    {
      name: "fair",
      ...right,
      width: 90,
      type: renderer(TradingRenderer.Price),
    },
    { name: "mid", ...right, width: 90, type: renderer(TradingRenderer.Price) },
    { name: "gapBps", label: "Gap bp", ...right },
    { name: "spreadBps", label: "Spread bp", ...right },
    { name: "volatility", label: "Vol", ...right },
    { name: "realisedVolatility", label: "Real vol", ...right },
    {
      name: "mmInventory",
      label: "MM inventory",
      width: 130,
      type: renderer(TradingRenderer.PositionQuantity),
    },
    { name: "imbalance", label: "Imbal.", ...right },
    { name: "mmRate", label: "MM /s", ...right },
    { name: "takerRate", label: "Taker /s", ...right },
    { name: "activity", ...right },
    { name: "bots", ...right, width: 60 },
    { name: "tradeCount", label: "Trades", ...right },
    { name: "volume", ...right, width: 100 },
    { name: "haltReason", label: "Halt", width: 120 },
    { name: "updated", width: 110, type: renderer(TradingRenderer.Time) },
  ],
};

export interface SimBooksGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** Initial sort. Default "ric". */
  defaultSort?: SimBooksSort;
}

const Inner = forwardRef<HTMLDivElement, SimBooksGridProps>(
  function SimBooksGridInner(
    {
      className,
      defaultSort = "ric",
      showLinkGroupSelector = false,
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      ...htmlAttributes
    },
    ref,
  ) {
    const { staleProps } = useStaleData();
    const { linkGroup, setLinkGroup, handleSelect } = useSimGridSetup(
      "SimBooksGrid",
      { defaultLinkGroup, linkGroup: linkGroupProp, onLinkGroupChange },
      htmlAttributes.id,
    );
    const [sort, setSort] = useState<SimBooksSort>(defaultSort);
    const dataSource = useTradingDataSource("simBooks", {
      columns: COLUMNS,
      sort: { sortDefs: [SIM_BOOKS_SORT[defaultSort]] },
    });
    useEffect(() => {
      dataSource.sort = { sortDefs: [SIM_BOOKS_SORT[sort]] };
    }, [sort, dataSource]);

    return (
      <div
        {...htmlAttributes}
        {...staleProps}
        className={cx(simGridClass, className, staleProps.className)}
        data-link-group={linkGroup}
        data-testid="trading-sim-books-grid"
        ref={ref}
      >
        <div className={`${simGridClass}-toolbar`}>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <label>
            Sort by{" "}
            <select
              onChange={(e) => setSort(e.target.value as SimBooksSort)}
              value={sort}
            >
              <option value="ric">RIC</option>
              <option value="gap">Gap to fair</option>
              <option value="spread">Spread</option>
              <option value="inventory">MM inventory</option>
              <option value="volume">Volume</option>
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
  },
);

/**
 * One row per simulated book from `simBooks` (sim-admin only): phase, fair
 * value against mid, spread, model and realised volatility, flow rates and
 * market-maker inventory. Selecting a row links its instrument.
 */
export const SimBooksGrid = forwardRef<HTMLDivElement, SimBooksGridProps>(
  function SimBooksGrid(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
