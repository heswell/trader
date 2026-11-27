import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import type { FunctionComponent } from "react";
import { formatTime } from "../../utils/time";
import { LimitStateBadge } from "./LimitStateBadge";
import { UtilisationBar } from "./UtilisationBar";
import { limitLabel } from "./limitFormat";

/** Cell renderers of the limit tables (registered by registerLimitRenderers). */
export const LimitRenderer = Object.freeze({
  /**
   * The column is utilisation (used / soft); needs warning, soft and hard
   * for the ticks, and state for the colour.
   */
  Utilisation: "trading.limit-utilisation",
  /** A LimitState column as a badge. */
  State: "trading.limit-state",
  /** The column is metric; adds ric (a carve-out) when set. */
  Metric: "trading.limit-metric",
  /** HH:mm:ss of an epoch time, blank for 0. */
  Time: "trading.limit-time",
} as const);

const num = (value: unknown) => (typeof value === "number" ? value : 0);
const text = (value: unknown) => (typeof value === "string" ? value : "");

const UtilisationCell = ({ column, dataRow }: TableCellRendererProps) => {
  const soft = num(dataRow.soft);
  return (
    <UtilisationBar
      hardPct={soft > 0 ? num(dataRow.hard) / soft : 0}
      state={text(dataRow.state)}
      utilisation={num(dataRow[column.name])}
      warningPct={soft > 0 ? num(dataRow.warning) / soft : 0}
    />
  );
};

const StateCell = ({ column, dataRow }: TableCellRendererProps) => (
  <LimitStateBadge state={text(dataRow[column.name])} />
);

const MetricCell = ({ column, dataRow }: TableCellRendererProps) => (
  <span>{limitLabel(dataRow[column.name], dataRow.ric)}</span>
);

const TimeCell = ({ column, dataRow }: TableCellRendererProps) => {
  const value = num(dataRow[column.name]);
  return (
    <span>{value > 0 ? formatTime(value, { milliseconds: false }) : ""}</span>
  );
};

let registered = false;

/**
 * Registers the LimitRenderer cell renderers with vuu (once). LimitMonitor
 * and LimitBreaches call it; call it yourself to use the renderers in
 * another table.
 */
export const registerLimitRenderers = () => {
  if (registered) return;
  registered = true;
  const register = (
    name: string,
    Cell: FunctionComponent<TableCellRendererProps>,
  ) => registerComponent(name, Cell, "cell-renderer", { userCanAssign: false });
  register(LimitRenderer.Utilisation, UtilisationCell);
  register(LimitRenderer.State, StateCell);
  register(LimitRenderer.Metric, MetricCell);
  register(LimitRenderer.Time, TimeCell);
};

/** A column type using one of the LimitRenderer renderers. */
export const limitRenderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});
