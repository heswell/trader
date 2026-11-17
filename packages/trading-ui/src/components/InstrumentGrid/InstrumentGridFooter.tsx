import { Button } from "@salt-ds/core";
import { useWindow } from "@salt-ds/window";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  type ColumnModel,
  type ColumnSetModel,
  getColumnSetNameError,
  useColumnSetsState,
  useTableColumnPicker,
} from "@vuu-ui/vuu-table-extras";
import cx from "clsx";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useState,
} from "react";
import type { GridChannelLinks } from "./linkColumn";

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
  const targetWindow = useWindow();
  const { activeColumnSet, columnSets } = useColumnSetsState(columnSetModel);

  const newColumnSet = () => {
    const name = targetWindow?.prompt("Name the new column set")?.trim();
    if (!name) return;
    const error = getColumnSetNameError(name, columnSetModel.columnSets);
    if (error) {
      targetWindow?.alert(error);
      return;
    }
    columnSetModel.saveAs(name);
  };

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
          {columnSets.map(({ name }) => {
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
        onClick={newColumnSet}
        title="Save the columns in view as a new column set"
        type="button"
      >
        +
      </button>
    </div>
  );
};

export interface InstrumentGridFooterProps {
  columnModel: ColumnModel;
  columnSetModel: ColumnSetModel;
  dataSource: DataSource;
  /** A user filter applies: the count is bold, with a filter icon. */
  filtered: boolean;
  links: GridChannelLinks;
  /**
   * Go to the row of a linked instrument. Undefined when the grid cannot
   * (linked rows not pinned): the instruments are then shown, not buttons.
   */
  onShowLinked?: (ric: string) => void;
}

/**
 * The grid's footer: column-set tabs, the instruments on a channel, the
 * row count and the column picker.
 */
export const InstrumentGridFooter = ({
  columnModel,
  columnSetModel,
  dataSource,
  filtered,
  links,
  onShowLinked,
}: InstrumentGridFooterProps) => {
  const rowCount = useRowCount(dataSource);
  const { showColumnPicker } = useTableColumnPicker({
    columnModel,
    columnSetModel,
  });
  const linked = links.channels.flatMap((channel) => {
    const instrument = links.instrumentOf(channel.id);
    return instrument ? [{ channel, ric: instrument.ric }] : [];
  });

  return (
    <div className={classBase}>
      <ColumnSetTabs columnSetModel={columnSetModel} />
      <span className={`${classBase}-spacer`} />
      {linked.length ? (
        <span className={`${classBase}-linked`}>
          <span className={`${classBase}-label`}>Linked</span>
          {linked.map(({ channel, ric }) => {
            const content = (
              <>
                <span aria-hidden className={`${classBase}-dot`} />
                {ric}
              </>
            );
            const style = { "--channel-color": channel.color } as CSSProperties;
            const title = `${ric} is on the ${channel.label} channel`;
            return onShowLinked ? (
              <button
                aria-label={`${title}: go to its row`}
                className={`${classBase}-linkedItem`}
                key={channel.id}
                onClick={() => onShowLinked(ric)}
                style={style}
                title={title}
                type="button"
              >
                {content}
              </button>
            ) : (
              <span
                className={`${classBase}-linkedItem`}
                key={channel.id}
                style={style}
                title={title}
              >
                {content}
              </span>
            );
          })}
        </span>
      ) : null}
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
        onClick={() => showColumnPicker()}
      >
        <ColumnsIcon />
        Columns
      </Button>
    </div>
  );
};
