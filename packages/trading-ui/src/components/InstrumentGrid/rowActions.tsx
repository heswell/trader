import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type {
  ColumnDescriptor,
  TableCellRendererProps,
} from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import cx from "clsx";
import { createContext, type SyntheticEvent, useContext } from "react";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import { type InstrumentRow, toInstrument } from "./instrumentRow";
import actionsCss from "./rowActions.css";

const classBase = "tradingRowActions";

/** Name of the grid's client-side row actions column. */
export const ACTIONS_COLUMN = "actions";
const ACTIONS_RENDERER = "trading.instrument-actions";

/**
 * The row actions column: pinned right and narrow. Its buttons overflow to
 * the left, over the row's last cells, on hover and on the selected row.
 */
export const actionsColumnDescriptor: ColumnDescriptor = {
  name: ACTIONS_COLUMN,
  label: "",
  allowColumnHeaderMenu: false,
  minWidth: 8,
  pin: "right",
  resizeable: false,
  sortable: false,
  source: "client",
  width: 8,
  type: { name: "string", renderer: { name: ACTIONS_RENDERER } },
};

export type RowActionId = "buy" | "sell" | "depth";

export type RowActionHandlers = Partial<
  Record<RowActionId, (instrument: SelectedInstrument) => void>
>;

/** Label and key of each row action, in display order. */
export const ROW_ACTIONS: readonly {
  id: RowActionId;
  label: string;
  key: string;
}[] = [
  { id: "buy", label: "Buy", key: "B" },
  { id: "sell", label: "Sell", key: "S" },
  { id: "depth", label: "Depth", key: "D" },
];

/** The row action of a key (b / s / d, either case), if any. */
export const rowActionOfKey = (key: string): RowActionId | undefined =>
  ROW_ACTIONS.find((action) => action.key === key.toUpperCase())?.id;

const RowActionsContext = createContext<RowActionHandlers>({});
export const RowActionsProvider = RowActionsContext.Provider;

const stopPropagation = (e: SyntheticEvent) => e.stopPropagation();

/**
 * `trading.instrument-actions`: Buy, Sell and Depth for the row's
 * instrument, shown on hover, focus and on the selected row.
 */
export const RowActionsCell = ({ dataRow }: TableCellRendererProps) => {
  useComponentCssInjection({
    testId: "trading-instrument-row-actions",
    css: actionsCss,
    window: useWindow(),
  });
  const handlers = useContext(RowActionsContext);
  const row = dataRow as unknown as InstrumentRow;
  const actions = ROW_ACTIONS.filter(({ id }) => handlers[id]);
  if (row.isLeaf === false || row.ric == null || actions.length === 0) {
    return <div className={classBase} />;
  }
  const instrument = toInstrument(row);
  return (
    // Clicks on the buttons are not the table's (row selection).
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops propagation
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are B / S / D on the row
    <div
      className={classBase}
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
    >
      <div className={`${classBase}-buttons`}>
        {actions.map(({ id, label, key }) => (
          <button
            aria-label={`${label} ${instrument.ric}`}
            className={cx(`${classBase}-button`, `${classBase}-${id}`)}
            key={id}
            onClick={() => handlers[id]?.(instrument)}
            tabIndex={-1}
            title={`${label} (${key})`}
            type="button"
          >
            {label}
            <kbd aria-hidden className={`${classBase}-key`}>
              {key}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  );
};

let registered = false;

/** Register the row actions cell renderer with vuu (idempotent). */
export const registerRowActionsRenderer = () => {
  if (registered) return;
  registered = true;
  // a literal, for the docs coverage check (scripts/docs/api-reference.ts)
  registerComponent(
    "trading.instrument-actions",
    RowActionsCell,
    "cell-renderer",
    {
      description: "Buy, Sell and Depth for the row's instrument",
      label: "Instrument row actions",
      serverDataType: ["string"],
    },
  );
};
