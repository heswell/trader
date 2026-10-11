import { TradingPhase } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type {
  DataRow,
  RuntimeColumnDescriptor,
  TableCellRendererProps,
} from "@vuu-ui/vuu-table-types";
import {
  getMovingValueDirection,
  isTypeDescriptor,
  isValidNumber,
  registerComponent,
  type valueChangeDirection,
} from "@vuu-ui/vuu-utils";
import cx from "clsx";
import { memo, useEffect, useRef } from "react";
import {
  formatPercent,
  formatPrice,
  formatQuantity,
  type PriceFormat,
} from "../../utils/formatting";
import { registerSparklineRenderer } from "../Sparkline/Sparkline";
import cellCss from "./InstrumentGridCells.css";

const classBase = "tradingInstrumentCell";

const CHAR_ARROW_UP = "\u25B2";
const CHAR_ARROW_DOWN = "\u25BC";

/** Per-instrument price precision, from the static columns of the row (if subscribed). */
export const priceFormatOf = (dataRow: DataRow): PriceFormat => {
  const format: PriceFormat = {};
  const read = (name: string) =>
    dataRow.hasColumn(name) ? dataRow[name] : undefined;
  const decimals = read("priceDecimals");
  if (typeof decimals === "number") format.priceDecimals = decimals;
  const tickSize = read("tickSize");
  if (typeof tickSize === "number") format.tickSize = tickSize;
  const tickBands = read("tickBands");
  if (typeof tickBands === "string" && tickBands) format.tickBands = tickBands;
  return format;
};

const rendererProps = (column: RuntimeColumnDescriptor) => {
  const renderer = isTypeDescriptor(column.type)
    ? column.type.renderer
    : undefined;
  return renderer && "componentProps" in renderer
    ? (renderer.componentProps ?? {})
    : {};
};

const useCellCss = () => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-instrument-grid-cells",
    css: cellCss,
    window: targetWindow,
  });
};

const FORMAT_COLUMNS = ["priceDecimals", "tickSize", "tickBands", "currency"];

/**
 * memo comparator: re-render only when this cell's own value, its row (cells
 * are recycled between rows) or the row's formatting columns change.
 */
export const cellUnchanged = (
  prev: TableCellRendererProps,
  next: TableCellRendererProps,
) => {
  if (prev.column !== next.column || prev.dataRow.key !== next.dataRow.key) {
    return false;
  }
  const { name } = next.column;
  if (prev.dataRow[name] !== next.dataRow[name]) return false;
  if (prev.dataRow.isLeaf !== next.dataRow.isLeaf) return false;
  return FORMAT_COLUMNS.every(
    (column) =>
      !next.dataRow.hasColumn(column) ||
      prev.dataRow[column] === next.dataRow[column],
  );
};

/** vuu delivers `long` values as strings in some configurations. */
const numeric = (value: unknown) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  !Number.isNaN(Number(value))
    ? Number(value)
    : value;

const cellValue = (dataRow: DataRow, column: RuntimeColumnDescriptor) =>
  dataRow.hasColumn(column.name) ? numeric(dataRow[column.name]) : undefined;

/** Group rows carry aggregates only for some columns. */
const isGroupRow = (dataRow: DataRow) => dataRow.isLeaf === false;

// ----------------------------------------------------------------- price

/**
 * Flash direction for a value that ticks. Reuses vuu's alternating
 * up1/up2/down1/down2 classes so consecutive moves in the same direction
 * restart the CSS animation.
 */
const useMoveDirection = (
  key: string,
  value: unknown,
  column: RuntimeColumnDescriptor,
): valueChangeDirection => {
  const ref = useRef<[string, unknown, valueChangeDirection]>([
    "",
    undefined,
    "",
  ]);
  const [prevKey, prevValue, prevDirection] = ref.current;
  const direction =
    key === prevKey && isValidNumber(value) && isValidNumber(prevValue)
      ? getMovingValueDirection(value, prevDirection, prevValue, undefined)
      : "";
  useEffect(() => {
    ref.current = [key, value, direction];
  });
  void column;
  return direction;
};

/**
 * `trading.price-move`: a price formatted to the instrument's precision that
 * flashes green / red on an up / down tick. The tick direction is also shown
 * as an arrow (`componentProps.arrow`, default on for `last`), so the move is
 * not conveyed by colour alone.
 */
export const PriceMoveCell = memo(function PriceMoveCell({
  column,
  dataRow,
}: TableCellRendererProps) {
  useCellCss();
  const value = cellValue(dataRow, column);
  const direction = useMoveDirection(dataRow.key, value, column);
  const group = isGroupRow(dataRow);
  const arrow = rendererProps(column).arrow === true;
  const up = direction === "up1" || direction === "up2";
  const down = direction === "down1" || direction === "down2";
  return (
    <div
      className={cx(classBase, `${classBase}-price`, direction)}
      data-direction={up ? "up" : down ? "down" : undefined}
    >
      <span aria-hidden className={`${classBase}-arrow`}>
        {arrow && up ? CHAR_ARROW_UP : arrow && down ? CHAR_ARROW_DOWN : ""}
      </span>
      <span className={`${classBase}-value`}>
        {group ? "" : formatPrice(value, priceFormatOf(dataRow))}
      </span>
    </div>
  );
}, cellUnchanged);

