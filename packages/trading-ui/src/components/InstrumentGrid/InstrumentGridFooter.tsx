import { Button } from "@salt-ds/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  type ColumnModel,
  type ColumnSetModel,
  getColumnSetNameError,
  useColumnSetsState,
  useTableColumnPicker,
} from "@vuu-ui/vuu-table-extras";
import { useContextPanel, useHideContextPanel } from "@vuu-ui/vuu-ui-controls";
import cx from "clsx";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { NamePrompt } from "../NamePrompt";
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

const ColumnSetTabs = ({
  columnSetModel,
}: {
  columnSetModel: ColumnSetModel;
}) => {
  const { activeColumnSet, columnSets } = useColumnSetsState(columnSetModel);
  const [naming, setNaming] = useState(false);

  // Arrow keys move between tabs and show that set, like a tablist.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const index = tabs.indexOf(e.target as HTMLButtonElement);
    if (index === -1) return;
    e.preventDefault();
    const next =
      tabs[
        (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
      ];
    next.focus();
    columnSetModel.setActiveColumnSet(next.value);
  };

  return (
    <div className={`${classBase}-columnSets`}>
      {columnSets.length ? (
        <div
          aria-label="Column sets"
          className={`${classBase}-tabs`}
          onKeyDown={handleKeyDown}
          role="tablist"
        >
          {columnSets.map(({ name }, index) => {
            const selected = name === activeColumnSet;
            return (
              <button
                aria-selected={selected}
                className={cx(`${classBase}-tab`, {
                  [`${classBase}-tabSelected`]: selected,
                })}
                key={name}
                onClick={() => columnSetModel.setActiveColumnSet(name)}
                role="tab"
                tabIndex={
                  selected || (!activeColumnSet && name === columnSets[0].name)
                    ? 0
                    : -1
                }
                title={index < 9 ? `${name} (Alt+${index + 1})` : name}
                type="button"
                value={name}
              >
                {name}
              </button>
            );
          })}
        </div>
      ) : null}
      <button
        aria-label="New column set"
        className={`${classBase}-newSet`}
        onClick={() => setNaming(true)}
        title="Save the columns in view as a new column set"
        type="button"
      >
        +
      </button>
      {naming ? (
        <NamePrompt
          onClose={() => setNaming(false)}
          onConfirm={(name) => columnSetModel.saveAs(name)}
          placeholder="e.g. Screening"
          title="New column set"
          validate={(name) =>
            getColumnSetNameError(name, columnSetModel.columnSets)
          }
        />
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
      <ColumnSetTabs columnSetModel={columnSetModel} />
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
