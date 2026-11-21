import { ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { ContextMenuProvider } from "@vuu-ui/vuu-context-menu";
import type { MenuActionHandler, MenuBuilder } from "@vuu-ui/vuu-context-menu";
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
import { applyGrouping } from "../../data/applyGrouping";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { useInstrumentLinkBus } from "../../instrument-context/InstrumentContext";
import { andFilters, filterString } from "../../utils/filters";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import {
  channelLinkMenuItem,
  handleChannelLinkAction,
  useChannelRowMarkers,
} from "../ChannelRowMarkers";
import {
  LinkedInstrumentsFooter,
  linkedInstruments,
  useLinkedRicFilter,
} from "../LinkedInstrumentsFooter";
import { useStaleData } from "../StaleIndicator/useStaleData";
import { tradingTextFormatters } from "../../export/tradingTextFormatters";
import { ExportCsvButton } from "../ExportCsvButton";
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

const FILLS_GROUPINGS: readonly { id: FillsGrouping; label: string }[] = [
  { id: "none", label: "None" },
  { id: "ric", label: "RIC" },
  { id: "ric-side", label: "RIC / side" },
];

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
  /** Suggested CSV file name. Default "fills.csv". */
  csvFileName?: string;
}

const ricFilter = (ric?: string) => (ric ? `ric = ${filterString(ric)}` : "");

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
    const [filterRic, setFilterRic] = useLinkedRicFilter(markers.linkedRics);
    const bus = useInstrumentLinkBus();
    const lookup = useInstrumentLookup();
    // row context menu: "Link <ric> to" (fill rows only, not group rows)
    const menuBuilder = useCallback<MenuBuilder>(
      (location, options) => {
        if (location !== "grid") return [];
        const dataRow = (options as { dataRow?: Record<string, unknown> })
          .dataRow;
        if (!dataRow || dataRow.isLeaf === false || !dataRow.ric) return [];
        const rowRic = String(dataRow.ric);
        return [
          channelLinkMenuItem(lookup.get(rowRic) ?? { ric: rowRic }, markers),
        ];
      },
      [lookup, markers],
    );
    const menuActionHandler = useCallback<MenuActionHandler>(
      (id, options) =>
        handleChannelLinkAction(
          id,
          options,
          bus,
          markers.channels,
          "FillsBlotter",
        ),
      [bus, markers.channels],
    );
    const filter = { filter: andFilters(ricFilter(ric), ricFilter(filterRic)) };

    const dataSource = useTradingDataSource("fills", {
      columns: COLUMNS,
      filterSpec: filter,
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    // ungrouped copy of the table's filter, for the fills count
    const mirror = useTradingDataSource("fills", {
      columns: COLUMNS,
      filterSpec: filter,
      sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
    });
    const { size: rowCount } = useDataSourceRows(mirror, { rowCount: 1 });

    useEffect(() => {
      const f = { filter: andFilters(ricFilter(ric), ricFilter(filterRic)) };
      dataSource.filter = f;
      mirror.filter = f;
    }, [ric, filterRic, dataSource, mirror]);

    useEffect(() => {
      const sync = (config: typeof dataSource.config) => {
        mirror.filter = config.filterSpec;
        mirror.sort = config.sort;
      };
      dataSource.on("config", sync);
      return () => dataSource.removeListener("config", sync);
    }, [dataSource, mirror]);

    useEffect(() => {
      applyGrouping(
        dataSource,
        grouping === "none"
          ? []
          : grouping === "ric"
            ? ["ric"]
            : ["ric", "side"],
        grouping === "none"
          ? []
          : [
              { column: "quantity", aggType: 1 },
              { column: "notional", aggType: 1 },
            ],
      );
    }, [grouping, dataSource]);

    const link = useMemo(
      () => ({ onOrderSelect, highlightOrderId }),
      [onOrderSelect, highlightOrderId],
    );

    // group rows show a VWAP; leaf rows (what the export writes) a price
    const textFormatters = useMemo(
      () => ({
        [VWAP_PRICE_RENDERER]:
          tradingTextFormatters(lookup)[TradingRenderer.Price],
      }),
      [lookup],
    );

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
          <ExportCsvButton
            dataSource={dataSource}
            disabled={rowCount === 0}
            fileName={csvFileName}
            table="fills"
            tableConfig={markers.tableConfig}
            textFormatters={textFormatters}
          />
        </div>
        <FillsLinkContext.Provider value={link}>
          <div className={`${classBase}-table`}>
            <ContextMenuProvider
              menuActionHandler={menuActionHandler}
              menuBuilder={menuBuilder}
            >
              <Table
                config={markers.tableConfig}
                rowSelectionBorder
                dataSource={dataSource}
                selectionModel="single"
              />
            </ContextMenuProvider>
          </div>
        </FillsLinkContext.Provider>
        <LinkedInstrumentsFooter
          activeChannel={markers.activeChannel}
          filterRic={filterRic}
          instruments={linkedInstruments(markers)}
          onFilterRic={setFilterRic}
          summary={`${rowCount} ${rowCount === 1 ? "fill" : "fills"}`}
        />
      </div>
    );
  },
);

/**
 * Fills blotter on `fills` (the server already filters to the user's own
 * fills): grouping by ric / ric+side with summed quantity and notional and
 * a VWAP price on group rows, liquidity, order links and Export CSV of every
 * fill in the current filter and sort (ungrouped), as the table shows them.
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