// ------------------------------------------------------------ change

/**
 * `trading.change`: signed change with an arrow and colour. The sign and arrow
 * carry the direction; colour reinforces it. `componentProps.percent = true`
 * renders `changePct` as +1.25%.
 */
export const ChangeCell = memo(function ChangeCell({
  column,
  dataRow,
}: TableCellRendererProps) {
  useCellCss();
  const value = cellValue(dataRow, column);
  const percent = rendererProps(column).percent === true;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <div className={cx(classBase, `${classBase}-change`)} />;
  }
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const text = percent
    ? formatPercent(value)
    : `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatPrice(
        Math.abs(value),
        priceFormatOf(dataRow),
      )}`;
  return (
    <div
      className={cx(classBase, `${classBase}-change`)}
      data-direction={direction}
    >
      <span aria-hidden className={`${classBase}-arrow`}>
        {direction === "up"
          ? CHAR_ARROW_UP
          : direction === "down"
            ? CHAR_ARROW_DOWN
            : "\u2013"}
      </span>
      <span className={`${classBase}-value`}>{text}</span>
    </div>
  );
}, cellUnchanged);

// ------------------------------------------------ quantity / notional

/** `trading.quantity`: whole-unit volume; `componentProps.compact` -> 1.2M. */
export const QuantityCell = memo(function QuantityCell({
  column,
  dataRow,
}: TableCellRendererProps) {
  useCellCss();
  const compact = rendererProps(column).compact === true;
  const value = cellValue(dataRow, column);
  return (
    <div
      className={cx(classBase, `${classBase}-quantity`)}
      title={formatQuantity(value)}
    >
      <span className={`${classBase}-value`}>
        {formatQuantity(value, { compact })}
      </span>
    </div>
  );
}, cellUnchanged);

// ------------------------------------------------------------- phase

const PHASE_LABELS: Record<string, string> = {
  [TradingPhase.Closed]: "Closed",
  [TradingPhase.PreOpen]: "Pre-open",
  [TradingPhase.OpeningAuction]: "Opening auction",
  [TradingPhase.Continuous]: "Open",
  [TradingPhase.ClosingAuction]: "Closing auction",
  [TradingPhase.PostClose]: "Post-close",
  [TradingPhase.Halted]: "Halted",
};

export const phaseLabel = (phase: unknown) =>
  typeof phase === "string" && phase ? (PHASE_LABELS[phase] ?? phase) : "";

/**
 * `trading.phase`: the trading phase as a labelled badge (a dot, text and
 * `data-phase`), so CLOSED and HALTED are visible without relying on colour.
 */
export const PhaseCell = memo(function PhaseCell({
  column,
  dataRow,
}: TableCellRendererProps) {
  useCellCss();
  const phase = cellValue(dataRow, column);
  if (isGroupRow(dataRow) || typeof phase !== "string" || !phase) {
    return <div className={cx(classBase, `${classBase}-phase`)} />;
  }
  return (
    <div className={cx(classBase, `${classBase}-phase`)} data-phase={phase}>
      <span aria-hidden className={`${classBase}-phaseDot`} />
      <span className={`${classBase}-phaseLabel`}>{phaseLabel(phase)}</span>
    </div>
  );
}, cellUnchanged);

// ------------------------------------------------------ registration

let registered = false;

/** Register the instrument grid cell renderers with vuu (idempotent). */
export const registerInstrumentGridRenderers = () => {
  registerSparklineRenderer();
  if (registered) return;
  registered = true;
  const options = (label: string, description: string) => ({
    description,
    label,
    serverDataType: ["long", "int", "double", "string"] as const,
  });
  registerComponent("trading.price-move", PriceMoveCell, "cell-renderer", {
    ...options(
      "Price move",
      "Price to instrument precision, flashing on up / down ticks",
    ),
    serverDataType: ["double"],
  });
  registerComponent("trading.change", ChangeCell, "cell-renderer", {
    ...options("Change", "Signed change with arrow and colour"),
    serverDataType: ["double"],
  });
  registerComponent("trading.quantity", QuantityCell, "cell-renderer", {
    ...options("Quantity", "Grouped / compact quantity"),
    serverDataType: ["long", "int"],
  });
  registerComponent("trading.phase", PhaseCell, "cell-renderer", {
    ...options("Trading phase", "Trading phase badge"),
    serverDataType: ["string"],
  });
};
