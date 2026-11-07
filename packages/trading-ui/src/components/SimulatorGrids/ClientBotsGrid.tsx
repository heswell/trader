import { CLIENT_PERSONAS, RpcName } from "@heswell/trading-schemas";
import { Button } from "@salt-ds/core";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useState } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useSimRpc } from "../SimulatorControls/useSimRpc";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { renderer, simGridClass, useSimGridSetup } from "./useSimGridSetup";

registerTradingCellRenderers();

const COLUMNS = [
  "botId",
  "persona",
  "account",
  "paused",
  "sideMode",
  "ordersPerMin",
  "live",
  "submitted",
  "rejected",
  "completed",
  "filledQty",
  "filledUsd",
  "slippageBps",
  "lastOrderId",
  "lastReject",
  "updated",
];

const right = { align: "right" as const };

const tableConfig: TableConfig = {
  columnDefaultWidth: 80,
  rowSeparators: true,
  columns: [
    { name: "botId", label: "Bot", width: 70 },
    { name: "persona", width: 100 },
    { name: "account", width: 100 },
    { name: "sideMode", label: "Side mode", width: 120 },
    { name: "ordersPerMin", label: "Orders /min", ...right, width: 90 },
    { name: "live", ...right, width: 60 },
    { name: "submitted", label: "Sent", ...right, width: 70 },
    { name: "rejected", ...right, width: 80 },
    { name: "completed", label: "Done", ...right, width: 70 },
    { name: "filledQty", label: "Filled", ...right, width: 100 },
    {
      name: "filledUsd",
      label: "Filled $",
      ...right,
      width: 120,
      type: renderer(TradingRenderer.Notional),
    },
    { name: "slippageBps", label: "Slippage bps", ...right, width: 100 },
    { name: "paused", width: 70 },
    { name: "lastOrderId", label: "Last order", width: 90 },
    { name: "lastReject", label: "Last reject", width: 200 },
    { name: "updated", width: 110, type: renderer(TradingRenderer.Time) },
  ],
};

export interface ClientBotsGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Called with the selected client bot's id (undefined when cleared). */
  onBotSelect?: (botId: string | undefined) => void;
  /** Hide the add-a-bot toolbar. */
  hideToolbar?: boolean;
}

/**
 * The OMS client bots from `clientBots` (sim-admin only): simulated clients
 * sending TWAP / VWAP / POV parent orders, with their working parents,
 * fills and average slippage against arrival. The toolbar adds a bot of a
 * starter persona.
 */
export const ClientBotsGrid = forwardRef<HTMLDivElement, ClientBotsGridProps>(
  function ClientBotsGrid(
    { className, hideToolbar = false, onBotSelect, ...htmlAttributes },
    ref,
  ) {
    const { staleProps } = useStaleData();
    const { handleSelect } = useSimGridSetup(
      "ClientBotsGrid",
      {},
      htmlAttributes.id,
      (row) =>
        onBotSelect?.(typeof row?.botId === "string" ? row.botId : undefined),
    );
    const dataSource = useTradingDataSource("clientBots", {
      columns: COLUMNS,
      sort: { sortDefs: [{ column: "botId", sortType: "A" }] },
    });
    const { send, message, pending } = useSimRpc(dataSource);
    const [persona, setPersona] = useState<string>(CLIENT_PERSONAS[0]);

    return (
      <div
        {...htmlAttributes}
        {...staleProps}
        className={cx(simGridClass, className, staleProps.className)}
        data-testid="trading-client-bots-grid"
        ref={ref}
      >
        {hideToolbar ? null : (
          <div className={`${simGridClass}-toolbar`}>
            <label>
              Persona{" "}
              <select
                onChange={(e) => setPersona(e.target.value)}
                value={persona}
              >
                {CLIENT_PERSONAS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={pending}
              onClick={() =>
                send(
                  RpcName.AddClientBot,
                  { persona: persona as (typeof CLIENT_PERSONAS)[number] },
                  ({ botId, account }) => `${botId} added on ${account}`,
                )
              }
              sentiment="neutral"
            >
              Add client bot
            </Button>
            {message ? (
              <output data-error={message.error}>{message.text}</output>
            ) : null}
          </div>
        )}
        <div className={`${simGridClass}-table`}>
          <Table
            config={tableConfig}
            dataSource={dataSource}
            onSelect={handleSelect}
            selectionModel="single"
          />
        </div>
      </div>
    );
  },
);
