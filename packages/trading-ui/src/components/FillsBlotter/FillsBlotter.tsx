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
import { useStaleData } from "../StaleIndicator/useStaleData";
import { type CsvColumn, downloadCsv, rowsToCsv } from "../../utils/csv";
import { formatTime } from "../../utils/time";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  InstrumentLookupProvider,
  useInstrumentLookup,
} from "../InstrumentLookup";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import {
  FillsLinkContext,
  registerFillsRenderers,
  VWAP_PRICE_RENDERER,
  FILL_ORDER_LINK_RENDERER,
} from "./FillsBlotterRenderers";

import fillsBlotterCss from "./FillsBlotter.css";

registerTradingCellRenderers();
registerFillsRenderers();

const classBase = "tradingFillsBlotter";

export type FillsGrouping = "none" | "ric" | "ric-side";

const COLUMNS = [
  "execId",
  "orderId",
  "account",
  "ric",
  "side",
  "quantity",
  "price",
  "notional",
  "currency",
  "liquidity",
  "timestamp",
  "trader",
];

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

const tableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    {
      name: "timestamp",
      label: "Time",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    {
      name: "orderId",
      label: "Order",
      width: 130,
      type: renderer(FILL_ORDER_LINK_RENDERER),
    },
    { name: "ric", width: 90 },
    { name: "side", width: 60, type: renderer(TradingRenderer.Side) },
    { name: "quantity", label: "Qty", align: "right", width: 90 },
    {
      name: "price",
      label: "Price / VWAP",
      align: "right",
      width: 130,
      type: renderer(VWAP_PRICE_RENDERER),
    },
    {
      name: "notional",
      align: "right",
      width: 130,
      type: renderer(TradingRenderer.Notional),
    },
    { name: "liquidity", width: 90, type: renderer(TradingRenderer.Liquidity) },
    { name: "account", width: 100 },
    { name: "currency", width: 70 },
    { name: "execId", width: 120 },
    { name: "trader", hidden: true },
  ],
};

const CSV_COLUMNS: CsvColumn[] = [
  { name: "execId" },
  { name: "orderId" },
  { name: "account" },
  { name: "ric" },
  { name: "side" },
  { name: "quantity" },
  { name: "price" },
  { name: "notional" },
  { name: "currency" },
  { name: "liquidity" },
  { name: "timestamp", format: (v) => formatTime(v, { utc: true }) },
];

export interface FillsBlotterProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** Initial grouping. Default "none". */
  defaultGrouping?: FillsGrouping;
  /** Restrict to one instrument. */
  ric?: string;
  /** Called when the order link of a fill is clicked. */
  onOrderSelect?: (orderId: string) => void;
  /** Order to highlight (e.g. the order selected in an OrderBlotter). */
  highlightOrderId?: string;
  /** CSV file name. Default "fills.csv". */
  csvFileName?: string;
}

const MAX_EXPORT_ROWS = 5_000;

const Inner = forwardRef<HTMLDivElement, FillsBlotterProps>(
  function FillsBlotterInner(
    {
      className,
      csvFileName = "fills.csv",
      defaultGrouping = "none",
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      showLinkGroupSelector = false,
      highlightOrderId,
      onOrderSelect,
      ric,
      ...htmlAttributes
    },
    ref,
  ) {
    const { staleProps } = useStaleData();
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-fills-blotter",
      css: fillsBlotterCss,
      window: targetWindow,
    });
    const lookup = useInstrumentLookup();
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `FillsBlotter:${htmlAttributes.id}`
        : "FillsBlotter",
    });
    const { setSelectedInstrument } = useSelectedInstrument({
      linkGroup: channel,
    });
    const [grouping, setGrouping] = useState<FillsGrouping>(defaultGrouping);
    const filter = { filter: ric ? `ric = ${filterString(ric)}` : "" };

    const dataSource = useTradingDataSource("fills", {
      columns: COLUMNS,
      filterSpec: filter,
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    // ungrouped copy of what the table shows, for CSV export
    const mirror = useTradingDataSource("fills", {
      columns: COLUMNS,
      filterSpec: filter,
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    const { rows: records } = useDataSourceRows(mirror, {
      rowCount: MAX_EXPORT_ROWS,
    });

    useEffect(() => {
      const f = { filter: ric ? `ric = ${filterString(ric)}` : "" };
      dataSource.filter = f;
      mirror.filter = f;
    }, [ric, dataSource, mirror]);

    useEffect(() => {
      const sync = (config: typeof dataSource.config) => {
        mirror.filter = config.filterSpec;
        mirror.sort = config.sort;
      };
      dataSource.on("config", sync);
      return () => dataSource.removeListener("config", sync);
    }, [dataSource, mirror]);

    useEffect(() => {
      dataSource.groupBy =
        grouping === "none"
          ? []
          : grouping === "ric"
            ? ["ric"]
            : ["ric", "side"];
      dataSource.aggregations =
        grouping === "none"
          ? []
          : [
              { column: "quantity", aggType: 1 },
              { column: "notional", aggType: 1 },
            ];
    }, [grouping, dataSource]);

    const handleSelect = useCallback<TableRowSelectHandler>(
      (row) => {
        if (row?.isLeaf && typeof row.ric === "string") {
          setSelectedInstrument(
            lookup.get(row.ric) ?? { ric: row.ric },
            "FillsBlotter",
          );
        }
      },
      [lookup, setSelectedInstrument],
    );
    const stableHandleSelect = useStableCallback(handleSelect);

    const link = useMemo(
      () => ({ onOrderSelect, highlightOrderId }),
      [onOrderSelect, highlightOrderId],
    );

    const exportCsv = useCallback(() => {
      downloadCsv(csvFileName, rowsToCsv(CSV_COLUMNS, records));
    }, [csvFileName, records]);

    return (
      <div
        {...htmlAttributes}
        {...staleProps}
        className={cx(classBase, className, staleProps.className)}
        data-link-group={linkGroup}
        data-testid="trading-fills-blotter"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <label>
            Group by{" "}
            <select
              onChange={(e) => setGrouping(e.target.value as FillsGrouping)}
              value={grouping}
            >
              <option value="none">None</option>
              <option value="ric">RIC</option>
              <option value="ric-side">RIC / side</option>
            </select>
          </label>
          <span className={`${classBase}-spacer`} />
          <button
            disabled={records.length === 0}
            onClick={exportCsv}
            type="button"
          >
            Export CSV ({records.length})
          </button>
        </div>
        <FillsLinkContext.Provider value={link}>
          <div className={`${classBase}-table`}>
            <Table
              config={tableConfig}
              dataSource={dataSource}
              onSelect={stableHandleSelect}
              selectionModel="single"
            />
          </div>
        </FillsLinkContext.Provider>
      </div>
    );
  },
);

/**
 * Fills blotter on `fills` (the server already filters to the user's own
 * fills): grouping by ric / ric+side with summed quantity and notional and
 * a VWAP price on group rows, liquidity, order links and CSV export of the
 * current filter and sort (ungrouped, up to 5,000 rows).
 */
export const FillsBlotter = forwardRef<HTMLDivElement, FillsBlotterProps>(
  function FillsBlotter(props, ref) {
    return (
      <InstrumentLookupProvider>
        <Inner {...props} ref={ref} />
      </InstrumentLookupProvider>
    );
  },
);
