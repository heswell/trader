import {
  instrumentSearchFilter,
  toSelectedInstrument,
} from "../InstrumentPicker/InstrumentPicker";
import type { TradingRow } from "../../data/useDataSourceRows";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useTradingRows } from "../../data/useTradingRows";
import type { LinkGroupDefinition } from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import { filterString } from "../../utils/filters";
import { Table } from "@vuu-ui/vuu-table";
import type { DataRow, TableConfig } from "@vuu-ui/vuu-table-types";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SearchIcon } from "./ChannelSegment";
import {
  InstrumentSearchRow,
  InstrumentSearchRowContext,
  type InstrumentSearchRowContextValue,
  searchRowId,
} from "./InstrumentSearchRow";
import { type ChannelSelections, channelsByRic } from "./useChannelSelections";
import { useWorkspaceChannel } from "../../instrument-context/workspaceChannel";

const classBase = "tradingInstrumentSearch";

/** instrumentPrices columns the row reads. */
const COLUMNS = [
  "ric",
  "description",
  "currency",
  "exchange",
  "tickSize",
  "tickBands",
  "lotSize",
  "priceDecimals",
  "instrumentType",
  "contract",
  "expiry",
  "contractMultiplier",
  "bid",
  "ask",
  "last",
  "low",
  "high",
  "close",
  "changePct",
  "phase",
];
// The row draws no cells, but the Table sizes rows from the columns. "fit"
// spreads them over the dropdown's width (no horizontal scroll); a small
// minWidth lets 16 columns fit (fit gives up below 16 x the 50px default).
const TABLE_CONFIG: TableConfig = {
  columnLayout: "fit",
  columns: COLUMNS.map((name) => ({ name, minWidth: 1, width: 20 })),
  rowSeparators: false,
  zebraStripes: false,
};
const ROW_HEIGHT = 56;
const MAX_VISIBLE_ROWS = 7;
const DEBOUNCE_MS = 120;

export interface InstrumentSearchProps {
  /** The channel whose instrument is being set. */
  channel: LinkGroupDefinition;
  channels: readonly LinkGroupDefinition[];
  id: string;
  onClose: () => void;
  /** Tab / Shift+Tab: make the next / previous channel active. */
  onCycleChannel: (step: 1 | -1) => void;
  /** `viaKeyboard`: picked with Enter rather than the mouse. */
  onPick: (instrument: SelectedInstrument, viaKeyboard: boolean) => void;
  selections: ChannelSelections;
}

/** `ric in [...]`, or a filter that matches nothing for no rics. */
const ricsFilter = (rics: readonly string[]) =>
  rics.length > 0
    ? `ric in [${rics.map(filterString).join(",")}]`
    : `ric = ${filterString("")}`;

const NO_MATCH = ricsFilter([]);

/** Instruments the lookup splits into sections (the whole demo universe). */
const LOOKUP_LIMIT = 500;

