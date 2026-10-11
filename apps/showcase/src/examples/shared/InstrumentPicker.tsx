import {
  type TradingRpcError,
  sendTradingRpc,
  useSelectedInstrument,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button, FlexLayout, Text } from "@salt-ds/core";
import { Table } from "@vuu-ui/vuu-table";
import type {
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import { useCallback, useState } from "react";

const config: TableConfig = {
  columns: [
    { name: "ric", width: 90 },
    { name: "currency", width: 60 },
    {
      name: "bid",
      type: { name: "number", formatting: { decimals: 2, zeroPad: true } },
    },
    {
      name: "ask",
      type: { name: "number", formatting: { decimals: 2, zeroPad: true } },
    },
    {
      name: "last",
      type: { name: "number", formatting: { decimals: 2, zeroPad: true } },
    },
    { name: "phase", width: 100 },
  ],
};

export interface InstrumentPickerProps {
  /** Source id passed to setSelectedInstrument. */
  source: string;
  /** Show halt / resume admin buttons for the selected instrument. */
  showAdmin?: boolean;
}

/**
 * Showcase helper: a small grid of simulated instruments that publishes the
 * selected row to the instrument context (the components under test follow
 * it), optionally with exchange admin halt / resume buttons.
 */
export const InstrumentPicker = ({
  source,
  showAdmin = false,
}: InstrumentPickerProps) => {
  const prices = useTradingDataSource("instrumentPrices", {
    filterSpec: { filter: "simulated = true" },
  });
  const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument();
  const [message, setMessage] = useState("");
  const handleSelect = useCallback<TableRowSelectHandler>(
    (row) => {
      setSelectedInstrument(
        row
          ? {
              ric: String(row.ric),
              description: String(row.description),
              currency: String(row.currency),
              exchange: String(row.exchange),
              tickSize: Number(row.tickSize),
              tickBands: String(row.tickBands ?? ""),
              lotSize: Number(row.lotSize),
              priceDecimals: Number(row.priceDecimals),
            }
          : undefined,
        source,
      );
    },
    [setSelectedInstrument, source],
  );
  const admin = async (rpc: "haltInstrument" | "resumeInstrument") => {
    if (!selectedInstrument) return;
    try {
      await sendTradingRpc(prices, rpc, { ric: selectedInstrument.ric });
      setMessage(`${rpc} ${selectedInstrument.ric}`);
    } catch (err) {
      const e = err as TradingRpcError;
      setMessage(`${e.reason ?? "ERROR"}: ${e.text ?? String(err)}`);
    }
  };
  return (
    <FlexLayout direction="column" gap={1} style={{ height: "100%" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Table
          config={config}
          dataSource={prices}
          onSelect={handleSelect}
          selectionModel="single"
        />
      </div>
      {showAdmin ? (
        <FlexLayout align="center" gap={1}>
          <Button
            disabled={!selectedInstrument}
            onClick={() => admin("haltInstrument")}
          >
            Halt
          </Button>
          <Button
            disabled={!selectedInstrument}
            onClick={() => admin("resumeInstrument")}
          >
            Resume
          </Button>
          <Text>{message}</Text>
        </FlexLayout>
      ) : null}
    </FlexLayout>
  );
};
