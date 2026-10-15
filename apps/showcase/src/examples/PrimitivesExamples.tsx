import { ORD_STATUSES, OrdStatus } from "@heswell/trading-schemas";
import {
  FillProgressBar,
  OrderStatusBadge,
  PnlValue,
  registerInstrumentGridRenderers,
  Sparkline,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Text } from "@salt-ds/core";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import type { ReactNode } from "react";

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
    <Text style={{ width: 140 }}>{label}</Text>
    {children}
  </div>
);

/** The presentational building blocks, with static values. */
export const StatusPrimitivesExample = () => (
  <div
    style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}
  >
    <Row label="OrderStatusBadge">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {ORD_STATUSES.map((status) => (
          <OrderStatusBadge
            key={status}
            rejectReason={
              status === OrdStatus.Rejected ? "PRICE_OFF_TICK" : undefined
            }
            status={status}
            text={status === OrdStatus.Rejected ? "price 101.03" : undefined}
          />
        ))}
      </div>
    </Row>
    <Row label="FillProgressBar">
      <FillProgressBar filled={0} total={1000} style={{ width: 160 }} />
      <FillProgressBar filled={400} total={1000} style={{ width: 160 }} />
      <FillProgressBar filled={1000} total={1000} style={{ width: 160 }} />
      <FillProgressBar filled={0} muted total={1000} style={{ width: 160 }} />
    </Row>
    <Row label="PnlValue">
      <PnlValue currency="USD" value={1234.5} />
      <PnlValue currency="GBX" value={-87.25} />
      <PnlValue value={0} />
      <PnlValue hideArrow value={42} />
    </Row>
    <Row label="Sparkline">
      <Sparkline
        style={{ width: 120, height: 24 }}
        values={[1, 2, 1.5, 3, 4]}
      />
      <Sparkline
        style={{ width: 120, height: 24 }}
        values={[5, 4, 4.5, 3, 2]}
      />
      <Sparkline style={{ width: 120, height: 24 }} values={[2, 2, 2, 2]} />
    </Row>
  </div>
);

// Registered on import of @heswell/trading-ui; calling again is a no-op and
// documents that a plain vuu Table needs them.
registerInstrumentGridRenderers();

const right = { align: "right" } as const;

/** The trading cell renderers, used by name in a plain vuu Table config. */
const cellRenderersConfig: TableConfig = {
  columns: [
    { name: "ric", width: 90 },
    {
      name: "bid",
      ...right,
      type: { name: "number", renderer: { name: "trading.price-move" } },
    },
    {
      name: "last",
      ...right,
      type: {
        name: "number",
        renderer: {
          name: "trading.price-move",
          componentProps: { arrow: true },
        },
      },
    },
    {
      name: "change",
      ...right,
      type: { name: "number", renderer: { name: "trading.change" } },
    },
    {
      name: "changePct",
      ...right,
      type: {
        name: "number",
        renderer: { name: "trading.change", componentProps: { percent: true } },
      },
    },
    {
      name: "volume",
      ...right,
      type: {
        name: "number",
        renderer: {
          name: "trading.quantity",
          componentProps: { compact: true },
        },
      },
    },
    {
      name: "phase",
      width: 140,
      type: { name: "string", renderer: { name: "trading.phase" } },
    },
    {
      name: "sparkline",
      label: "trend",
      source: "client",
      sortable: false,
      width: 110,
      type: {
        name: "string",
        renderer: {
          name: "trading.sparkline",
          componentProps: { valueColumn: "last", length: 40 },
        },
      },
    },
    // formatting columns read by the price renderers (hidden)
    { name: "priceDecimals", hidden: true },
    { name: "tickSize", hidden: true },
    { name: "tickBands", hidden: true },
  ],
};

/** trading.price-move / change / quantity / phase / sparkline in a vuu Table. */
export const CellRenderersExample = () => {
  const dataSource = useTradingDataSource("instrumentPrices", {
    columns: [
      "ric",
      "bid",
      "last",
      "change",
      "changePct",
      "volume",
      "phase",
      "priceDecimals",
      "tickSize",
      "tickBands",
    ],
    filterSpec: { filter: "simulated = true" },
  });
  return (
    <div style={{ height: "100%", minHeight: 0, padding: 16 }}>
      <Table
        config={cellRenderersConfig}
        dataSource={dataSource}
        height="100%"
        renderBufferSize={10}
      />
    </div>
  );
};
