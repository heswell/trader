import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogHeader,
  Dropdown,
  FormField,
  FormFieldHelperText,
  FormFieldLabel,
  Input,
  Option,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TradingRow } from "../../data/useDataSourceRows";
import { useTradingRows } from "../../data/useTradingRows";
import { filterString } from "../../utils/filters";
import {
  type Watchlist,
  watchlistNameError,
} from "../InstrumentGrid/watchlists";
import watchlistDialogCss from "./WatchlistDialog.css";
import {
  addRics,
  facetSummary,
  facetValueLabel,
  INSTRUMENT_TYPE_OPTIONS,
  isNarrowed,
  PICKER_FACETS,
  PICKER_ROW_LIMIT,
  type PickerFacet,
  type PickerFacetValues,
  pickerFilter,
  toggleRic,
} from "./watchlistPicker";

const classBase = "tradingWatchlistDialog";

const COLUMNS = [
  "ric",
  "description",
  "sector",
  "instrumentType",
  "exchange",
  "currency",
];
const SORT = { sortDefs: [{ column: "ric", sortType: "A" as const }] };
const DEBOUNCE_MS = 120;
const NO_MATCH = `ric = ${filterString("")}`;

export interface WatchlistDialogProps {
  /** The list being edited; undefined for a new list. */
  editing?: Watchlist;
  /** Rics a new list starts with (e.g. the grid's selected row). */
  initialRics?: readonly string[];
  /** Every watchlist, to refuse a duplicate name. */
  lists: readonly Watchlist[];
  onClose: () => void;
  /** Create or save: the trimmed name and the rics, in order. */
  onSave: (changes: { name: string; rics: string[] }) => void;
  open?: boolean;
}

type FacetOptions = Partial<Record<PickerFacet, string[]>>;

/**
 * Distinct values of the facet columns, from vuu's getUniqueFieldValues
 * RPC (as the quick filters' typeahead uses), else from the rows in view.
 */
