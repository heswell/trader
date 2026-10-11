import { OrdType, Side, TimeInForce } from "@heswell/trading-schemas";
import {
  formatPrice,
  SideLabel,
  sendTradingRpc,
  TradingRpcError,
  useSelectedInstrument,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button, FlexLayout, Text } from "@salt-ds/core";
import { Table } from "@vuu-ui/vuu-table";
import type {
  ColumnTypeDescriptorCustomRenderer,
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import { useCallback, useState } from "react";

const priceMove = (
  flashStyle: "bg-only" | "arrow-bg",
): ColumnTypeDescriptorCustomRenderer => ({
  name: "number",
  formatting: { decimals: 2, zeroPad: true },
  renderer: { name: "vuu.price-move-background", flashStyle },
});

const pricesConfig: TableConfig = {
  columns: [
    { name: "ric", width: 100 },
    { name: "description", width: 180 },
    { name: "currency", width: 70 },
    { name: "bid", type: priceMove("bg-only") },
    { name: "ask", type: priceMove("bg-only") },
    { name: "last", type: priceMove("arrow-bg") },
    {
      name: "changePct",
      type: { name: "number", formatting: { decimals: 2 } },
    },
    { name: "volume" },
    { name: "phase", width: 100 },
  ],
};

const ordersConfig: TableConfig = {
  columns: [
    { name: "orderId", width: 120 },
    { name: "account", width: 100 },
    { name: "ric", width: 90 },
    { name: "side", width: 60 },
    { name: "ordType", width: 80 },
    { name: "quantity" },
    { name: "cumQty" },
    { name: "leavesQty" },
    { name: "avgPx", type: { name: "number", formatting: { decimals: 4 } } },
    { name: "status", width: 120 },
  ],
};

const ACCOUNT = "ACC-US-01";

/**
 * Proves the stack: a ticking instrumentPrices grid (vuu.price-move-background)
 * and a createOrder round trip whose parentOrders row is shown below.
 * Selecting a row publishes it to the instrument context.
 */
export const InstrumentPricesTicking = () => {
  // only instruments the exchange simulator is quoting
  const prices = useTradingDataSource("instrumentPrices", {
    filterSpec: { filter: "simulated = true" },
  });
  const orders = useTradingDataSource("parentOrders", {
    // nothing until the first order is created
    filterSpec: { filter: 'orderId = "-"' },
  });
  const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument();
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [message, setMessage] = useState("Select an instrument");
  const [price, setPrice] = useState<number>();

  const handleSelect = useCallback<TableRowSelectHandler>(
    (row) => {
      if (row) {
        setSelectedInstrument(
          {
            ric: String(row.ric),
            description: String(row.description),
            currency: String(row.currency),
            exchange: String(row.exchange),
            tickSize: Number(row.tickSize),
            tickBands: String(row.tickBands ?? ""),
            lotSize: Number(row.lotSize),
            priceDecimals: Number(row.priceDecimals),
          },
          "showcase-prices",
        );
        setPrice(Number(row.last));
      } else {
        setSelectedInstrument(undefined, "showcase-prices");
      }
    },
    [setSelectedInstrument],
  );

  const placeOrder = async (side: Side) => {
    if (!selectedInstrument) return;
    try {
      const { orderId, status } = await sendTradingRpc(orders, "createOrder", {
        account: ACCOUNT,
        ric: selectedInstrument.ric,
        side,
        ordType: OrdType.Market,
        quantity: 100,
        timeInForce: TimeInForce.Day,
      });
      const ids = [...orderIds, orderId];
      setOrderIds(ids);
      orders.filter = {
        filter: `orderId in [${ids.map((id) => `"${id}"`).join(",")}]`,
      };
      setMessage(`${orderId} ${status}`);
    } catch (err) {
      setMessage(
        err instanceof TradingRpcError
          ? `${err.reason}: ${err.text}`
          : String(err),
      );
    }
  };

  const ric = selectedInstrument?.ric;
  return (
    <FlexLayout direction="column" gap={1} style={{ height: "100%" }}>
      <div style={{ flex: "1 1 60%", minHeight: 0 }}>
        <Table
          config={pricesConfig}
          dataSource={prices}
          onSelect={handleSelect}
          selectionModel="single"
        />
      </div>
      <FlexLayout align="center" gap={1}>
        <Button
          appearance="solid"
          sentiment="positive"
          disabled={!ric}
          onClick={() => placeOrder(Side.Buy)}
        >
          Buy 100 {ric}
        </Button>
        <Button
          appearance="solid"
          sentiment="negative"
          disabled={!ric}
          onClick={() => placeOrder(Side.Sell)}
        >
          Sell 100 {ric}
        </Button>
        {selectedInstrument && price !== undefined ? (
          <Text>
            <SideLabel side={Side.Buy} /> / <SideLabel side={Side.Sell} />{" "}
            {ACCOUNT} @ market (last {formatPrice(price, selectedInstrument)})
          </Text>
        ) : null}
        <Text role="status" aria-live="polite">
          {message}
        </Text>
      </FlexLayout>
      <div style={{ flex: "1 1 40%", minHeight: 0 }}>
        <Table config={ordersConfig} dataSource={orders} />
      </div>
    </FlexLayout>
  );
};
