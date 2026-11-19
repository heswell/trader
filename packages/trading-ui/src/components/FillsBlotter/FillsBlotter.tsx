import { Button, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { filterString } from "../../utils/filters";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useChannelRowMarkers } from "../ChannelRowMarkers";
import { useStaleData } from "../StaleIndicator/useStaleData";
import { type CsvColumn, downloadCsv, rowsToCsv } from "../../utils/csv";
import { formatTime } from "../../utils/time";
import { InstrumentLookupProvider } from "../InstrumentLookup";
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

const FILLS_GROUPINGS: readonly { id: FillsGrouping; label: string }[] = [
  { id: "none", label: "None" },
  { id: "ric", label: "RIC" },
  { id: "ric-side", label: "RIC / side" },
];

const DownloadIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height={14}
    stroke="currentColor"
    strokeWidth={1.4}
    viewBox="0 0 14 14"
    width={14}
  >
    <path d="M7 2v7M4 6.5L7 9.5l3-3M2.5 12h9" />
  </svg>
);

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
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
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
    const [grouping, setGrouping] = useState<FillsGrouping>(defaultGrouping);
    const groupByLabelId = useId();
    const markers = useChannelRowMarkers(tableConfig);
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
        data-testid="trading-fills-blotter"
        ref={ref}
      >
        {markers.colorStyle}
        <div className={`${classBase}-toolbar`}>
          <span className={`${classBase}-label`} id={groupByLabelId}>
            Group by
          </span>
          <ToggleButtonGroup
            aria-labelledby={groupByLabelId}
            className={`${classBase}-grouping`}
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setGrouping(e.currentTarget.value as FillsGrouping)
            }
            value={grouping}
          >
            {FILLS_GROUPINGS.map(({ id, label }) => (
              <ToggleButton key={id} value={id}>
                {label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <span className={`${classBase}-spacer`} />
          <Button
            appearance="bordered"
            disabled={records.length === 0}
            onClick={exportCsv}
            sentiment="neutral"
          >
            <DownloadIcon />
            Export CSV ({records.length})
          </Button>
        </div>
        <FillsLinkContext.Provider value={link}>
          <div className={`${classBase}-table`}>
            <Table
              config={markers.tableConfig}
              rowSelectionBorder
              dataSource={dataSource}
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
