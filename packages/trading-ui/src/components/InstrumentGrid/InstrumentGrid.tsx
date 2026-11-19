import {
  type InstrumentType,
  Side,
  type TradingSchemaName,
} from "@heswell/trading-schemas";
import { Button, Checkbox } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import {
  ContextPanelProvider,
  SlotContextPanelProvider,
  useContextPanel,
  useHideContextPanel,
} from "@vuu-ui/core";
import {
  ContextPanelProvider as ControlsContextPanelProvider,
  Prompt,
} from "@vuu-ui/vuu-ui-controls";
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
  type ColumnSetsChangeHandler,
  type ColumnSetsState,
  getActiveColumnSetColumns,
  useColumnSetModel,
  useColumnSetsState,
} from "@vuu-ui/vuu-table-extras";
import { Table } from "@vuu-ui/vuu-table";
import type {
  ColumnDescriptor,
  TableConfig,
  TablePinnedRows,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import {
  DataSourceProvider,
  AggregationType,
  filterAsQuery,
  getColumnsByName,
} from "@vuu-ui/vuu-utils";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { tradingTableSchema } from "../../data/tradingTables";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import type { LinkGroupId } from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import {
  type UserSettingsStorage,
  useUserSettingsStorage,
} from "../../utils/userSettingsStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { InstrumentLookupProvider } from "../InstrumentLookup";
import { useStaleData } from "../StaleIndicator/useStaleData";
import { useOrderTicketLauncher } from "../OrderTicket/OrderTicketLauncher";
import { registerTradingCellRenderers } from "../TradingCellRenderers";
import { registerInstrumentGridRenderers } from "./cellRenderers";
import {
  COLUMN_SETS_SETTINGS_KEY,
  DEFAULT_VIEW_SETTINGS,
  defaultColumnSets,
  FILTERS_SETTINGS_KEY,
  type GridViewSettings,
  gridSettingsKey,
  parseColumnSets,
  parseFilterState,
  parseViewSettings,
  useStoredSetting,
  VIEW_SETTINGS_KEY,
} from "./gridSettings";
import { AlsoApplied } from "./AlsoApplied";
import {
  alsoAppliedFilters,
  andFilters,
  COLUMN_SET_META_SETTINGS_KEY,
  type ColumnSetMetaState,
  parseColumnSetMeta,
  quickFilterClauses,
  quickFilterColumnsFor,
  reconcileColumnSetMeta,
  updateQuickFilterValues,
} from "./columnSetMeta";
import {
  columnSetForScope,
  columnSetsInScope,
  columnSetsOnlyIn,
  copyName,
  followColumnSets,
  LAST_COLUMN_SET_SETTINGS_KEY,
  type LastColumnSetState,
  parseLastColumnSet,
  setColumnSetScope,
  tabOrder,
} from "./columnSetScope";
import {
  instrumentGridColumns,
  SCREENING_SET_COLUMNS,
  SPARKLINE_COLUMN,
} from "./instrumentGridColumns";
import {
  buildInstrumentGridFilter,
  withSearchCasings,
} from "./instrumentGridFilter";
import {
  type ColumnSetScopeProps,
  InstrumentGridFooter,
} from "./InstrumentGridFooter";
import {
  actionsColumnDescriptor,
  type RowActionHandlers,
  RowActionsProvider,
  registerRowActionsRenderer,
  rowActionOfKey,
} from "./rowActions";
import {
  ALL_INSTRUMENTS,
  filterClauseCount,
  InstrumentGridHeader,
} from "./InstrumentGridHeader";
import { toInstrument } from "./instrumentRow";
import {
  GridChannelLinksProvider,
  isInLinkCell,
  linkColumnDescriptor,
  registerLinkCellRenderer,
  rowRicOf,
  useGridChannelLinks,
} from "./linkColumn";
import { NamePrompt } from "../NamePrompt";
import { WatchlistDialog } from "../WatchlistDialog";
import { useWatchlists, watchlistNameError } from "./watchlists";
import type { SparklineCellOptions } from "../Sparkline/Sparkline";
import gridCss from "./InstrumentGrid.css";

registerInstrumentGridRenderers();
registerLinkCellRenderer();
registerRowActionsRenderer();
registerTradingCellRenderers();

const classBase = "tradingInstrumentGrid";

export type InstrumentAction = (instrument: SelectedInstrument) => void;

export interface InstrumentGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
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
   * Show only this instrument type (EQUITY | FUTURE | ...), when the data
   * source has an instrumentType column. Without it, instrument type is a
   * quick filter in the filter bar.
   */
  instrumentType?: InstrumentType;
  /**
   * Group by this column initially ("exchange" | "sector" | "currency" |
   * "instrumentType" | "underlying"). After that, grouping is done from the
   * column header menu.
   */
  initialGroupBy?: string;
  /** Sparkline column options; false removes it. */
  sparkline?: false | Partial<SparklineCellOptions>;
  /**
   * Show the header (scope picker, panel settings) and the filter bar.
   * Default true; false hides both.
   */
  showToolbar?: boolean;
  /**
   * Offer the footer (row count, column picker). Default true; the panel
   * settings menu then shows or hides it.
   */
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
  /** Quick filter fields per column set, as persisted. */
  storedColumnSetMeta?: ColumnSetMetaState;
  onColumnSetMetaChange: (meta: ColumnSetMetaState) => void;
  /** The column set last shown in each scope, as persisted. */
  storedLastColumnSet?: LastColumnSetState;
  onLastColumnSetChange: (state: LastColumnSetState) => void;
  /** FilterBar filters as persisted. */
  storedFilterState?: FilterState;
  onFilterStateChange: (state: FilterState) => void;
  /** Panel settings (filter bar, footer) as persisted. */
  storedViewSettings?: GridViewSettings;
  onViewSettingsChange: (settings: GridViewSettings) => void;
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

/** Quick filter fields of the default column sets (see defaultColumnSets). */
const DEFAULT_COLUMN_SET_META: ColumnSetMetaState = {
  Watchlist: { quickFilterColumns: ["exchange", "sector", "instrumentType"] },
  Screening: {
    quickFilterColumns: ["sector", "marketCapUsd", "pe", "dividendYield"],
  },
};

const DEFAULT_QUICK_FILTER_COLUMNS = [
  "exchange",
  "sector",
  "instrumentType",
  "marketCapUsd",
  "pe",
  "dividendYield",
];

/**
 * Instrument grid: a preset over the vuu Table bound to instrumentPrices
 * (or prices). Price-move and change renderers, formatting per instrument,
 * grouping, a FilterBar for saved screens and quick filters, named column
 * sets (tabs in the footer, edited in the column picker), watchlists,
 * phase badge, optional sparklines, a link column for the workspace
 * channels and Buy / Sell / Depth row actions (hover, selected row, B / S /
 * D keys, context menu). The footer also shows the row count and opens the
 * column picker in the context panel.
 *
 * The first column links rows to the workspace channels: a channel dot on
 * rows whose instrument a channel holds (ringed for the active channel),
 * and a menu to link a row, one channel per instrument. On a focused row,
 * Enter (or double-click) links to the active channel, 1-4 to a channel and
 * L opens the menu. Selecting a row is local to the grid: only an explicit
 * link publishes.
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
    const columnSetMeta = useStoredSetting(
      storage,
      gridSettingsKey(COLUMN_SET_META_SETTINGS_KEY, id),
      parseColumnSetMeta,
    );
    const lastColumnSet = useStoredSetting(
      storage,
      gridSettingsKey(LAST_COLUMN_SET_SETTINGS_KEY, id),
      parseLastColumnSet,
    );
    const viewSettings = useStoredSetting(
      storage,
      gridSettingsKey(VIEW_SETTINGS_KEY, id),
      parseViewSettings,
    );
    // Column sets, filters and view settings are initial state of the grid's models, so
    // the grid is rendered once they have been read.
    return (
      <InstrumentLookupProvider>
        <ContextPanelProvider>
          <SlotContextPanelProvider>
            <ContextPanelBridge>
              {columnSets.loaded &&
              columnSetMeta.loaded &&
              lastColumnSet.loaded &&
              filters.loaded &&
              viewSettings.loaded ? (
                <InstrumentGridInner
                  {...props}
                  onColumnSetMetaChange={columnSetMeta.save}
                  onLastColumnSetChange={lastColumnSet.save}
                  onColumnSetsChange={columnSets.save}
                  onFilterStateChange={filters.save}
                  onViewSettingsChange={viewSettings.save}
                  ref={ref}
                  storedColumnSetMeta={columnSetMeta.value}
                  storedLastColumnSet={lastColumnSet.value}
                  storedColumnSets={columnSets.value}
                  storedFilterState={filters.value}
                  storedViewSettings={viewSettings.value}
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
    id,
    initialGroupBy,
    instrumentType,
    launchOrderTicket = true,
    onBuy: onBuyProp,
    onColumnSetMetaChange,
    onLastColumnSetChange,
    onColumnSetsChange,
    onFilterStateChange,
    onOpenDepth,
    onSell: onSellProp,
    onViewSettingsChange,
    showFooter = true,
    showToolbar = true,
    simulatedOnly = false,
    sparkline,
    storedColumnSetMeta,
    storedLastColumnSet,
    storedColumnSets,
    storedFilterState,
    storedViewSettings,
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
    () => ({
      columns: [linkColumnDescriptor, ...visibleColumns],
      // faint dividers and subtle stripes; colours in InstrumentGrid.css
      rowSeparators: true,
      zebraStripes: true,
    }),
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
  // --- quick filter fields per column set, in a side record (vuu's
  // ColumnSet has no room for them): switching sets switches both.
  // Sets saved before sets carried quick filters fall back to the defaults.
  const [columnSetMeta, setColumnSetMeta] = useState<ColumnSetMetaState>(
    () =>
      storedColumnSetMeta ??
      (storedColumnSets ? {} : { ...DEFAULT_COLUMN_SET_META }),
  );
  const columnSetMetaRef = useRef(columnSetMeta);
  // The default sets' meta is saved with the sets' first save, so the two
  // stay together.
  const metaSaved = useRef(storedColumnSetMeta !== undefined);
  const updateColumnSetMeta = useCallback(
    (fn: (meta: ColumnSetMetaState) => ColumnSetMetaState) => {
      const next = fn(columnSetMetaRef.current);
      if (next === columnSetMetaRef.current && metaSaved.current) return;
      metaSaved.current = true;
      columnSetMetaRef.current = next;
      setColumnSetMeta(next);
      onColumnSetMetaChange(next);
    },
    [onColumnSetMetaChange],
  );
  const [activeColumnSet, setActiveColumnSet] = useState(
    initialColumnSets.activeColumnSet,
  );
  const columnSetsRef = useRef(initialColumnSets);
  /** The quick filter fields in view (read by change handlers). */
  const quickColumnsRef = useRef<readonly string[]>([]);
  /** The scope in view: ALL_INSTRUMENTS or a watchlist id. */
  const scopeRef = useRef(ALL_INSTRUMENTS);
  // The set last shown in each scope, shown again on coming back.
  const lastColumnSetRef = useRef<LastColumnSetState>(
    storedLastColumnSet ?? {},
  );
  const updateLastColumnSet = useCallback(
    (fn: (state: LastColumnSetState) => LastColumnSetState) => {
      const next = fn(lastColumnSetRef.current);
      if (next === lastColumnSetRef.current) return;
      lastColumnSetRef.current = next;
      onLastColumnSetChange(next);
    },
    [onLastColumnSetChange],
  );
  const handleColumnSetsChange = useCallback<ColumnSetsChangeHandler>(
    (state, reason) => {
      const previous = columnSetsRef.current;
      columnSetsRef.current = state;
      setActiveColumnSet(state.activeColumnSet);
      updateLastColumnSet((last) =>
        followColumnSets(last, previous, state, scopeRef.current),
      );
      updateColumnSetMeta((meta) =>
        reconcileColumnSetMeta(
          meta,
          previous,
          state,
          reason,
          quickColumnsRef.current,
        ),
      );
      onColumnSetsChange(state);
    },
    [onColumnSetsChange, updateColumnSetMeta, updateLastColumnSet],
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
  // FilterBar Search: free text over ric and description
  const searchColumns = useMemo(
    () => ["ric", "description"].filter((c) => available.includes(c)),
    [available],
  );
  const hasTypes = available.includes("instrumentType");
  const fixedType = hasTypes ? instrumentType : undefined;
  const quickFilterAllowed = useCallback(
    (c: string) =>
      available.includes(c) && !(c === "instrumentType" && fixedType),
    [available, fixedType],
  );
  const defaultQuickFilterColumns = useMemo(
    () => DEFAULT_QUICK_FILTER_COLUMNS.filter(quickFilterAllowed),
    [quickFilterAllowed],
  );
  // With no column set in view, the fields are the grid's own.
  const [looseQuickColumns, setLooseQuickColumns] = useState<string[]>();
  const quickFilterColumns = useMemo(
    () =>
      (activeColumnSet
        ? quickFilterColumnsFor(
            columnSetMeta,
            activeColumnSet,
            defaultQuickFilterColumns,
          )
        : (looseQuickColumns ?? defaultQuickFilterColumns)
      ).filter(quickFilterAllowed),
    [
      activeColumnSet,
      columnSetMeta,
      defaultQuickFilterColumns,
      looseQuickColumns,
      quickFilterAllowed,
    ],
  );
  quickColumnsRef.current = quickFilterColumns;
  const quickFilterItems = useMemo(
    () =>
      filterColumns
        .filter(({ name }) => quickFilterAllowed(name))
        .map(({ label, name }) => ({ label: label ?? name, name })),
    [filterColumns, quickFilterAllowed],
  );
  const changeQuickFilterColumns = useCallback(
    (columns: string[]) => {
      const active = columnSetsRef.current.activeColumnSet;
      if (active)
        updateColumnSetMeta((meta) => ({
          ...meta,
          [active]: { ...meta[active], quickFilterColumns: columns },
        }));
      else setLooseQuickColumns(columns);
    },
    [updateColumnSetMeta],
  );
  // The latest value of each quick filter field, kept while its field is
  // out of view; those apply as "Also applied" (vuu keeps them but applies
  // only the fields in view).
  const [quickValues, setQuickValues] = useState<Record<string, Filter>>({});
  // FilterBar applies its saved (custom) filter AND the quick filters as
  // one: with a saved filter active the quick part is the second.
  const customActiveRef = useRef(
    (storedFilterState?.activeIndices.length ?? 0) > 0,
  );
  const handleFilterStateChange = useCallback(
    (state: FilterState) => {
      customActiveRef.current = state.activeIndices.length > 0;
      onFilterStateChange(state);
    },
    [onFilterStateChange],
  );
  const trackQuickValues = useCallback(
    (applied: Filter | undefined) => {
      const quickFilter = !customActiveRef.current
        ? applied
        : applied && "filters" in applied && applied.op === "and"
          ? applied.filters.length === 2
            ? applied.filters[1]
            : undefined
          : undefined;
      setQuickValues((values) =>
        updateQuickFilterValues(
          values,
          quickFilterClauses(quickFilter, searchColumns),
          quickColumnsRef.current,
        ),
      );
    },
    [searchColumns],
  );
  const alsoApplied = useMemo(
    () => alsoAppliedFilters(quickValues, quickFilterColumns),
    [quickValues, quickFilterColumns],
  );
  const clearAlsoApplied = useCallback(
    (column: string) => setQuickValues(({ [column]: _, ...rest }) => rest),
    [],
  );
  const quickFilterProps = useMemo(
    () => ({
      allowFind: searchColumns.length > 0,
      defaultQuickFilterColumns,
      onChangeQuickFilterColumns: changeQuickFilterColumns,
      quickFilterColumns,
      showFind: searchColumns,
    }),
    [
      changeQuickFilterColumns,
      defaultQuickFilterColumns,
      quickFilterColumns,
      searchColumns,
    ],
  );
  const [barFilter, setBarFilter] = useState<Filter>();
  const setUserFilter = useCallback(
    (applied: Filter) => {
      setBarFilter(applied);
      trackQuickValues(applied);
    },
    [trackQuickValues],
  );
  const clearUserFilter = useCallback(() => {
    setBarFilter(undefined);
    trackQuickValues(undefined);
  }, [trackQuickValues]);
  const userFilter = useMemo(
    () =>
      andFilters(
        barFilter,
        alsoApplied.map(({ filter }) => filter),
      ),
    [barFilter, alsoApplied],
  );
  const userFilterQuery = useMemo(
    () =>
      userFilter
        ? filterAsQuery(withSearchCasings(userFilter, searchColumns), {
            columnsByName,
          })
        : "",
    [userFilter, columnsByName, searchColumns],
  );

  // --- filtering: watchlist + FilterBar (search, quick and saved filters)
  const watchlists = useWatchlists(watchlistStorage);
  const [watchlistId, setWatchlistId] = useState(ALL_INSTRUMENTS);
  const watchlist = watchlists.lists.find((l) => l.id === watchlistId);
  const filter = useMemo(
    () =>
      buildInstrumentGridFilter({
        instrumentType: fixedType,
        simulatedOnly: simulatedOnly && hasStaticData,
        userFilter: userFilterQuery,
        watchlistRics:
          watchlistId === ALL_INSTRUMENTS ? undefined : watchlist?.rics,
      }),
    [
      userFilterQuery,
      fixedType,
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
    if (watchlistId !== ALL_INSTRUMENTS && watchlists.loaded && !watchlist) {
      setWatchlistId(ALL_INSTRUMENTS);
    }
  }, [watchlistId, watchlist, watchlists.loaded]);

  // --- column sets per scope: shared ones, then the scope's own
  scopeRef.current = watchlistId;
  const { columnSets: allColumnSets } = useColumnSetsState(columnSetModel);
  const scopedSets = useMemo(
    () => columnSetsInScope(allColumnSets, columnSetMeta, watchlistId),
    [allColumnSets, columnSetMeta, watchlistId],
  );
  const tabsRef = useRef<string[]>([]);
  tabsRef.current = tabOrder(scopedSets);
  // On entering a scope, show the set last shown there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of scope only
  useEffect(() => {
    const name = columnSetForScope(
      scopedSets,
      lastColumnSetRef.current,
      watchlistId,
      columnSetModel.activeColumnSet?.name,
    );
    if (name && name !== columnSetModel.activeColumnSet?.name)
      columnSetModel.setActiveColumnSet(name);
  }, [watchlistId]);
  const scopeLabel = watchlist?.name ?? "All instruments";
  const columnSetScope = useMemo<ColumnSetScopeProps>(
    () => ({
      label: scopeLabel,
      sets: scopedSets,
      onCreate: (name, onlyHere) => {
        columnSetModel.saveAs(name);
        if (onlyHere)
          updateColumnSetMeta((meta) =>
            setColumnSetScope(meta, name, scopeRef.current),
          );
      },
      onDelete: (name) => {
        const wasActive = columnSetModel.activeColumnSet?.name === name;
        columnSetModel.delete(name);
        const next = wasActive
          ? tabsRef.current.find((n) => n !== name)
          : undefined;
        if (next) columnSetModel.setActiveColumnSet(next);
      },
      onDuplicate: (name) => {
        const copy = copyName(
          name,
          columnSetModel.columnSets.map((set) => set.name),
        );
        columnSetModel.setActiveColumnSet(name);
        columnSetModel.saveAs(copy);
        // the copy has the source's quick filters and scope
        updateColumnSetMeta((meta) => ({ ...meta, [copy]: { ...meta[name] } }));
      },
      onShare: (name, onlyHere) =>
        updateColumnSetMeta((meta) =>
          setColumnSetScope(
            meta,
            name,
            onlyHere ? scopeRef.current : undefined,
          ),
        ),
    }),
    [columnSetModel, scopeLabel, scopedSets, updateColumnSetMeta],
  );

  // --- grouping is done from the column menus; volume and turnover are
  // summed in group rows. initialGroupBy only sets the first grouping.
  useEffect(() => {
    dataSource.aggregations = ["volume", "turnover"]
      .filter((c) => available.includes(c))
      .map((column) => ({ column, aggType: AggregationType.Sum }));
  }, [dataSource, available]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial grouping only
  useEffect(() => {
    if (initialGroupBy && available.includes(initialGroupBy)) {
      dataSource.groupBy = [initialGroupBy];
    }
  }, [dataSource]);

  // --- panel settings: filter bar and footer
  const [viewSettings, setViewSettings] = useState<GridViewSettings>(
    () => storedViewSettings ?? DEFAULT_VIEW_SETTINGS,
  );
  const updateViewSettings = useCallback(
    (change: Partial<GridViewSettings>) =>
      setViewSettings((current) => {
        const next = { ...current, ...change };
        onViewSettingsChange(next);
        return next;
      }),
    [onViewSettingsChange],
  );
  const setShowFilterBar = useCallback(
    (filterBar: boolean) => updateViewSettings({ filterBar }),
    [updateViewSettings],
  );
  const setShowFooter = useCallback(
    (footer: boolean) => updateViewSettings({ footer }),
    [updateViewSettings],
  );
  const setPinLinked = useCallback(
    (pinLinked: boolean) => updateViewSettings({ pinLinked }),
    [updateViewSettings],
  );
  const filterBarVisible = showToolbar && viewSettings.filterBar;
  const footerVisible = showFooter && viewSettings.footer;
  const handleRootKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (
        showToolbar &&
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setShowFilterBar(!viewSettings.filterBar);
      } else if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        /^Digit[1-9]$/.test(e.code)
      ) {
        // Alt+1..9: the nth column set tab (its columns and quick filters)
        const name = tabsRef.current[Number(e.code.slice(5)) - 1];
        if (name) {
          e.preventDefault();
          columnSetModel.setActiveColumnSet(name);
        }
      }
    },
    [columnSetModel, showToolbar, setShowFilterBar, viewSettings.filterBar],
  );

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

  // --- row actions: Buy / Sell / Depth on hover and the selected row,
  // B / S / D on the focused row, and in the context menu
  const rowActions = useMemo<RowActionHandlers>(
    () => ({ buy: onBuy, sell: onSell, depth: onOpenDepth }),
    [onBuy, onSell, onOpenDepth],
  );
  const hasRowActions = Boolean(onBuy || onSell || onOpenDepth);
  const tableConfig = useMemo<TableConfig>(
    () =>
      hasRowActions
        ? { ...config, columns: [...config.columns, actionsColumnDescriptor] }
        : config,
    [config, hasRowActions],
  );

  // --- selection is local to the grid (watchlist add / remove)
  const [selected, setSelected] = useState<SelectedInstrument>();
  const handleSelect = useCallback<TableRowSelectHandler>((row) => {
    if (row && row.isLeaf !== false) {
      setSelected(
        toInstrument(row as unknown as Parameters<typeof toInstrument>[0]),
      );
    } else if (!row) {
      setSelected(undefined);
    }
  }, []);
  const stableHandleSelect = useStableCallback(handleSelect);

  // --- channel links: the link column and its keys
  const links = useGridChannelLinks();
  const {
    activeChannel,
    channels,
    instrumentForRic,
    linkRic,
    linkedRics,
    setMenuRic,
  } = links;
  const channelLinks = useMemo(
    () => ({ ...links, pinLinked: viewSettings.pinLinked, setPinLinked }),
    [links, viewSettings.pinLinked, setPinLinked],
  );
  // Linked rows pin above the rest whatever the grid's filters: the Table's
  // pinned data source filters on the keys alone.
  const pinnedRows = useMemo<TablePinnedRows | undefined>(
    () =>
      viewSettings.pinLinked && linkedRics.length
        ? {
            keyColumn: "ric",
            keys: [...linkedRics],
            maxPinnedRows: channels.length,
          }
        : undefined,
    [channels.length, linkedRics, viewSettings.pinLinked],
  );
  const handleKeyDownCapture = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const ric = rowRicOf(e.target);
      if (!ric) return;
      const action = rowActionOfKey(e.key);
      if (action && rowActions[action]) {
        e.preventDefault();
        e.stopPropagation();
        rowActions[action]?.(instrumentForRic(ric));
        return;
      }
      let channel: LinkGroupId | undefined;
      if (e.key === "Enter") channel = activeChannel;
      else if (/^[1-9]$/.test(e.key)) channel = channels[Number(e.key) - 1]?.id;
      else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        e.stopPropagation();
        setMenuRic(ric);
        return;
      }
      if (!channel) return;
      // Ahead of the table, which would select the row on Enter.
      e.preventDefault();
      e.stopPropagation();
      linkRic(ric, channel);
    },
    [
      activeChannel,
      channels,
      instrumentForRic,
      linkRic,
      rowActions,
      setMenuRic,
    ],
  );
  const handleDoubleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (isInLinkCell(e.target)) return;
      const ric = rowRicOf(e.target);
      if (ric) linkRic(ric, activeChannel);
    },
    [activeChannel, linkRic],
  );

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
          label: `Buy ${instrument.ric} (B)`,
          options: instrument,
        });
      if (onSell)
        items.push({
          id: "sell",
          label: `Sell ${instrument.ric} (S)`,
          options: instrument,
        });
      if (onOpenDepth)
        items.push({
          id: "depth",
          label: `Depth ${instrument.ric} (D)`,
          options: instrument,
        });
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
        setNewWatchlist({ rics: [instrument.ric], show: false });
      } else if (id.startsWith("watchlist-add:")) {
        watchlists.add(id.slice("watchlist-add:".length), instrument.ric);
      } else return false;
      return true;
    },
    [onBuy, onSell, onOpenDepth, watchlists],
  );

  // --- watchlist prompts: name a new list, confirm a delete
  /** A new list's first rics, and whether to show it once created. */
  const [newWatchlist, setNewWatchlist] = useState<{
    rics: string[];
    show: boolean;
  }>();
  const [deletingId, setDeletingId] = useState<string>();
  const deleting = watchlists.lists.find((l) => l.id === deletingId);
  const deletingSets = deleting
    ? columnSetsOnlyIn(columnSetMeta, deleting.id)
    : [];
  const [keepDeletedSets, setKeepDeletedSets] = useState(true);
  const [editingId, setEditingId] = useState<string>();
  const editing = watchlists.lists.find((l) => l.id === editingId);
  const [renamingId, setRenamingId] = useState<string>();
  const renaming = watchlists.lists.find((l) => l.id === renamingId);
  const createWatchlist = useCallback(
    () => setNewWatchlist({ rics: selected ? [selected.ric] : [], show: true }),
    [selected],
  );
  const saveNewWatchlist = ({
    name,
    rics,
  }: {
    name: string;
    rics: string[];
  }) => {
    if (!newWatchlist) return;
    const id = watchlists.create(name, rics);
    if (newWatchlist.show) setWatchlistId(id);
  };
  const watchlistPrompts = (
    <>
      {newWatchlist ? (
        <WatchlistDialog
          initialRics={newWatchlist.rics}
          lists={watchlists.lists}
          onClose={() => setNewWatchlist(undefined)}
          onSave={saveNewWatchlist}
        />
      ) : null}
      {editing ? (
        <WatchlistDialog
          editing={editing}
          lists={watchlists.lists}
          onClose={() => setEditingId(undefined)}
          onSave={(changes) => watchlists.update(editing.id, changes)}
        />
      ) : null}
      {renaming ? (
        <NamePrompt
          confirmLabel="Rename"
          initialName={renaming.name}
          onClose={() => setRenamingId(undefined)}
          onConfirm={(name) => watchlists.rename(renaming.id, name)}
          title={`Rename ${renaming.name}`}
          validate={(name) =>
            watchlistNameError(name, watchlists.lists, renaming.id)
          }
        />
      ) : null}
      {deleting ? (
        <Prompt
          confirmButtonLabel="Delete"
          disableAccent
          initialFocusedItem="cancel"
          onClose={() => setDeletingId(undefined)}
          onConfirm={() => {
            const sets = columnSetsOnlyIn(columnSetMeta, deleting.id);
            if (keepDeletedSets)
              updateColumnSetMeta((meta) =>
                sets.reduce(
                  (m, name) => setColumnSetScope(m, name, undefined),
                  meta,
                ),
              );
            else for (const name of sets) columnSetModel.delete(name);
            updateLastColumnSet(({ [deleting.id]: _, ...rest }) => rest);
            watchlists.remove(deleting.id);
          }}
          open
          status="warning"
          title={`Delete ${deleting.name}?`}
        >
          <p className={`${classBase}-promptText`}>
            {`The watchlist and its ${deleting.rics.length} ${
              deleting.rics.length === 1 ? "instrument" : "instruments"
            } are removed. This can't be undone.`}
          </p>
          {deletingSets.length ? (
            <Checkbox
              checked={keepDeletedSets}
              label={`Keep its column ${
                deletingSets.length === 1 ? "set" : "sets"
              } (${deletingSets.join(", ")}), shared with all watchlists`}
              onChange={(e) => setKeepDeletedSets(e.target.checked)}
            />
          ) : null}
        </Prompt>
      ) : null}
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Shift+F shortcut for the grid
    <div
      {...htmlAttributes}
      {...staleProps}
      className={cx(classBase, className, staleProps.className)}
      id={id}
      onKeyDown={(e) => {
        htmlAttributes.onKeyDown?.(e);
        if (!e.defaultPrevented) handleRootKeyDown(e);
      }}
      ref={ref}
    >
      {showToolbar ? (
        <InstrumentGridHeader
          filterCount={filterClauseCount(userFilter)}
          onAddToWatchlist={watchlists.add}
          onDeleteWatchlist={(id) => {
            setKeepDeletedSets(true);
            setDeletingId(id);
          }}
          onEditWatchlist={setEditingId}
          onNewWatchlist={createWatchlist}
          onRenameWatchlist={setRenamingId}
          onRemoveFromWatchlist={watchlists.removeRic}
          onScopeChange={setWatchlistId}
          onShowFilterBarChange={setShowFilterBar}
          onShowFooterChange={setShowFooter}
          onPinLinkedChange={setPinLinked}
          pinLinked={viewSettings.pinLinked}
          scope={watchlistId}
          selectedRic={selected?.ric}
          showFilterBar={viewSettings.filterBar}
          showFooter={showFooter ? viewSettings.footer : undefined}
          watchlists={watchlists.lists}
        />
      ) : null}
      {showToolbar ? (
        // The quick filters' typeahead (vuu-ui-controls useVuuTypeaheadInput)
        // sends its unique-values RPC through the data source of vuu-utils'
        // DataSourceProvider: without one there are no suggestions.
        <DataSourceProvider dataSource={dataSource}>
          <FilterBar
            QuickFilterProps={quickFilterProps}
            // Hidden, not unmounted: it keeps its quick filter values, and
            // its filters still apply.
            className={cx(`${classBase}-filterBar`, {
              [`${classBase}-filterBarHidden`]: !filterBarVisible,
            })}
            columnDescriptors={filterColumns}
            // Search and the quick filters first, as in the design
            defaultFilterMode="quick-filter"
            defaultFilterState={storedFilterState}
            onApplyFilter={setUserFilter}
            onClearFilter={clearUserFilter}
            onFilterStateChanged={handleFilterStateChange}
            variant="full-filters"
            vuuTable={dataSource.table}
          />
        </DataSourceProvider>
      ) : null}
      {showToolbar && filterBarVisible && alsoApplied.length ? (
        <AlsoApplied
          columns={filterColumns}
          filters={alsoApplied}
          onClear={clearAlsoApplied}
        />
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keys and double-click of the table's rows */}
      <div
        className={`${classBase}-table`}
        onDoubleClick={handleDoubleClick}
        onKeyDownCapture={handleKeyDownCapture}
      >
        <GridChannelLinksProvider value={channelLinks}>
          <ContextMenuProvider
            menuActionHandler={menuActionHandler}
            menuBuilder={menuBuilder}
          >
            <RowActionsProvider value={rowActions}>
              <Table
                config={tableConfig}
                dataSource={dataSource}
                onSelect={stableHandleSelect}
                pinnedRows={pinnedRows}
                selectionModel="single"
              />
            </RowActionsProvider>
          </ContextMenuProvider>
        </GridChannelLinksProvider>
        {watchlist && watchlist.rics.length === 0 ? (
          <section
            aria-label="Empty watchlist"
            className={`${classBase}-emptyList`}
          >
            <span className={`${classBase}-emptyTitle`}>
              {`${watchlist.name} is empty`}
            </span>
            <span className={`${classBase}-emptyText`}>
              Pick instruments, or filter by sector or type and add every match.
            </span>
            <Button
              appearance="solid"
              onClick={() => setEditingId(watchlist.id)}
              sentiment="accented"
            >
              Add instruments…
            </Button>
          </section>
        ) : null}
      </div>
      {footerVisible ? (
        <InstrumentGridFooter
          columnModel={columnModel}
          columnSetModel={columnSetModel}
          dataSource={dataSource}
          filtered={filterClauseCount(userFilter) > 0}
          scope={showToolbar ? columnSetScope : undefined}
          quickFilters={
            showToolbar
              ? {
                  defaultQuickFilterColumns,
                  getQuickFilterColumns: () => [...quickColumnsRef.current],
                  onChangeQuickFilterColumns: changeQuickFilterColumns,
                  quickFilterItems,
                }
              : undefined
          }
        />
      ) : null}
      {watchlistPrompts}
    </div>
  );
});
