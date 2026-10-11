import {
  InstrumentGrid,
  InstrumentPicker,
  sendTradingRpc,
  type TradingRpcError,
  useDataSourceRows,
  useSelectedInstrument,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button, FlexLayout, Text } from "@salt-ds/core";
import { useState } from "react";

const GRID_COLUMNS = ["ric", "currency", "bid", "ask", "last", "phase"];

/**
 * Showcase helper: the trading-ui InstrumentPicker and a compact
 * InstrumentGrid of simulated instruments, both publishing to the (default)
 * link group the components under test follow, plus exchange admin
 * halt / resume for the selected instrument.
 */
export const InstrumentSelector = ({
  showAdmin = false,
}: {
  showAdmin?: boolean;
}) => {
  const prices = useTradingDataSource("instrumentPrices");
  // RPCs go to the server through a subscribed viewport
  useDataSourceRows(prices, { rowCount: 1, enabled: showAdmin });
  const { selectedInstrument } = useSelectedInstrument();
  const [message, setMessage] = useState("");
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
      <InstrumentPicker aria-label="Instrument" placeholder="Search ric" />
      <div style={{ flex: 1, minHeight: 0 }}>
        <InstrumentGrid
          columns={GRID_COLUMNS}
          simulatedOnly
          showToolbar={false}
          sparkline={false}
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
