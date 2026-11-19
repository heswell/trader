import {
  Button,
  FormField,
  FormFieldLabel,
  Menu,
  MenuItem,
  MenuPanel,
  RadioButton,
  RadioButtonGroup,
} from "@salt-ds/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  type ColumnModel,
  type ColumnSetModel,
  getColumnSetNameError,
  useColumnSetsState,
  useTableColumnPicker,
} from "@vuu-ui/vuu-table-extras";
import {
  Prompt,
  useContextPanel,
  useHideContextPanel,
} from "@vuu-ui/vuu-ui-controls";
import cx from "clsx";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { NamePrompt } from "../NamePrompt";
import type { ScopedColumnSets } from "./columnSetScope";
import {
  GridColumnsPanel,
  type GridColumnsPanelProps,
} from "./GridColumnsPanel";

const classBase = "tradingInstrumentGridFooter";

const FilterIcon = () => (
  <svg
    aria-label="Filtered"
    fill="none"
    height="10"
    role="img"
    stroke="currentColor"
    strokeLinejoin="round"
    strokeWidth="2.4"
    viewBox="0 0 24 24"
    width="10"
  >
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </svg>
);

const ColumnsIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="12"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="12"
  >
    <rect height="16" rx="1" width="18" x="3" y="4" />
    <path d="M9 4v16M15 4v16" />
  </svg>
);

/**
 * Rows in the data source, kept current from its resize events. With a
 * filter applied this is the filtered count: the server sends no total.
 */
export const useRowCount = (dataSource: DataSource) => {
  const [size, setSize] = useState(dataSource.size);
  useEffect(() => {
    setSize(dataSource.size);
    const handleResize = (next: number) => setSize(next);
    dataSource.on("resize", handleResize);
    return () => {
      dataSource.removeListener("resize", handleResize);
    };
  }, [dataSource]);
  return size;
};

/** "1 row", "1,234 rows". */
export const formatRowCount = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;

const PinIcon = () => (
  <svg
    aria-hidden="true"
    className={`${classBase}-pin`}
    fill="none"
    height="9"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2.2"
    viewBox="0 0 24 24"
    width="9"
  >
    <path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" />
  </svg>
);

/**
 * Where the grid's column sets apply: each set is shared by every scope
 * (All instruments and each watchlist) or only in one. Without it every
 * set shows.
 */
export interface ColumnSetScopeProps {
  /** The scope in view, as the user sees it: "All instruments", "Banks". */
  label: string;
  /** The scope's sets: shared, then its own. */
  sets: ScopedColumnSets;
  /** Saves the columns in view as `name`, only here or shared. */
  onCreate: (name: string, onlyHere: boolean) => void;
  onDelete: (name: string) => void;
  /** A copy of the set, its columns and quick filters, in its scope. */
  onDuplicate: (name: string) => void;
  /** Keeps the set to this scope, or shares it with all. */
  onShare: (name: string, onlyHere: boolean) => void;
}

type TabMenu = { name: string; element: HTMLElement };

