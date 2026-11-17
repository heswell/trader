import {
  InstrumentType,
  Side,
  type TradingSchemaName,
} from "@heswell/trading-schemas";
import {
  Button,
  Dropdown,
  Input,
  Option,
  Overlay,
  OverlayPanel,
  OverlayPanelContent,
  OverlayTrigger,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import {
  ContextPanelProvider,
  SlotContextPanelProvider,
  useContextPanel,
  useHideContextPanel,
} from "@vuu-ui/core";
import { ContextPanelProvider as ControlsContextPanelProvider } from "@vuu-ui/vuu-ui-controls";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { ContextMenuProvider } from "@vuu-ui/vuu-context-menu";
import type {
  ContextMenuItemDescriptor,
  MenuActionHandler,
  MenuBuilder,
} from "@vuu-ui/vuu-context-menu";
import type { Filter, FilterState } from "@vuu-ui/vuu-filter-types";
import { FilterBar } from "@vuu-ui/vuu-filters";
import {
  ColumnModel,
  ColumnPickerAction,
  type ColumnSetsChangeHandler,
  type ColumnSetsState,
  ColumnSetSwitcher,
  DataSourceStats,
  getActiveColumnSetColumns,
  TableFooter,
  TableFooterTray,
  useColumnSetModel,
} from "@vuu-ui/vuu-table-extras";
import { Table } from "@vuu-ui/vuu-table";
import type {
  ColumnDescriptor,
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import {
  AggregationType,
  filterAsQuery,
  getColumnsByName,
} from "@vuu-ui/vuu-utils";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tradingTableSchema } from "../../data/tradingTables";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import {
  type SelectedInstrument,
  useSelectedInstrument,
} from "../../instrument-context/InstrumentContext";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import {
  type UserSettingsStorage,
  useUserSettingsStorage,
} from "../../utils/userSettingsStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { useStaleData } from "../StaleIndicator/useStaleData";
import { useOrderTicketLauncher } from "../OrderTicket/OrderTicketLauncher";
import { registerTradingCellRenderers } from "../TradingCellRenderers";
import { registerInstrumentGridRenderers } from "./cellRenderers";
import {
  COLUMN_SETS_SETTINGS_KEY,
  defaultColumnSets,
  FILTERS_SETTINGS_KEY,
  gridSettingsKey,
  parseColumnSets,
  parseFilterState,
  useStoredSetting,
} from "./gridSettings";
import {
  GROUPABLE_COLUMNS,
  instrumentGridColumns,
  SCREENING_SET_COLUMNS,
  SPARKLINE_COLUMN,
} from "./instrumentGridColumns";
import { buildInstrumentGridFilter } from "./instrumentGridFilter";
import { useWatchlists } from "./watchlists";
import type { SparklineCellOptions } from "../Sparkline/Sparkline";
import gridCss from "./InstrumentGrid.css";

registerInstrumentGridRenderers();
registerTradingCellRenderers();

const classBase = "tradingInstrumentGrid";
const SOURCE = "InstrumentGrid";
const ALL = "__all__";
const NONE = "__none__";
const TYPE_LABELS: Readonly<Record<string, string>> = {
  [ALL]: "All types",
  [InstrumentType.Equity]: "Equities",
  [InstrumentType.Future]: "Futures",
  [InstrumentType.Index]: "Indices",
  [InstrumentType.Continuation]: "Continuations",
};

export type InstrumentAction = (instrument: SelectedInstrument) => void;

export interface InstrumentGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect">,
    LinkGroupProps {
  /** Supply a data source (otherwise one is created from `table`). */
  dataSource?: DataSource;
  /** Table to bind to. "prices" has no static data (description, sector...). */
  table?: Extract<TradingSchemaName, "instrumentPrices" | "prices">;
  /** Visible column names, in order. Defaults to a trading preset. */
  columns?: readonly string[];
  /**
   * Only instruments quoted by the exchange simulator (default false).
   * Unquoted rows show empty (null) price cells.
   */
  simulatedOnly?: boolean;
  /**
   * Show only this instrument type initially (EQUITY | FUTURE); the toolbar
   * can change it when the data source has an instrumentType column.
   */
  instrumentType?: InstrumentType;
  /** Group by this column initially ("exchange" | "sector" | "currency"). */
  initialGroupBy?: string;
  /** Sparkline column options; false removes it. */
  sparkline?: false | Partial<SparklineCellOptions>;
  /** Hide the toolbar (watchlists, search, grouping, column sets) and filter bar. */
  showToolbar?: boolean;
  /** Hide the footer (row count, column picker). Default true. */
  showFooter?: boolean;
  /**
   * Client-side actions; the matching menu items / buttons appear when set.
   * Inside an OrderTicketLauncherProvider, Buy / Sell default to opening the
   * order ticket (see `launchOrderTicket`).
   */
  onBuy?: InstrumentAction;
  onSell?: InstrumentAction;
  /**
   * Default Buy / Sell to `useOrderTicketLauncher().openOrderTicket` when a
   * launcher is present and no onBuy / onSell is given. Default true.
   */
  launchOrderTicket?: boolean;
  /**
   * Select (highlight) the instrument selected elsewhere in this component's
   * link group. Default true.
   */
  followSelection?: boolean;
  onOpenDepth?: InstrumentAction;
  /**
   * Where watchlists, column sets and saved filters are persisted (default:
   * UserSettingsProvider / localStorage). Column sets and filters are kept
   * per grid `id`.
   */
  watchlistStorage?: UserSettingsStorage;
}

interface InstrumentGridInnerProps extends InstrumentGridProps {
  /** Column sets as persisted, undefined if none have been saved. */
  storedColumnSets?: ColumnSetsState;
  onColumnSetsChange: (state: ColumnSetsState) => void;
  /** FilterBar filters as persisted. */
  storedFilterState?: FilterState;
  onFilterStateChange: (state: FilterState) => void;
}

/**
 * vuu-table-extras (the column picker) shows its panel through the
 * vuu-ui-controls context panel, the shell provides the @vuu-ui/core one.
 * This routes the former to the latter: the shell's context panel, or
 * core's dialog when there is no shell.
 */
const ContextPanelBridge = ({ children }: { children: ReactNode }) => {
  const showContextPanel = useContextPanel();
  const hideContextPanel = useHideContextPanel();
  return (
    <ControlsContextPanelProvider
      hideContextPanel={hideContextPanel}
      showContextPanel={showContextPanel}
    >
      {children}
    </ControlsContextPanelProvider>
  );
};

const DEFAULT_QUICK_FILTER_COLUMNS = [
  "exchange",
  "sector",
  "marketCapUsd",
  "pe",
  "dividendYield",
];

const toInstrument = (row: {
  [key: string]: unknown;
  hasColumn?: (name: string) => boolean;
}): SelectedInstrument => {
  const get = (name: string) =>
    row.hasColumn && !row.hasColumn(name) ? undefined : row[name];
  const num = (name: string) => {
    const v = get(name);
    return v === undefined || v === "" || v === null ? undefined : Number(v);
  };
  const str = (name: string) => {
    const v = get(name);
    return v === undefined || v === null ? undefined : String(v);
  };
  return {
    ric: String(row.ric),
    description: str("description"),
    currency: str("currency"),
    exchange: str("exchange"),
    tickSize: num("tickSize"),
    tickBands: str("tickBands"),
    lotSize: num("lotSize"),
    priceDecimals: num("priceDecimals"),
    contractMultiplier: num("contractMultiplier"),
  };
};

/**
 * Instrument grid: a preset over the vuu Table bound to instrumentPrices
 * (or prices). Price-move and change renderers, formatting per instrument,
 * grouping, a FilterBar for saved screens and quick filters, named column
 * sets (switched in the toolbar, edited in the column picker), watchlists,
 * phase badge, optional sparklines and client-side context menu actions.
 * The footer shows the row count and opens the column picker in the
 * context panel. Selecting a row calls
 * `setSelectedInstrument(instrument, "InstrumentGrid")` in the grid's link
 * group; instruments selected elsewhere in the group are selected in the
 * grid (`followSelection`).
 */
export const InstrumentGrid = forwardRef<HTMLDivElement, InstrumentGridProps>(
  function InstrumentGrid(props, ref) {
    const { className, id, watchlistStorage } = props;
    const contextStorage = useUserSettingsStorage();
    const storage = watchlistStorage ?? contextStorage;
    const columnSets = useStoredSetting(
      storage,
      gridSettingsKey(COLUMN_SETS_SETTINGS_KEY, id),
      parseColumnSets,
    );
    const filters = useStoredSetting(
      storage,
      gridSettingsKey(FILTERS_SETTINGS_KEY, id),
      parseFilterState,
    );
    // Column sets and filters are initial state of the grid's models, so
    // the grid is rendered once they have been read.
    return (
      <InstrumentLookupProvider>
        <ContextPanelProvider>
          <SlotContextPanelProvider>
            <ContextPanelBridge>
              {columnSets.loaded && filters.loaded ? (
                <InstrumentGridInner
                  {...props}
                  onColumnSetsChange={columnSets.save}
                  onFilterStateChange={filters.save}
                  ref={ref}
                  storedColumnSets={columnSets.value}
                  storedFilterState={filters.value}
                />
              ) : (
                <div
                  aria-busy="true"
                  className={cx(classBase, className)}
                  id={id}
                  ref={ref}
                />
              )}
            </ContextPanelBridge>
          </SlotContextPanelProvider>
        </ContextPanelProvider>
      </InstrumentLookupProvider>
    );
  },
);

const InstrumentGridInner = forwardRef<
  HTMLDivElement,
  InstrumentGridInnerProps
>(function InstrumentGridInner(
  {
    className,
    columns,
    dataSource: dataSourceProp,
    defaultLinkGroup,
    followSelection = true,
    id,
    initialGroupBy,
    instrumentType: initialInstrumentType,
    launchOrderTicket = true,
    linkGroup: linkGroupProp,
    onBuy: onBuyProp,
    onColumnSetsChange,
    onFilterStateChange,
    onLinkGroupChange,
    onOpenDepth,
    onSell: onSellProp,
    showFooter = true,
    showLinkGroupSelector = false,
    showToolbar = true,
    simulatedOnly = false,
    sparkline,
    storedColumnSets,
    storedFilterState,
    table = "instrumentPrices",
    watchlistStorage,
    ...htmlAttributes
  },
  ref,
) {
  const { staleProps } = useStaleData();
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-instrument-grid",
    css: gridCss,
    window: targetWindow,
  });

  const ownDataSource = useTradingDataSource(table, {
    filterSpec: {
      filter: buildInstrumentGridFilter({
        simulatedOnly: simulatedOnly && table === "instrumentPrices",
      }),
    },
  });
  const dataSource = dataSourceProp ?? ownDataSource;
  const hasStaticData =
    (dataSource.table?.table ?? table) === "instrumentPrices";
  const available = useMemo(() => dataSource.columns, [dataSource]);

  const { all, visible } = useMemo(
    () => instrumentGridColumns({ available, sparkline, visible: columns }),
    [available, sparkline, columns],
  );
  // --- column sets: as saved, else Watchlist (the default columns) and
  // Screening when the screening columns are available. Initial state
  // only, the column set model owns it from then on.
  const [initialColumnSets] = useState<ColumnSetsState>(
    () =>
      storedColumnSets ??
      defaultColumnSets(
        visible.map(({ name }) => name),
        available.includes("marketCapUsd")
          ? SCREENING_SET_COLUMNS.filter((name) => available.includes(name))
          : [],
      ),
  );
  const initialVisible = useMemo(
    () => getActiveColumnSetColumns(initialColumnSets, all) ?? visible,
    [initialColumnSets, all, visible],
  );
  const [visibleColumns, setVisibleColumns] =
    useState<readonly ColumnDescriptor[]>(initialVisible);
  useEffect(() => setVisibleColumns(initialVisible), [initialVisible]);
  const config = useMemo<TableConfig>(
    () => ({ columns: [...visibleColumns] }),
    [visibleColumns],
  );
  // the model is the picker's own state; rebuild only when the available
  // columns change
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const columnModel = useMemo(
    () => new ColumnModel(all, visibleColumns),
    [all],
  );
  useEffect(() => {
    const handler = (columns: readonly ColumnDescriptor[]) =>
      setVisibleColumns([...columns]);
    columnModel.addListener("change", handler);
    return () => columnModel.removeListener("change", handler);
  }, [columnModel]);
  const handleColumnSetsChange = useCallback<ColumnSetsChangeHandler>(
    (state) => onColumnSetsChange(state),
    [onColumnSetsChange],
  );
  const columnSetModel = useColumnSetModel({
    columnModel,
    defaultColumnSets: initialColumnSets,
    onChange: handleColumnSetsChange,
  });

  // --- FilterBar: saved screens and quick filters over any column,
  // shown or not (all columns are subscribed)
  // Filter editors pick their parsing (numeric shorthand, dates) from
  // serverDataType, which the column presets leave to the schema.
  const tableName = dataSource.table?.table ?? table;
  const filterColumns = useMemo(() => {
    const schema = tradingTableSchema(tableName as TradingSchemaName) as
      | ReturnType<typeof tradingTableSchema>
      | undefined;
    const serverDataTypes = new Map(
      schema?.columns.map(({ name, serverDataType }) => [name, serverDataType]),
    );
    return all
      .filter(({ name }) => name !== SPARKLINE_COLUMN)
      .map((column) =>
        column.serverDataType || !serverDataTypes.has(column.name)
          ? column
          : { ...column, serverDataType: serverDataTypes.get(column.name) },
      );
  }, [all, tableName]);
  const columnsByName = useMemo(
    () => getColumnsByName(filterColumns),
    [filterColumns],
  );
  const quickFilterProps = useMemo(
    () => ({
      allowFind: false,
      defaultQuickFilterColumns: DEFAULT_QUICK_FILTER_COLUMNS.filter((c) =>
        available.includes(c),
      ),
    }),
    [available],
  );
  const [userFilter, setUserFilter] = useState<Filter>();
  const clearUserFilter = useCallback(() => setUserFilter(undefined), []);
  const userFilterQuery = useMemo(
    () => (userFilter ? filterAsQuery(userFilter, { columnsByName }) : ""),
    [userFilter, columnsByName],
  );

  // --- filtering: watchlist + search + FilterBar
  const watchlists = useWatchlists(watchlistStorage);
  const [watchlistId, setWatchlistId] = useState(ALL);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(t);
  }, [text]);
  const watchlist = watchlists.lists.find((l) => l.id === watchlistId);
  const hasTypes = available.includes("instrumentType");
  const [typeFilter, setTypeFilter] = useState<string>(
    initialInstrumentType ?? ALL,
  );
  useEffect(
    () => setTypeFilter(initialInstrumentType ?? ALL),
    [initialInstrumentType],
  );
  const filter = useMemo(
    () =>
      buildInstrumentGridFilter({
        instrumentType: hasTypes && typeFilter !== ALL ? typeFilter : undefined,
        quickFilter: debounced,
        searchColumns: ["ric", "description"].filter((c) =>
          available.includes(c),
        ),
        simulatedOnly: simulatedOnly && hasStaticData,
        userFilter: userFilterQuery,
        watchlistRics: watchlistId === ALL ? undefined : watchlist?.rics,
      }),
    [
      userFilterQuery,
      debounced,
      available,
      hasTypes,
      typeFilter,
      simulatedOnly,
      hasStaticData,
      watchlistId,
      watchlist,
    ],
  );
  useEffect(() => {
    dataSource.filter = { filter };
  }, [dataSource, filter]);
  // a deleted selected watchlist falls back to all instruments
  useEffect(() => {
    if (watchlistId !== ALL && watchlists.loaded && !watchlist) {
      setWatchlistId(ALL);
    }
  }, [watchlistId, watchlist, watchlists.loaded]);

  // --- grouping
  const groupable = GROUPABLE_COLUMNS.filter((c) => available.includes(c));
  const [groupBy, setGroupBy] = useState(initialGroupBy ?? NONE);
  useEffect(() => {
    if (groupBy === NONE || !available.includes(groupBy)) {
      dataSource.groupBy = [];
    } else {
      dataSource.aggregations = ["volume", "turnover"]
        .filter((c) => available.includes(c))
        .map((column) => ({ column, aggType: AggregationType.Sum }));
      dataSource.groupBy = [groupBy];
    }
  }, [dataSource, groupBy, available]);

  // --- Buy / Sell default to the order ticket launcher
  const launcher = useOrderTicketLauncher();
  const launch = launchOrderTicket && launcher.available;
  const { openOrderTicket } = launcher;
  const onBuy = useMemo<InstrumentAction | undefined>(
    () =>
      onBuyProp ??
      (launch
        ? (instrument) =>
            openOrderTicket({
              ric: instrument.ric,
              instrument,
              side: Side.Buy,
            })
        : undefined),
    [onBuyProp, launch, openOrderTicket],
  );
  const onSell = useMemo<InstrumentAction | undefined>(
    () =>
      onSellProp ??
      (launch
        ? (instrument) =>
            openOrderTicket({
              ric: instrument.ric,
              instrument,
              side: Side.Sell,
            })
        : undefined),
    [onSellProp, launch, openOrderTicket],
  );

  // --- selection, shared through the link group
  const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
    defaultLinkGroup,
    linkGroup: linkGroupProp,
    onLinkGroupChange,
    persistKey: id ? `${SOURCE}:${id}` : SOURCE,
  });
  const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument({
    linkGroup: channel,
  });
  const [selected, setSelected] = useState<SelectedInstrument>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Follow a selection made elsewhere in the group. The grid's own
  // selections are already `selected`, so they are not echoed back.
  useEffect(() => {
    const ric = selectedInstrument?.ric;
    if (!followSelection || !ric || ric === selectedRef.current?.ric) return;
    setSelected(selectedInstrument);
    // the ric may not be in the grid (filtered, unknown): nothing to show
    Promise.resolve(
      dataSource.select?.({
        type: "SELECT_ROW",
        rowKey: ric,
        preserveExistingSelection: false,
        // Omit<> over the SelectRequest union drops rowKey
      } as Parameters<NonNullable<DataSource["select"]>>[0]),
    ).catch(() => undefined);
  }, [dataSource, followSelection, selectedInstrument]);
  const handleSelect = useCallback<TableRowSelectHandler>(
    (row) => {
      if (row && row.isLeaf !== false) {
        const instrument = toInstrument(
          row as unknown as Parameters<typeof toInstrument>[0],
        );
        setSelected(instrument);
        setSelectedInstrument(instrument, SOURCE);
      } else if (!row) {
        setSelected(undefined);
        setSelectedInstrument(undefined, SOURCE);
      }
    },
    [setSelectedInstrument],
  );
  const stableHandleSelect = useStableCallback(handleSelect);

  // --- context menu (client-side only)
  const menuBuilder = useCallback<MenuBuilder>(
    (location, options) => {
      if (location !== "grid") return [];
      const dataRow = (options as { dataRow?: Record<string, unknown> })
        .dataRow;
      if (!dataRow || dataRow.isLeaf === false || dataRow.ric === undefined)
        return [];
      const instrument = toInstrument(dataRow);
      const items: ContextMenuItemDescriptor[] = [];
      if (onBuy)
        items.push({
          id: "buy",
          label: `Buy ${instrument.ric}`,
          options: instrument,
        });
      if (onSell)
        items.push({
          id: "sell",
          label: `Sell ${instrument.ric}`,
          options: instrument,
        });
      if (onOpenDepth)
        items.push({ id: "depth", label: "Open depth", options: instrument });
      items.push({
        label: "Add to watchlist",
        dividerBefore: items.length > 0,
        children: [
          ...watchlists.lists.map((l) => ({
            id: `watchlist-add:${l.id}`,
            label: l.name,
            options: instrument,
          })),
          {
            id: "watchlist-new",
            label: "New watchlist...",
            dividerBefore: watchlists.lists.length > 0,
            options: instrument,
          },
        ],
      });
      return items;
    },
    [onBuy, onSell, onOpenDepth, watchlists.lists],
  );
  const menuActionHandler = useCallback<MenuActionHandler>(
    (id, options) => {
      const instrument = options as unknown as SelectedInstrument;
      if (id === "buy") onBuy?.(instrument);
      else if (id === "sell") onSell?.(instrument);
      else if (id === "depth") onOpenDepth?.(instrument);
      else if (id === "watchlist-new") {
        const name = targetWindow?.prompt("Watchlist name");
        if (name) watchlists.create(name, [instrument.ric]);
      } else if (id.startsWith("watchlist-add:")) {
        watchlists.add(id.slice("watchlist-add:".length), instrument.ric);
      } else return false;
      return true;
    },
    [onBuy, onSell, onOpenDepth, watchlists, targetWindow],
  );

  const [newName, setNewName] = useState("");
  const createFromInput = () => {
    if (!newName.trim()) return;
    const id = watchlists.create(newName, selected ? [selected.ric] : []);
    setNewName("");
    setWatchlistId(id);
  };

  return (
    <div
      {...htmlAttributes}
      {...staleProps}
      className={cx(classBase, className, staleProps.className)}
      data-link-group={linkGroup}
      id={id}
      ref={ref}
    >
      {showToolbar ? (
        <div
          className={`${classBase}-toolbar`}
          role="toolbar"
          aria-label="Instrument grid"
        >
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <Input
            aria-label="Filter instruments"
            className={`${classBase}-search`}
            placeholder="Search ric / description"
            value={text}
            onChange={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <Dropdown
            aria-label="Watchlist"
            className={`${classBase}-select`}
            selected={[watchlistId]}
            value={watchlist?.name ?? "All instruments"}
            onSelectionChange={(_, [id]) => id && setWatchlistId(id)}
          >
            <Option value={ALL}>All instruments</Option>
            {watchlists.lists.map((l) => (
              <Option key={l.id} value={l.id}>
                {`${l.name} (${l.rics.length})`}
              </Option>
            ))}
          </Dropdown>
          <Overlay placement="bottom">
            <OverlayTrigger>
              <Button aria-label="Manage watchlists" appearance="bordered">
                Watchlists
              </Button>
            </OverlayTrigger>
            <OverlayPanel className={`${classBase}-popover`}>
              <OverlayPanelContent>
                <div className={`${classBase}-watchlistForm`}>
                  <Input
                    aria-label="New watchlist name"
                    placeholder="New watchlist"
                    value={newName}
                    onChange={(e) =>
                      setNewName((e.target as HTMLInputElement).value)
                    }
                    onKeyDown={(e) => e.key === "Enter" && createFromInput()}
                  />
                  <Button onClick={createFromInput}>Create</Button>
                </div>
                {watchlist ? (
                  <div className={`${classBase}-watchlistForm`}>
                    <Button
                      disabled={!selected}
                      onClick={() =>
                        selected && watchlists.add(watchlist.id, selected.ric)
                      }
                    >
                      {`Add ${selected?.ric ?? "selected"} to ${watchlist.name}`}
                    </Button>
                    <Button
                      disabled={!selected}
                      onClick={() =>
                        selected &&
                        watchlists.removeRic(watchlist.id, selected.ric)
                      }
                    >
                      Remove
                    </Button>
                    <Button
                      sentiment="negative"
                      onClick={() => watchlists.remove(watchlist.id)}
                    >
                      Delete list
                    </Button>
                  </div>
                ) : null}
              </OverlayPanelContent>
            </OverlayPanel>
          </Overlay>
          {hasTypes ? (
            <Dropdown
              aria-label="Instrument type"
              className={`${classBase}-select`}
              selected={[typeFilter]}
              value={TYPE_LABELS[typeFilter] ?? typeFilter}
              onSelectionChange={(_, [t]) => t && setTypeFilter(t)}
            >
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <Option key={value} value={value}>
                  {label}
                </Option>
              ))}
            </Dropdown>
          ) : null}
          {groupable.length ? (
            <Dropdown
              aria-label="Group by"
              className={`${classBase}-select`}
              selected={[groupBy]}
              value={groupBy === NONE ? "No grouping" : `Group: ${groupBy}`}
              onSelectionChange={(_, [g]) => g && setGroupBy(g)}
            >
              <Option value={NONE}>No grouping</Option>
              {groupable.map((c) => (
                <Option key={c} value={c}>{`Group by ${c}`}</Option>
              ))}
            </Dropdown>
          ) : null}
          <ColumnSetSwitcher
            className={`${classBase}-columnSets`}
            columnSetModel={columnSetModel}
          />
          <span className={`${classBase}-actions`}>
            {onBuy ? (
              <Button
                appearance="solid"
                sentiment="positive"
                disabled={!selected}
                onClick={() => selected && onBuy(selected)}
              >
                Buy
              </Button>
            ) : null}
            {onSell ? (
              <Button
                appearance="solid"
                sentiment="negative"
                disabled={!selected}
                onClick={() => selected && onSell(selected)}
              >
                Sell
              </Button>
            ) : null}
            {onOpenDepth ? (
              <Button
                disabled={!selected}
                onClick={() => selected && onOpenDepth(selected)}
              >
                Depth
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {showToolbar ? (
        <FilterBar
          QuickFilterProps={quickFilterProps}
          className={`${classBase}-filterBar`}
          columnDescriptors={filterColumns}
          defaultFilterState={storedFilterState}
          onApplyFilter={setUserFilter}
          onClearFilter={clearUserFilter}
          onFilterStateChanged={onFilterStateChange}
          variant="full-filters"
          vuuTable={dataSource.table}
        />
      ) : null}
      <div className={`${classBase}-table`}>
        <ContextMenuProvider
          menuActionHandler={menuActionHandler}
          menuBuilder={menuBuilder}
        >
          <Table
            config={config}
            dataSource={dataSource}
            onSelect={stableHandleSelect}
            selectionModel="single"
          />
        </ContextMenuProvider>
      </div>
      {showFooter ? (
        <TableFooter className={`${classBase}-footer`}>
          <DataSourceStats dataSource={dataSource} />
          <TableFooterTray>
            <ColumnPickerAction
              columnModel={columnModel}
              columnSetModel={columnSetModel}
            />
          </TableFooterTray>
        </TableFooter>
      ) : null}
    </div>
  );
});
