import type {
  ExecType,
  Liquidity,
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import type { InstrumentDef } from "../reference/instruments";

/** A child order submitted to the exchange by the OMS (or a test). */
export interface GatewayNewOrder {
  /** Trading account; stamped on the book order (accountId) and echoed. */
  account: string;
  /** Client order id; must be unique per account. */
  clOrdId: string;
  ric: string;
  side: Side;
  ordType: OrdType;
  quantity: number;
  /** Required for LIMIT, must be omitted for MARKET. */
  price?: number;
  /** Defaults to DAY. DAY and GTC both rest until cancelled. */
  timeInForce?: TimeInForce;
}

export interface GatewayAmend {
  /** New total order quantity (FIX OrderQty), >= cumQty. */
  quantity?: number;
  price?: number;
  /** Optional new client id echoed on the REPLACED / REJECTED report. */
  clOrdId?: string;
}

export interface GatewayCancel {
  /** Optional client id echoed on the CANCELLED / REJECTED report. */
  clOrdId?: string;
}

/** Which request a report answers (fills / expiries are unsolicited: undefined). */
export type GatewayRequestType = "NEW" | "AMEND" | "CANCEL";

/** FIX-style execution report. */
export interface ExecutionReport {
  execId: string;
  execType: ExecType;
  ordStatus: OrdStatus;
  responseTo?: GatewayRequestType;
  clOrdId: string;
  exchangeOrderId: string;
  account: string;
  ric: string;
  side: Side;
  ordType: OrdType;
  timeInForce: TimeInForce;
  /** Total order quantity. */
  quantity: number;
  /** Limit price (0 for market orders). */
  price: number;
  /** Fill quantity / price of this report (0 unless execType TRADE). */
  lastQty: number;
  lastPx: number;
  cumQty: number;
  leavesQty: number;
  avgPx: number;
  /** Exchange trade id (matches the trades table) for fills. */
  tradeId?: string;
  liquidity?: Liquidity;
  rejectReason?: RejectReason;
  text?: string;
  timestamp: number;
}

export type ExecutionReportListener = (report: ExecutionReport) => void;

export interface TopOfBook {
  ric: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  last: number;
  phase: TradingPhase;
  seq: number;
}

/**
 * In-process order entry API used by the OMS running in the same VuuServer.
 *
 * All calls are synchronous: execution reports for the request (ack/reject,
 * any immediate fills, IOC/market expiry) are delivered to listeners before
 * the call returns, in FIFO order. Reports for resting orders filled later by
 * other flow arrive whenever that flow trades. Listeners must not throw;
 * they may call back into the gateway (re-entrant calls are queued).
 */
export interface ExchangeGateway {
  /** Returns the exchange order id (also assigned to rejected orders). */
  submit(order: GatewayNewOrder): string;
  amend(exchangeOrderId: string, amend: GatewayAmend): void;
  cancel(exchangeOrderId: string, cancel?: GatewayCancel): void;
  /** Subscribe to every execution report; returns an unsubscribe function. */
  onExecutionReport(listener: ExecutionReportListener): () => void;
  /** Instrument static, or undefined if the ric is not listed. */
  getInstrument(ric: string): InstrumentDef | undefined;
  /** True when the instrument has a live book. */
  isSimulated(ric: string): boolean;
  getPhase(ric: string): TradingPhase | undefined;
  getTopOfBook(ric: string): TopOfBook | undefined;
  /** Last execution report state of an order, if known. */
  getOrder(exchangeOrderId: string): ExecutionReport | undefined;
}