const useFacetOptions = (
  dataSource: ReturnType<typeof useTradingRows>["dataSource"],
  rows: readonly TradingRow[],
) => {
  const [fetched, setFetched] = useState<FacetOptions>({});
  useEffect(() => {
    let cancelled = false;
    const table = dataSource.table;
    if (!table || !dataSource.rpcRequest) return;
    for (const { column } of PICKER_FACETS) {
      if (column === "instrumentType") continue;
      dataSource
        .rpcRequest({
          params: { column, module: table.module, table: table.table },
          rpcName: "getUniqueFieldValues",
          type: "RPC_REQUEST",
        })
        .then((response) => {
          if (cancelled || response?.type !== "SUCCESS_RESULT") return;
          const values = (response.data as unknown[]).filter(
            (v): v is string => typeof v === "string" && v !== "",
          );
          setFetched((current) => ({ ...current, [column]: values.sort() }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  return useMemo(() => {
    const options: Record<string, string[]> = {
      instrumentType: [...INSTRUMENT_TYPE_OPTIONS],
    };
    for (const { column } of PICKER_FACETS) {
      if (column === "instrumentType") continue;
      options[column] =
        fetched[column] ??
        [
          ...new Set(
            rows
              .map((row) => row[column])
              .filter((v): v is string => typeof v === "string" && v !== ""),
          ),
        ].sort();
    }
    return options as Record<PickerFacet, string[]>;
  }, [fetched, rows]);
};

const CheckIcon = ({ checked }: { checked: boolean }) => (
  <span aria-hidden="true" className={cx(`${classBase}-check`, { checked })}>
    {checked ? (
      <svg
        aria-hidden="true"
        fill="none"
        height="8"
        viewBox="0 0 16 16"
        width="8"
      >
        <path
          d="M3 8.5l3.2 3L13 4.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
      </svg>
    ) : null}
  </span>
);

/** Text with the first match of `query` (case-insensitive) marked. */
const Marked = ({ text, query }: { text: string; query: string }) => {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
};

/**
 * New / Edit watchlist: a name, then instruments picked from a searchable,
 * filterable list of `instruments` (Sector, Type, Exchange, Currency). Add
 * matches takes every instrument the search and filters list now.
 *
 * Keys: ↑↓ move, Enter adds or removes the highlighted instrument, Alt+A
 * adds all matches, Ctrl+Enter saves, Esc cancels.
 */
export const WatchlistDialog = ({
  editing,
  initialRics = [],
  lists,
  onClose,
  onSave,
  open = true,
}: WatchlistDialogProps) => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-watchlist-dialog",
    css: watchlistDialogCss,
    window: targetWindow,
  });

  const [name, setName] = useState(editing?.name ?? "");
  const [picked, setPicked] = useState<string[]>(() => [
    ...(editing?.rics ?? initialRics),
  ]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [facets, setFacets] = useState<PickerFacetValues>({});
  const [highlighted, setHighlighted] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // New: type the name first. Edit: the name is there, go to the search.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(
      () => (editing ? searchRef.current : nameRef.current)?.focus(),
      50,
    );
    return () => clearTimeout(timer);
  }, [open, editing]);

  const filter = pickerFilter(query, facets);
  const { dataSource, loaded, rows, size } = useTradingRows("instruments", {
    columns: COLUMNS,
    filter,
    rowCount: PICKER_ROW_LIMIT,
    sort: SORT,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top for a new list
  useEffect(() => setHighlighted(0), [filter]);

  // Names for picked rics not in the current results (an edited list).
  const [pickedFilter] = useState(() =>
    picked.length ? `ric in [${picked.map(filterString).join(",")}]` : NO_MATCH,
  );
  const { rows: pickedRows } = useTradingRows("instruments", {
    columns: ["ric", "description"],
    enabled: pickedFilter !== NO_MATCH,
    filter: pickedFilter,
    rowCount: PICKER_ROW_LIMIT,
  });
  const descriptions = useRef(new Map<string, string>());
  for (const row of [...pickedRows, ...rows]) {
    descriptions.current.set(String(row.ric), String(row.description ?? ""));
  }

  const facetOptions = useFacetOptions(dataSource, rows);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const narrowed = isNarrowed(query, facets);
  const toAdd = rows.filter((row) => !pickedSet.has(String(row.ric)));
  const nameError = name.trim()
    ? watchlistNameError(name, lists, editing?.id)
    : undefined;
  const canSave = name.trim() !== "" && nameError === undefined;

  const save = () => {
    if (!canSave) return;
    onSave({ name: name.trim(), rics: picked });
    onClose();
  };
  const addAll = () =>
    setPicked((current) =>
      addRics(
        current,
        toAdd.map((row) => String(row.ric)),
      ),
    );
  const toggle = (ric: string) =>
    setPicked((current) => toggleRic(current, ric));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (last < 0) return;
      setHighlighted((i) =>
        e.key === "ArrowDown" ? Math.min(last, i + 1) : Math.max(0, i - 1),
      );
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const row = rows[highlighted];
      if (row) toggle(String(row.ric));
    }
  };

  const handleDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.altKey && e.code === "KeyA" && narrowed && toAdd.length) {
      e.preventDefault();
      addAll();
    }
  };

  const setFacet = (facet: PickerFacet, values: string[]) =>
    setFacets((current) => ({ ...current, [facet]: values }));
  const anyFacet = Object.values(facets).some((v) => v?.length);
  const count = narrowed ? size : rows.length;
  const capped = size > rows.length;
  const optionId = (index: number) => `${classBase}-option-${index}`;

  return (
    <Dialog
      className={classBase}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      size="large"
    >
      <DialogHeader
        disableAccent
        header={editing ? `Edit ${editing.name}` : "New watchlist"}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+Enter and Alt+A anywhere in the dialog */}
      <div className={`${classBase}-keys`} onKeyDown={handleDialogKeyDown}>
        <DialogContent className={`${classBase}-content`}>
          <FormField
            className={`${classBase}-name`}
            validationStatus={nameError ? "error" : undefined}
          >
            <FormFieldLabel>Name</FormFieldLabel>
            <Input
              inputProps={{
                "aria-label": "Name",
                autoComplete: "off",
                maxLength: 40,
                onChange: (e) => setName(e.target.value),
              }}
              bordered
              inputRef={nameRef}
              placeholder="e.g. Energy majors"
              value={name}
            />
            {nameError ? (
              <FormFieldHelperText>{nameError}</FormFieldHelperText>
            ) : null}
          </FormField>

          <div className={`${classBase}-body`}>
            <section
              aria-label="Find instruments"
              className={`${classBase}-find`}
            >
              <Input
                className={`${classBase}-search`}
                inputProps={{
                  "aria-activedescendant": rows.length
                    ? optionId(highlighted)
                    : undefined,
                  "aria-autocomplete": "list",
                  "aria-controls": `${classBase}-results`,
                  "aria-expanded": true,
                  "aria-label": "Search by RIC or name",
                  autoComplete: "off",
                  onChange: (e) => setText(e.target.value),
                  onKeyDown: handleSearchKeyDown,
                  role: "combobox",
                  spellCheck: false,
                }}
                bordered
                inputRef={searchRef}
                placeholder="Search RIC or name…"
                value={text}
              />
              <fieldset className={`${classBase}-facets`}>
                <legend className={`${classBase}-hidden`}>Filters</legend>
                {PICKER_FACETS.map(({ column, label }) => {
                  const values = facets[column] ?? [];
                  return (
                    <Dropdown<string>
                      aria-label={label}
                      bordered
                      className={cx(`${classBase}-facet`, {
                        [`${classBase}-facetSet`]: values.length > 0,
                      })}
                      key={column}
                      multiselect
                      onSelectionChange={(_e: SyntheticEvent, next: string[]) =>
                        setFacet(column, next)
                      }
                      selected={values}
                      startAdornment={
                        <span className={`${classBase}-facetLabel`}>
                          {label}
                        </span>
                      }
                      value={facetSummary(column, values)}
                    >
                      {facetOptions[column].map((value) => (
                        <Option key={value} value={value}>
                          {facetValueLabel(column, value)}
                        </Option>
                      ))}
                    </Dropdown>
                  );
                })}
                {anyFacet ? (
                  <Button
                    appearance="transparent"
                    onClick={() => setFacets({})}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </fieldset>

              <div className={`${classBase}-section`}>
                <span className={`${classBase}-sectionLabel`}>
                  {narrowed ? "Matches" : "All instruments"}
                </span>
                <span aria-live="polite" className={`${classBase}-count`}>
                  {loaded
                    ? `${count.toLocaleString()} ${count === 1 ? "instrument" : "instruments"}${
                        capped ? `, first ${rows.length} shown` : ""
                      }`
                    : "Searching…"}
                </span>
                <span className={`${classBase}-spacer`} />
                {narrowed && toAdd.length ? (
                  <Button onClick={addAll} sentiment="accented" title="Alt+A">
                    {`Add ${toAdd.length === rows.length ? "all " : ""}${toAdd.length} ${
                      toAdd.length === 1 ? "match" : "matches"
                    }`}
                  </Button>
                ) : narrowed && rows.length ? (
                  <span className={`${classBase}-count`}>
                    All matches are in the list
                  </span>
                ) : null}
              </div>

              <div
                aria-label="Instruments"
                aria-multiselectable="true"
                className={`${classBase}-results`}
                id={`${classBase}-results`}
                ref={listRef}
                role="listbox"
              >
                {rows.map((row, index) => {
                  const ric = String(row.ric);
                  const on = pickedSet.has(ric);
                  return (
                    <div
                      aria-selected={on}
                      className={cx(`${classBase}-row`, {
                        [`${classBase}-rowHighlighted`]: index === highlighted,
                      })}
                      data-index={index}
                      id={optionId(index)}
                      key={ric}
                      onClick={() => {
                        toggle(ric);
                        setHighlighted(index);
                      }}
                      onKeyDown={undefined}
                      role="option"
                      tabIndex={-1}
                    >
                      <CheckIcon checked={on} />
                      <span className={`${classBase}-ric`}>
                        <Marked
                          query={
                            ric.toUpperCase().startsWith(query.toUpperCase())
                              ? query
                              : ""
                          }
                          text={ric}
                        />
                      </span>
                      <span className={`${classBase}-desc`}>
                        <Marked
                          query={
                            ric.toUpperCase().startsWith(query.toUpperCase())
                              ? ""
                              : query
                          }
                          text={String(row.description ?? "")}
                        />
                      </span>
                      <span className={`${classBase}-meta`}>
                        {[
                          row.instrumentType && row.instrumentType !== "EQUITY"
                            ? facetValueLabel(
                                "instrumentType",
                                String(row.instrumentType),
                              )
                            : undefined,
                          row.sector,
                          row.exchange,
                          row.currency,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  );
                })}
                {loaded && rows.length === 0 ? (
                  <div className={`${classBase}-empty`}>
                    No instruments match. Try fewer filters.
                  </div>
                ) : null}
              </div>
            </section>

            <section
              aria-label="In this watchlist"
              className={`${classBase}-picked`}
            >
              <div className={`${classBase}-pickedHeader`}>
                <span className={`${classBase}-sectionLabel`}>
                  In this watchlist
                </span>
                <span className={`${classBase}-count`}>
                  {`${picked.length} ${picked.length === 1 ? "instrument" : "instruments"}`}
                </span>
                <span className={`${classBase}-spacer`} />
                {picked.length ? (
                  <Button
                    appearance="transparent"
                    onClick={() => setPicked([])}
                  >
                    Remove all
                  </Button>
                ) : null}
              </div>
              <ul className={`${classBase}-pickedList`}>
                {picked.map((ric) => (
                  <li className={`${classBase}-pickedRow`} key={ric}>
                    <span className={`${classBase}-ric`}>{ric}</span>
                    <span className={`${classBase}-desc`}>
                      {descriptions.current.get(ric) ?? ""}
                    </span>
                    <Button
                      appearance="transparent"
                      aria-label={`Remove ${ric}`}
                      onClick={() => toggle(ric)}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          toggle(ric);
                        }
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        fill="none"
                        height="9"
                        viewBox="0 0 16 16"
                        width="9"
                      >
                        <path
                          d="M4 4l8 8M12 4l-8 8"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="2"
                        />
                      </svg>
                    </Button>
                  </li>
                ))}
                {picked.length === 0 ? (
                  <li className={`${classBase}-empty`}>
                    Nothing yet. Pick instruments on the left, or filter and add
                    every match.
                  </li>
                ) : null}
              </ul>
            </section>
          </div>
        </DialogContent>
        <DialogActions className={`${classBase}-actions`}>
          <span className={`${classBase}-hints`}>
            <kbd>↑↓</kbd> move <kbd>↵</kbd> add / remove <kbd>Alt A</kbd> add
            matches
          </span>
          <Button appearance="bordered" onClick={onClose} sentiment="neutral">
            Cancel
          </Button>
          <Button
            appearance="solid"
            disabled={!canSave}
            onClick={save}
            sentiment="accented"
            title="Ctrl+Enter"
          >
            {editing
              ? "Save"
              : picked.length
                ? `Create with ${picked.length}`
                : "Create watchlist"}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
};