const ColumnSetTabs = ({
  columnSetModel,
  scope,
}: {
  columnSetModel: ColumnSetModel;
  scope?: ColumnSetScopeProps;
}) => {
  const { activeColumnSet, columnSets } = useColumnSetsState(columnSetModel);
  const [naming, setNaming] = useState(false);
  const [onlyHere, setOnlyHere] = useState(false);
  const [menu, setMenu] = useState<TabMenu>();
  const [renaming, setRenaming] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const shared = scope ? scope.sets.shared : columnSets.map(({ name }) => name);
  const scoped = scope ? scope.sets.scoped : [];
  const names = [...shared, ...scoped];

  // Arrow keys move between tabs and show that set, like a tablist;
  // Shift+F10 or the menu key opens the tab's menu.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = e.target as HTMLButtonElement;
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      if (tab.getAttribute("role") !== "tab") return;
      e.preventDefault();
      setMenu({ element: tab, name: tab.value });
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    e.preventDefault();
    const next =
      tabs[
        (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
      ];
    next.focus();
    columnSetModel.setActiveColumnSet(next.value);
  };

  const renderTab = (name: string, index: number, pinned: boolean) => {
    const selected = name === activeColumnSet;
    const shortcut = index < 9 ? ` (Alt+${index + 1})` : "";
    return (
      <button
        aria-selected={selected}
        className={cx(`${classBase}-tab`, {
          [`${classBase}-tabSelected`]: selected,
          [`${classBase}-tabScoped`]: pinned,
        })}
        key={name}
        onClick={() => columnSetModel.setActiveColumnSet(name)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ element: e.currentTarget, name });
        }}
        role="tab"
        tabIndex={
          selected || (!names.includes(activeColumnSet ?? "") && index === 0)
            ? 0
            : -1
        }
        title={
          pinned && scope
            ? `${name}: only in ${scope.label}${shortcut}`
            : `${name}${shortcut}`
        }
        type="button"
        value={name}
      >
        {pinned ? <PinIcon /> : null}
        {name}
      </button>
    );
  };

  const deleteSet = (name: string) =>
    scope ? scope.onDelete(name) : columnSetModel.delete(name);
  const menuScoped = menu ? scoped.includes(menu.name) : false;

  return (
    <div className={`${classBase}-columnSets`}>
      {names.length ? (
        <div
          aria-label="Column sets"
          className={`${classBase}-tabs`}
          onKeyDown={handleKeyDown}
          role="tablist"
        >
          {shared.map((name, i) => renderTab(name, i, false))}
          {shared.length && scoped.length ? (
            <span aria-hidden="true" className={`${classBase}-tabDivider`} />
          ) : null}
          {scoped.map((name, i) => renderTab(name, shared.length + i, true))}
        </div>
      ) : null}
      <button
        aria-label="New column set"
        className={`${classBase}-newSet`}
        onClick={() => {
          setOnlyHere(false);
          setNaming(true);
        }}
        title="Save the columns in view as a new column set"
        type="button"
      >
        +
      </button>
      <Menu
        getVirtualElement={() => menu?.element ?? null}
        onOpenChange={(open) => {
          if (!open) setMenu(undefined);
        }}
        open={menu !== undefined}
        placement="top-start"
      >
        <MenuPanel>
          {menu ? (
            <>
              <MenuItem onClick={() => setRenaming(menu.name)}>
                Rename…
              </MenuItem>
              {scope ? (
                <>
                  <MenuItem onClick={() => scope.onDuplicate(menu.name)}>
                    Duplicate
                  </MenuItem>
                  <MenuItem
                    onClick={() => scope.onShare(menu.name, !menuScoped)}
                  >
                    {menuScoped
                      ? "Share with all watchlists"
                      : `Only in ${scope.label}`}
                  </MenuItem>
                </>
              ) : null}
              <MenuItem onClick={() => setDeleting(menu.name)}>
                Delete…
              </MenuItem>
            </>
          ) : null}
        </MenuPanel>
      </Menu>
      {naming ? (
        <NamePrompt
          onClose={() => setNaming(false)}
          onConfirm={(name) =>
            scope ? scope.onCreate(name, onlyHere) : columnSetModel.saveAs(name)
          }
          placeholder="e.g. Screening"
          title="New column set"
          validate={(name) =>
            getColumnSetNameError(name, columnSetModel.columnSets)
          }
        >
          {scope ? (
            <FormField className={`${classBase}-availableIn`}>
              <FormFieldLabel>Available in</FormFieldLabel>
              <RadioButtonGroup
                onChange={(e) => setOnlyHere(e.target.value === "here")}
                value={onlyHere ? "here" : "all"}
              >
                <RadioButton label="All watchlists" value="all" />
                <RadioButton label={`Only ${scope.label}`} value="here" />
              </RadioButtonGroup>
            </FormField>
          ) : null}
        </NamePrompt>
      ) : null}
      {renaming ? (
        <NamePrompt
          confirmLabel="Rename"
          initialName={renaming}
          onClose={() => setRenaming(undefined)}
          onConfirm={(name) => {
            if (name !== renaming) columnSetModel.rename(renaming, name);
          }}
          title={`Rename ${renaming}`}
          validate={(name) =>
            getColumnSetNameError(name, columnSetModel.columnSets, renaming)
          }
        />
      ) : null}
      {deleting ? (
        <Prompt
          confirmButtonLabel="Delete"
          disableAccent
          initialFocusedItem="cancel"
          onClose={() => setDeleting(undefined)}
          onConfirm={() => deleteSet(deleting)}
          open
          status="warning"
          title={`Delete ${deleting}?`}
        >
          The column set and its quick filters are removed. The columns in view
          stay as they are.
        </Prompt>
      ) : null}
    </div>
  );
};

export interface InstrumentGridFooterProps {
  columnModel: ColumnModel;
  columnSetModel: ColumnSetModel;
  dataSource: DataSource;
  /** A user filter applies: the count is bold, with a filter icon. */
  filtered: boolean;
  /**
   * The quick filters of the column set in view: Columns then opens a
   * panel with a Quick filters tab beside the column picker.
   */
  quickFilters?: Omit<GridColumnsPanelProps, "columnModel" | "columnSetModel">;
  /** Column sets shared or kept to the scope in view. */
  scope?: ColumnSetScopeProps;
}

/**
 * The grid's footer: column-set tabs, the row count and the column picker.
 */
export const InstrumentGridFooter = ({
  columnModel,
  columnSetModel,
  dataSource,
  filtered,
  quickFilters,
  scope,
}: InstrumentGridFooterProps) => {
  const rowCount = useRowCount(dataSource);
  const { showColumnPicker } = useTableColumnPicker({
    columnModel,
    columnSetModel,
  });
  const showContextPanel = useContextPanel();
  const hideContextPanel = useHideContextPanel();
  const showingPanel = useRef(false);
  const quickFiltersRef = useRef(quickFilters);
  quickFiltersRef.current = quickFilters;
  useEffect(
    () => () => {
      if (showingPanel.current) hideContextPanel?.();
    },
    [hideContextPanel],
  );
  const showColumns = () => {
    const props = quickFiltersRef.current;
    if (!props) return showColumnPicker();
    showingPanel.current = true;
    showContextPanel(
      <GridColumnsPanel
        {...props}
        // the panel is not re-rendered by the footer: read the latest
        getQuickFilterColumns={() =>
          quickFiltersRef.current?.getQuickFilterColumns() ?? []
        }
        onChangeQuickFilterColumns={(columns) =>
          quickFiltersRef.current?.onChangeQuickFilterColumns(columns)
        }
        columnModel={columnModel}
        columnSetModel={columnSetModel}
      />,
      "Columns",
    );
  };

  return (
    <div className={classBase}>
      <ColumnSetTabs columnSetModel={columnSetModel} scope={scope} />
      <span className={`${classBase}-spacer`} />
      <span
        aria-live="polite"
        className={cx(`${classBase}-count`, {
          [`${classBase}-countFiltered`]: filtered,
        })}
      >
        {filtered ? <FilterIcon /> : null}
        {formatRowCount(rowCount)}
      </span>
      <Button
        appearance="transparent"
        className={`${classBase}-columns`}
        onClick={showColumns}
      >
        <ColumnsIcon />
        Columns
      </Button>
    </div>
  );
};