const sanitize = (text: string) => text.replace(/["\\]/g, "").trim();

/**
 * Vuu filters can't say "name matches but ric doesn't" (brackets are
 * ignored), so one lookup of ric + description finds every match and the
 * sections are split here: rics starting with the query, then the rest.
 */
const useSearchSections = (query: string) => {
  const text = sanitize(query);
  const { loaded, rows } = useTradingRows("instruments", {
    columns: ["ric", "description"],
    enabled: text !== "",
    filter: text ? instrumentSearchFilter(text) : NO_MATCH,
    rowCount: LOOKUP_LIMIT,
    sort: { sortDefs: [{ column: "ric", sortType: "A" }] },
  });
  return useMemo(() => {
    if (!text) return undefined;
    const prefix = text.toUpperCase();
    const lower = text.toLowerCase();
    const ricMatches: string[] = [];
    const nameMatches: string[] = [];
    for (const row of rows) {
      const ric = String(row.ric ?? "");
      if (ric.startsWith(prefix)) ricMatches.push(ric);
      // Skips rows left from the last query until the new ones arrive.
      else if (
        String(row.description ?? "")
          .toLowerCase()
          .includes(lower)
      )
        nameMatches.push(ric);
    }
    return {
      loaded,
      ric: { filter: `ric starts ${filterString(prefix)}`, rics: ricMatches },
      name: { filter: ricsFilter(nameMatches), rics: nameMatches },
    };
  }, [loaded, rows, text]);
};

/**
 * Rows for two sections out of MAX_VISIBLE_ROWS: the first takes what it
 * needs but leaves the second up to 3.
 */
const sectionRows = (first = 0, second = 0) => {
  const a = Math.min(
    first,
    MAX_VISIBLE_ROWS - Math.min(second, MIN_SECOND_ROWS),
  );
  return [a, Math.min(second, MAX_VISIBLE_ROWS - a)] as const;
};
const MIN_SECOND_ROWS = 3;

interface SearchResultsProps {
  filter: string;
  /** 1-based row for the Table to scroll to, or -1. */
  highlightedIndex: number;
  /** Index of this section's first row in the whole list. */
  indexOffset: number;
  label?: string;
  onRowCount?: (count: number | undefined) => void;
  rowContext: Omit<InstrumentSearchRowContextValue, "indexOffset">;
  visibleRows: number;
}

/** One section of results: a Table over its own instrumentPrices source. */
const SearchResults = ({
  filter,
  highlightedIndex,
  indexOffset,
  label,
  onRowCount,
  rowContext,
  visibleRows,
}: SearchResultsProps) => {
  const dataSource = useTradingDataSource("instrumentPrices", {
    columns: COLUMNS,
    filterSpec: { filter },
    sort: { sortDefs: [{ column: "ric", sortType: "A" }] },
  });
  useEffect(() => {
    if (dataSource.filter.filter !== filter) dataSource.filter = { filter };
  }, [dataSource, filter]);

  const [rowCount, setRowCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    const onResize = (size: number) => setRowCount(size);
    dataSource.on("resize", onResize);
    return () => {
      dataSource.removeListener("resize", onResize);
    };
  }, [dataSource]);
  // A new filter: unknown count until the server answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => setRowCount(undefined), [filter]);
  useEffect(() => onRowCount?.(rowCount), [onRowCount, rowCount]);

  const context = useMemo(
    () => ({ ...rowContext, indexOffset }),
    [rowContext, indexOffset],
  );

  return (
    <div className={`${classBase}-group`}>
      {label ? <div className={`${classBase}-groupLabel`}>{label}</div> : null}
      <div style={{ height: visibleRows * ROW_HEIGHT }}>
        <InstrumentSearchRowContext.Provider value={context}>
          <Table
            Row={InstrumentSearchRow}
            className={`${classBase}-table`}
            config={TABLE_CONFIG}
            dataSource={dataSource}
            highlightedIndex={highlightedIndex}
            navigationStyle="none"
            renderBufferSize={10}
            rowHeight={ROW_HEIGHT}
            selectionModel="none"
            showColumnHeaders={false}
          />
        </InstrumentSearchRowContext.Provider>
      </div>
    </div>
  );
};

/**
 * The picker's dropdown: a search input over vuu Tables of
 * `instrumentPrices` drawn with InstrumentSearchRow - ric matches, then
 * name matches. With no text it lists the channels' and recent instruments.
 */
export const InstrumentSearch = ({
  channel,
  channels,
  id,
  onClose,
  onCycleChannel,
  onPick,
  selections,
}: InstrumentSearchProps) => {
  const { recentRics } = useWorkspaceChannel();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const byRic = useMemo(
    () => channelsByRic(channels, selections),
    [channels, selections],
  );
  const startRics = useMemo(
    () => [...new Set([...byRic.keys(), ...recentRics])],
    [byRic, recentRics],
  );
  const sections = useSearchSections(query);
  const searching = sections !== undefined;
  const firstFilter = sections?.ric.filter ?? ricsFilter(startRics);
  const secondFilter = sections?.name.filter ?? NO_MATCH;

  // Searching, the lookup gives the counts; else the start list's Table.
  const [startCount, setStartCount] = useState<number | undefined>();
  const firstCount = sections
    ? sections.loaded
      ? sections.ric.rics.length
      : undefined
    : startCount;
  const secondCount = sections
    ? sections.loaded
      ? sections.name.rics.length
      : undefined
    : 0;
  const known = firstCount !== undefined && secondCount !== undefined;
  const rowCount = known ? firstCount + secondCount : undefined;

  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // Set by the arrow keys; only then do the Tables need to scroll.
  const [keyboardNav, setKeyboardNav] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change
  useEffect(() => {
    setHighlightedIndex(0);
    setKeyboardNav(false);
  }, [firstFilter, secondFilter]);

  const tableRef = useRef<HTMLDivElement>(null);
  const pickRow = useCallback(
    (dataRow: DataRow, viaKeyboard: boolean) =>
      onPick(
        toSelectedInstrument(dataRow as unknown as TradingRow),
        viaKeyboard,
      ),
    [onPick],
  );

  const handleKeyDown = (evt: KeyboardEvent<HTMLInputElement>) => {
    const last = (rowCount ?? 0) - 1;
    switch (evt.key) {
      case "ArrowDown":
      case "ArrowUp":
        evt.preventDefault();
        if (last < 0) break;
        setKeyboardNav(true);
        setHighlightedIndex((i) =>
          evt.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1),
        );
        break;
      case "Enter": {
        evt.preventDefault();
        // Rows are virtualised; the highlighted one is always rendered.
        const row = tableRef.current?.querySelector<HTMLElement>(
          `#${CSS.escape(searchRowId(id, highlightedIndex))}`,
        );
        row?.click();
        break;
      }
      case "Escape":
        evt.preventDefault();
        onClose();
        break;
      case "Tab":
        evt.preventDefault();
        onCycleChannel(evt.shiftKey ? -1 : 1);
        break;
    }
  };

  const rowContext = useMemo(
    () => ({
      channelsByRic: byRic,
      currentRic: selections.get(channel.id)?.ric,
      highlightedIndex,
      idPrefix: id,
      onHighlight: setHighlightedIndex,
      onPick: pickRow,
      query,
    }),
    [byRic, selections, channel.id, highlightedIndex, id, query, pickRow],
  );

  const empty = rowCount === 0;
  const [firstRows, secondRows] = searching
    ? sectionRows(firstCount, secondCount)
    : [Math.min(MAX_VISIBLE_ROWS, Math.max(1, startCount ?? 1)), 0];
  // Section labels only when both sections have rows.
  const labelled = searching && firstRows > 0 && secondRows > 0;
  const sectionLabel = searching ? "Matches" : "In your channels & recent";
  const countLabel =
    rowCount === undefined
      ? "Searching…"
      : searching
        ? `${rowCount} ${rowCount === 1 ? "instrument" : "instruments"}`
        : "Type to search all instruments";
  // A Table scrolls to a row by its aria-rowindex (1-based, no header rows);
  // -1 means none. It throws for a row that is not rendered (as when new
  // results arrive), so pass one only while the arrow keys are in use.
  const tableHighlight = (offset: number, count = 0) =>
    keyboardNav &&
    highlightedIndex >= offset &&
    highlightedIndex < offset + count
      ? highlightedIndex - offset + 1
      : -1;

  return (
    <div
      aria-label={`Find instrument for the ${channel.label} channel`}
      className={classBase}
      id={id}
      role="dialog"
      style={{ "--channel-color": channel.color } as CSSProperties}
    >
      <div className={`${classBase}-searchBar`}>
        <span className={`${classBase}-channel`}>
          <span aria-hidden="true" className={`${classBase}-channelDot`} />
          {channel.label}
        </span>
        <SearchIcon />
        <input
          aria-activedescendant={
            rowCount ? searchRowId(id, highlightedIndex) : undefined
          }
          aria-autocomplete="list"
          aria-controls={`${id}-results`}
          aria-expanded="true"
          aria-label="Search by RIC or name"
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the dropdown opens to type into
          autoFocus
          className={`${classBase}-input`}
          onChange={(evt) => setText(evt.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search RIC or name…"
          role="combobox"
          spellCheck={false}
          value={text}
        />
        <kbd className={`${classBase}-kbd`}>Esc</kbd>
      </div>

      <div className={`${classBase}-section`}>
        <span>{sectionLabel}</span>
        <span className={`${classBase}-count`}>{countLabel}</span>
      </div>

      <div
        className={`${classBase}-results`}
        hidden={empty}
        id={`${id}-results`}
        ref={tableRef}
      >
        {firstRows > 0 ? (
          <SearchResults
            filter={firstFilter}
            highlightedIndex={tableHighlight(0, firstCount)}
            indexOffset={0}
            label={
              labelled ? `RIC starts with ${query.toUpperCase()}` : undefined
            }
            onRowCount={searching ? undefined : setStartCount}
            rowContext={rowContext}
            visibleRows={firstRows}
          />
        ) : null}
        {secondRows > 0 ? (
          <SearchResults
            filter={secondFilter}
            highlightedIndex={tableHighlight(firstCount ?? 0, secondCount)}
            indexOffset={firstCount ?? 0}
            label={labelled ? `Name contains “${query}”` : undefined}
            rowContext={rowContext}
            visibleRows={secondRows}
          />
        ) : null}
      </div>
      {empty ? (
        <div className={`${classBase}-empty`}>
          {query
            ? `No instruments match “${query}”`
            : "Type a RIC or name to find an instrument"}
        </div>
      ) : null}

      <div className={`${classBase}-footer`}>
        <span>
          <kbd className={`${classBase}-kbd`}>↑↓</kbd> move
        </span>
        <span>
          <kbd className={`${classBase}-kbd`}>↵</kbd> link to {channel.label}
        </span>
        <span>
          <kbd className={`${classBase}-kbd`}>Tab</kbd> switch channel
        </span>
      </div>
    </div>
  );
};
