import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { renderer, simGridClass } from "../SimulatorGrids/useSimGridSetup";
import { useControlsCss } from "./useControlsCss";

registerTradingCellRenderers();

const COLUMNS = [
  "id",
  "seq",
  "time",
  "user",
  "action",
  "target",
  "details",
  "runId",
];

const tableConfig: TableConfig = {
  columnDefaultWidth: 110,
  rowSeparators: true,
  columns: [
    { name: "time", width: 110, type: renderer(TradingRenderer.Time) },
    { name: "user", width: 90 },
    { name: "action", width: 140 },
    { name: "target", width: 140 },
    { name: "details", width: 320 },
    { name: "runId", label: "Run", width: 70 },
    { name: "seq", hidden: true },
    { name: "id", hidden: true },
  ],
};

export type SimEventsLogProps = HTMLAttributes<HTMLDivElement>;

/**
 * Audit log of simulator control actions (`simEvents`, sim-admin only),
 * newest first: who changed what, from an admin RPC or a scenario run.
 */
export const SimEventsLog = forwardRef<HTMLDivElement, SimEventsLogProps>(
  function SimEventsLog({ className, ...htmlAttributes }, ref) {
    useControlsCss();
    const dataSource = useTradingDataSource("simEvents", {
      columns: COLUMNS,
      sort: { sortDefs: [{ column: "seq", sortType: "D" }] },
    });
    return (
      <div
        {...htmlAttributes}
        className={cx(simGridClass, className)}
        data-testid="trading-sim-events-log"
        ref={ref}
      >
        <div className={`${simGridClass}-table`}>
          <Table
            config={tableConfig}
            dataSource={dataSource}
            selectionModel="none"
          />
        </div>
      </div>
    );
  },
);
