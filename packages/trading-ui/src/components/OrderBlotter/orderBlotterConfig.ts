import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { TradingRenderer } from "../TradingCellRenderers";
import { DONE_STATUSES, WORKING_STATUSES } from "../../utils/orderStatus";
import { OrdStatus } from "@heswell/trading-schemas";

export type OrderBlotterTab = "working" | "filled" | "closed" | "all";

export const ORDER_BLOTTER_TABS: readonly {
  id: OrderBlotterTab;
  label: string;
}[] = [
  { id: "working", label: "Working" },
  { id: "filled", label: "Filled" },
  { id: "closed", label: "Cancelled / Rejected" },
  { id: "all", label: "All" },
];

const inList = (statuses: readonly string[]) =>
  `status in [${statuses.map((s) => `"${s}"`).join(", ")}]`;

/** Client filterSpec for each tab. `all` is an empty filter. */
export const orderBlotterTabFilter = (tab: OrderBlotterTab) => {
  switch (tab) {
    case "working":
      return inList(WORKING_STATUSES);
    case "filled":
      return inList([OrdStatus.Filled]);
    case "closed":
      return inList(DONE_STATUSES);
    default:
      return "";
  }
};

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

export const ORDER_BLOTTER_COLUMNS = [
  "orderId",
  "status",
  "side",
  "ric",
  "ordType",
  "timeInForce",
  "quantity",
  "price",
  "cumQty",
  "avgPx",
  "account",
  "trader",
  "created",
  "lastUpdate",
  "currency",
  "rejectReason",
  "text",
] as const;

export const orderBlotterTableConfig: TableConfig = {
  columnDefaultWidth: 90,
  columnSeparators: false,
  rowSeparators: true,
  columns: [
    {
      name: "orderId",
      label: "Order",
      width: 210,
      type: renderer("trading.order-actions"),
    },
    {
      name: "status",
      width: 140,
      type: renderer(TradingRenderer.OrderStatus),
    },
    { name: "side", width: 60, type: renderer(TradingRenderer.Side) },
    { name: "ric", width: 90 },
    { name: "ordType", label: "Type", width: 80 },
    { name: "timeInForce", label: "TIF", width: 55 },
    { name: "quantity", label: "Qty", width: 90, align: "right" },
    {
      name: "price",
      width: 90,
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "cumQty",
      label: "Filled",
      width: 130,
      type: renderer(TradingRenderer.FillProgress),
    },
    {
      name: "avgPx",
      label: "Avg px",
      width: 90,
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    { name: "account", width: 100 },
    { name: "trader", width: 70 },
    {
      name: "created",
      label: "Created",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    {
      name: "lastUpdate",
      label: "Updated",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    { name: "currency", hidden: true },
    { name: "rejectReason", hidden: true },
    { name: "text", hidden: true },
  ],
};

export const childOrdersTableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    { name: "childOrderId", label: "Child", width: 130 },
    { name: "status", width: 140, type: renderer(TradingRenderer.OrderStatus) },
    { name: "side", width: 60, type: renderer(TradingRenderer.Side) },
    { name: "ric", width: 90 },
    { name: "quantity", label: "Qty", align: "right" },
    {
      name: "price",
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "cumQty",
      label: "Filled",
      width: 130,
      type: renderer(TradingRenderer.FillProgress),
    },
    {
      name: "avgPx",
      label: "Avg px",
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "lastUpdate",
      label: "Updated",
      width: 110,
      type: renderer(TradingRenderer.Time),
    },
    { name: "exchangeOrderId", label: "Exchange id", width: 130 },
    { name: "rejectReason", hidden: true },
    { name: "text", hidden: true },
  ],
};

export const CHILD_ORDER_COLUMNS = [
  "childOrderId",
  "parentOrderId",
  "exchangeOrderId",
  "ric",
  "side",
  "price",
  "quantity",
  "status",
  "cumQty",
  "avgPx",
  "lastUpdate",
  "rejectReason",
  "text",
] as const;
