import {
  AlgoStrategy,
  type AmendOrderRequest,
  type CancelAllRequest,
  type CreateOrderRequest,
  canAmend,
  canCancel,
  ExecType,
  isStopOrdType,
  isStopTriggered,
  isTerminalStatus,
  isWorkingStatus,
  OrdStatus,
  OrdType,
  type OrderReject,
  positionKey,
  RejectReason,
  Side,
  sessionClosedSince,
  TimeInForce,
  TradingPhase,
  UNSCHEDULED,
  validateAmend,
} from "@heswell/trading-schemas";
import type { ExecutionReport, MarketTrade } from "@heswell/exchange-sim";
import { type Timer, TimerRegistry } from "@heswell/trading-metrics";
import {
  AlgoContainer,
  type AlgoParent,
  isAlgoParent,
} from "../algo/AlgoContainer";
import { type AlgoState, resolveAlgoParams } from "../algo/params";
import type { SliceRequest } from "../algo/planSlice";
import {
  newOrderState,
  type OrderEvent,
  OrderStateError,
  type OrderState,
  reduceOrder,
} from "../domain/orderState";
import {
  applyFill,
  FLAT_POSITION,
  markPosition,
  type PositionMarks,
  type PositionState,
} from "../domain/positionMath";
import { type AccessScope, canSeeAccount } from "../permissions/access";
import type { Account } from "../reference/accounts";
import { checkPreTradeRisk, referencePrice } from "../risk/preTradeRisk";
import type { OmsGateway } from "./gateway";

export interface OrderInfo {
  orderId: string;
  clOrdId?: string;
  trader: string;
  account: string;
  ric: string;
  side: Side;
  ordType: OrdType;
  timeInForce: TimeInForce;
  currency: string;
  created: number;
  lastUpdate: number;
  state: OrderState;
}

export interface ParentOrder extends OrderInfo {
  /** DMA child (the only child of a DMA order). */
  childOrderId?: string;
  /** How the order is worked; undefined (older state) = DMA. */
  strategy?: AlgoStrategy;
  /** Algo settings and progress (all strategies but DMA). */
  algo?: AlgoState;
  /** Children created so far (child ids are `${orderId}-${n}`). */
  childSeq?: number;
  /** Mid (else last / reference price) when the order was created; 0 = none. */
  arrivalPrice?: number;
  /** OMS clock time of the first fill. */
  firstFillAt?: number;
  /** OMS clock time the order became fully FILLED. */
  completedAt?: number;
  /** STOP / STOP_LIMIT trigger price. */
  stopPrice?: number;
  /** STOP / STOP_LIMIT: OMS clock time the stop triggered (child sent). */
  triggeredAt?: number;
}

/**
 * A STOP / STOP_LIMIT the OMS is still holding: not triggered, no child at
 * the exchange yet.
 */
export const isWaitingStop = (parent: ParentOrder) =>
  isStopOrdType(parent.ordType) &&
  parent.triggeredAt === undefined &&
  !isTerminalStatus(parent.state.status);

/** The exchange order type a triggered stop is sent as. */
const triggeredOrdType = (ordType: OrdType) =>
  ordType === OrdType.Stop
    ? OrdType.Market
    : ordType === OrdType.StopLimit
      ? OrdType.Limit
      : ordType;

/**
 * Execution quality of a parent order versus its arrival price. Slippage is
 * signed so positive = worse than arrival (bought above / sold below), in
 * basis points of arrivalPrice; 0 until filled or without an arrival price.
 * Times are ms from creation; 0 = not (yet) reached.
 */
export const executionQuality = (
  parent: Pick<
    ParentOrder,
    "side" | "created" | "arrivalPrice" | "firstFillAt" | "completedAt"
  > & { state: Pick<OrderState, "cumQty" | "avgPx"> },
) => {
  const arrival = parent.arrivalPrice ?? 0;
  const { cumQty, avgPx } = parent.state;
  let slippageBps = 0;
  if (arrival > 0 && cumQty > 0) {
    const diff = parent.side === Side.Buy ? avgPx - arrival : arrival - avgPx;
    slippageBps = Math.round((diff / arrival) * 1e6) / 100;
  }
  const since = (time?: number) =>
    time === undefined ? 0 : Math.max(0, time - parent.created);
  return {
    arrivalPrice: arrival,
    slippageBps,
    timeToFirstFill: since(parent.firstFillAt),
    timeToComplete: since(parent.completedAt),
  };
};

const orderInfo = (order: OrderInfo): OrderInfo => ({
  orderId: order.orderId,
  clOrdId: order.clOrdId,
  trader: order.trader,
  account: order.account,
  ric: order.ric,
  side: order.side,
  ordType: order.ordType,
  timeInForce: order.timeInForce,
  currency: order.currency,
  created: order.created,
  lastUpdate: order.lastUpdate,
  state: order.state,
});

export interface ChildOrder extends OrderInfo {
  parentOrderId: string;
  exchangeOrderId?: string;
  /** clOrdId currently live at the exchange (changes on amend / cancel). */
  exchangeClOrdId: string;
  requestSeq: number;
  /** Cancel sent by endOfDay: the CANCELLED report is recorded as EXPIRED. */
  expiring?: boolean;
  /** Reject of the last amend / cancel request, for the synchronous RPC result. */
  lastRequestReject?: OrderReject;
  /** Sequence of the last exchange exec id (`E<n>`) applied (replay is idempotent). */
  lastExecSeq?: number;
}

export interface Fill {
  execId: string;
  orderId: string;
  childOrderId: string;
  tradeId: string;
  account: string;
  trader: string;
  ric: string;
  side: Side;
  quantity: number;
  price: number;
  notional: number;
  currency: string;
  liquidity: string;
  timestamp: number;
}

export interface Position extends PositionState, PositionMarks {
  id: string;
  account: string;
  ric: string;
  currency: string;
  /** Instrument static, denormalised so positions can group by it. */
  exchange: string;
  sector: string;
  /** marketValue converted to USD with the instrument's usdPerPriceUnit. */
  marketValueUsd: number;
  /** totalPnl converted to USD with the instrument's usdPerPriceUnit. */
  totalPnlUsd: number;
  lastUpdate: number;
}

/** Receives every row change; OmsModule writes them to the Vuu tables. */
export interface OmsSink {
  account?(row: Account): void;
  parentOrder?(row: Record<string, unknown>): void;
  childOrder?(row: Record<string, unknown>): void;
  fill?(row: Fill): void;
  position?(row: Position): void;
}

/** Who is making a request. access undefined = unrestricted (internal flow, tests). */
export interface RequestContext {
  user: string;
  access?: AccessScope;
}

export type OmsResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RejectReason; text: string; orderId?: string };

const fail = <T>(
  reason: RejectReason,
  text: string,
  orderId?: string,
): OmsResult<T> => ({ ok: false, reason, text, orderId });

/** Persisted OMS state (see docs/persistence.md). */
export interface OmsState {
  version: 1;
  orderSeq: number;
  parents: ParentOrder[];
  children: ChildOrder[];
  fills: Fill[];
  positions: Position[];
}

/**
 * One OMS journal entry: the latest version of every row changed since the
 * previous batch (rows are upserts; fills are appended, keyed by execId).
 */
export interface OmsJournalBatch {
  orderSeq: number;
  parents?: ParentOrder[];
  children?: ChildOrder[];
  fills?: Fill[];
  positions?: Position[];
}

export type OmsJournal = (batch: OmsJournalBatch) => void;

/** Outcome of `reconcile` (all problems are also logged). */
export interface ReconcileResult {
  /** Children resolved because the request they were waiting on was lost. */
  resolved: string[];
  /** Working children with no live exchange order, expired. */
  expired: string[];
  /** Live exchange orders no OMS child owns (exchange order ids). */
  orphans: string[];
  /** Human-readable discrepancies. */
  discrepancies: string[];
}

/** What reconcile needs to know about the exchange. */
export interface ExchangeView {
  getOrder(exchangeOrderId: string): ExecutionReport | undefined;
  liveOrders(): Iterable<ExecutionReport>;
}

const execSeqOf = (execId: string) => {
  const n = Number(execId.slice(1));
  return Number.isFinite(n) ? n : undefined;
};

const childRecord = ({ lastRequestReject: _, ...child }: ChildOrder) =>
  child as ChildOrder;

export interface OmsEngineOptions {
  gateway: OmsGateway;
  accounts: readonly Account[];
  clock?: () => number;
  sink?: OmsSink;
  collarPct?: number;
  restrictedRics?: Iterable<string>;
  log?: (message: string) => void;
  /** Algo timer interval: how often algo orders are re-sliced (ms). */
  algoSliceMs?: number;
}

/**
 * Transport-independent OMS core: pre-trade risk, parent -> child routing to
 * the exchange gateway (one child for DMA, many for algo orders run by the
 * AlgoContainer), execution report handling and positions.
 */
export class OmsEngine {
  readonly accounts = new Map<string, Account>();
  readonly parents = new Map<string, ParentOrder>();
  readonly children = new Map<string, ChildOrder>();
  readonly fills: Fill[] = [];
  readonly positions = new Map<string, Position>();
  readonly restricted: Set<string>;
  collarPct: number;
  /**
   * Hot-path timers (requests, risk, execution reports, order lifecycle),
   * untimed until the server sets a mode (metrics.timers).
   */
  readonly timers = new TimerRegistry();
  /** Plain counters, read by the metrics source. */
  readonly stats = {
    /** Execution reports already applied (exec seq <= the child's last). */
    duplicateReports: 0,
    /** Execution reports for no known child order. */
    unknownReports: 0,
    /** Order events the state machine refused (OrderStateError), logged and ignored. */
    stateErrorsIgnored: 0,
  };
  /** Rejected createOrder / amendOrder / cancelOrder requests, by reason. */
  readonly rejects = new Map<string, number>();
  /** Child orders the exchange rejected, by reason. */
  readonly exchangeRejects = new Map<string, number>();
  readonly #timing: Record<
    | "createOrder"
    | "amendOrder"
    | "cancelOrder"
    | "risk"
    | "executionReport"
    | "childAck"
    | "firstFill",
    Timer
  >;
  /** Set while journaled reports are replayed (no lifecycle latencies). */
  #replaying = false;

  #gateway: OmsGateway;
  #clock: () => number;
  #sink: OmsSink;
  #log: (message: string) => void;
  #orderSeq = 0;
  #byClOrdId = new Map<string, ChildOrder>();
  #byExchangeId = new Map<string, ChildOrder>();
  #clOrdIdsByTrader = new Map<string, Set<string>>();
  #unsubscribe: () => void;
  #fillListeners = new Set<(fill: Fill) => void>();
  #observers = new Set<OmsSink>();
  #journal: OmsJournal | undefined;
  #dirtyParents = new Set<ParentOrder>();
  #dirtyChildren = new Set<ChildOrder>();
  #dirtyPositions = new Set<Position>();
  #newFills: Fill[] = [];
  #flushScheduled = false;
  #childrenByParent = new Map<string, ChildOrder[]>();
  #algos: AlgoContainer;
  #unsubscribeTrades: () => void;
  /** Waiting stops (see isWaitingStop) by orderId. */
  #stops = new Map<string, ParentOrder>();
  /** Tape trades not yet checked against the waiting stops. */
  #stopTrades: MarketTrade[] = [];

  constructor({
    gateway,
    accounts,
    clock = Date.now,
    sink = {},
    collarPct = 0.1,
    restrictedRics = [],
    log = (message) => console.warn(`[OMS] ${message}`),
    algoSliceMs = 250,
  }: OmsEngineOptions) {
    this.#gateway = gateway;
    this.#clock = clock;
    const t = this.timers;
    this.#timing = {
      createOrder: t.timer("oms", "createOrder"),
      amendOrder: t.timer("oms", "amendOrder"),
      cancelOrder: t.timer("oms", "cancelOrder"),
      risk: t.timer("oms", "risk"),
      executionReport: t.timer("oms", "executionReport"),
      childAck: t.timer("oms", "childAck"),
      firstFill: t.timer("oms", "firstFill"),
    };
    // Every row goes to the sink, then to observers (e.g. the notifier).
    const observers = this.#observers;
    this.#sink = {
      account: (row) => {
        sink.account?.(row);
        for (const o of observers) o.account?.(row);
      },
      parentOrder: (row) => {
        sink.parentOrder?.(row);
        for (const o of observers) o.parentOrder?.(row);
      },
      childOrder: (row) => {
        sink.childOrder?.(row);
        for (const o of observers) o.childOrder?.(row);
      },
      fill: (row) => {
        sink.fill?.(row);
        for (const o of observers) o.fill?.(row);
      },
      position: (row) => {
        sink.position?.(row);
        for (const o of observers) o.position?.(row);
      },
    };
    this.#log = log;
    this.collarPct = collarPct;
    this.restricted = new Set(restrictedRics);
    for (const account of accounts) {
      this.accounts.set(account.account, account);
      sink.account?.(account);
    }
    this.#unsubscribe = gateway.onExecutionReport(this.#onExecutionReport);
    this.#algos = new AlgoContainer(
      {
        clock: () => this.#clock(),
        schedule: () => this.#schedule(),
        topOfBook: (ric) => gateway.getTopOfBook(ric),
        lotSize: (ric) => gateway.getInstrument(ric)?.lotSize,
        liveChildren: (parent) => this.#liveChildren(parent),
        sendChild: (parent, request) => this.#sendChild(parent, request),
        cancelChild: (child) => this.#cancelChild(child),
        applyParent: (parent, event) => this.#applyParent(parent, event),
        publishParent: (parent) => this.#publishParent(parent),
        log: (message) => this.#log(message),
      },
      algoSliceMs,
    );
    this.#unsubscribeTrades =
      gateway.onTrade?.((trade) => {
        this.#algos.onTrade(trade);
        this.#onStopTrade(trade);
      }) ?? (() => undefined);
  }

  dispose() {
    this.#unsubscribe();
    this.#unsubscribeTrades();
  }

  // ---------------------------------------------------------------- algos

  /**
   * Algo timer: re-slice running algo orders and expire waiting DAY stops
   * whose session has closed (OmsService calls this).
   */
  stepAlgos(now = this.#clock()) {
    this.#algos.step(now);
    this.#expireClosedStops(now);
  }

  // ---------------------------------------------------------------- stops

  /** STOP / STOP_LIMIT orders the OMS is holding until their stop is reached. */
  get waitingStops(): readonly ParentOrder[] {
    return [...this.#stops.values()];
  }

  /**
   * A tape trade. Stops are checked in a microtask, not here: the exchange
   * reports the trade before it has finished the order that made it, so a
   * child sent now would reach the book mid-operation.
   */
  #onStopTrade(trade: MarketTrade) {
    if (this.#stops.size === 0) return;
    this.#stopTrades.push(trade);
    if (this.#stopTrades.length === 1) {
      queueMicrotask(() => this.#checkStops());
    }
  }

  #checkStops() {
    const trades = this.#stopTrades;
    this.#stopTrades = [];
    for (const trade of trades) {
      for (const parent of this.#stops.values()) {
        if (
          parent.ric === trade.ric &&
          isWorkingStatus(parent.state.status) &&
          isStopTriggered(parent.side, parent.stopPrice ?? 0, trade.price)
        ) {
          this.#triggerStop(parent, trade.price);
        }
      }
    }
  }

  /**
   * Send a triggered stop to the exchange: a MARKET child (STOP) or a LIMIT
   * child at the order's limit (STOP_LIMIT). A STOP's child is DAY (an
   * unfilled market remainder expires anyway; GTC is not valid for MARKET).
   */
  #triggerStop(parent: ParentOrder, tradePrice: number) {
    this.#stops.delete(parent.orderId);
    parent.triggeredAt = this.#clock();
    parent.lastUpdate = parent.triggeredAt;
    this.#log(
      `${parent.orderId} ${parent.side} stop ${parent.stopPrice} triggered by a trade at ${tradePrice}`,
    );
    const ordType = triggeredOrdType(parent.ordType);
    this.#publishParent(parent);
    this.#sendDmaChild(
      parent,
      ordType,
      ordType === OrdType.Market ? TimeInForce.Day : parent.timeInForce,
    );
  }

  /** Waiting DAY stops whose session closed since they were entered, or whose market is CLOSED. */
  #expireClosedStops(now: number) {
    if (this.#stops.size === 0) return;
    const schedule = this.#schedule();
    for (const parent of [...this.#stops.values()]) {
      if (
        parent.timeInForce === TimeInForce.Day &&
        isWorkingStatus(parent.state.status) &&
        (sessionClosedSince(schedule, parent.created, now) ||
          this.#gateway.getPhase(parent.ric) === TradingPhase.Closed)
      ) {
        this.#expireStop(parent, "DAY stop expired at market close");
      }
    }
  }

  #expireStop(parent: ParentOrder, text: string) {
    this.#stops.delete(parent.orderId);
    this.#applyParent(parent, { type: "expired", text });
  }

  /** Algo orders still being worked. */
  get runningAlgos(): readonly ParentOrder[] {
    return this.#algos.running;
  }

  #schedule() {
    return this.#gateway.getSessionSchedule?.() ?? UNSCHEDULED;
  }

  #liveChildren(parent: ParentOrder) {
    return (this.#childrenByParent.get(parent.orderId) ?? []).filter(
      (c) => !isTerminalStatus(c.state.status),
    );
  }

  #addChild(child: ChildOrder) {
    this.children.set(child.orderId, child);
    this.#byClOrdId.set(child.orderId, child);
    const list = this.#childrenByParent.get(child.parentOrderId);
    if (list) list.push(child);
    else this.#childrenByParent.set(child.parentOrderId, [child]);
  }

  /** New algo child (always LIMIT, at a price the slicer chose). */
  #sendChild(parent: ParentOrder, request: SliceRequest) {
    const childOrderId = `${parent.orderId}-${(parent.childSeq ?? 0) + 1}`;
    parent.childSeq = (parent.childSeq ?? 0) + 1;
    const now = this.#clock();
    const child: ChildOrder = {
      ...orderInfo(parent),
      orderId: childOrderId,
      parentOrderId: parent.orderId,
      clOrdId: childOrderId,
      exchangeClOrdId: childOrderId,
      ordType: OrdType.Limit,
      timeInForce: request.timeInForce,
      created: now,
      lastUpdate: now,
      state: newOrderState(request.quantity, request.price),
      requestSeq: 0,
    };
    this.#addChild(child);
    this.#publishChild(child);
    this.#publishParent(parent); // childSeq
    this.#gateway.submit({
      account: child.account,
      clOrdId: childOrderId,
      ric: child.ric,
      side: child.side,
      ordType: OrdType.Limit,
      quantity: request.quantity,
      price: request.price,
      timeInForce: request.timeInForce,
    });
  }

  #cancelChild(child: ChildOrder) {
    if (!child.exchangeOrderId || !isWorkingStatus(child.state.status)) return;
    this.#applyChild(child, { type: "pendingCancel" });
    child.expiring = false;
    const clOrdId = `${child.orderId}.c${++child.requestSeq}`;
    this.#publishChild(child);
    this.#byClOrdId.set(clOrdId, child);
    child.lastRequestReject = undefined;
    this.#gateway.cancel(child.exchangeOrderId, { clOrdId });
  }

  /**
   * Apply a child event to its parent: a DMA parent mirrors its child; an
   * algo parent only takes the fills (its status is set by the container),
   * and the container is told so it can advance.
   */
  #applyChildEventToParent(
    parent: ParentOrder,
    child: ChildOrder,
    event: OrderEvent,
  ) {
    if (!isAlgoParent(parent)) {
      if (parent.triggeredAt !== undefined) {
        // A triggered stop is already working: the child's ack is not news,
        // and a rejected child ends the order (it cannot go back to waiting).
        if (event.type === "ack") return;
        if (event.type === "reject") {
          this.#applyParent(parent, {
            type: "expired",
            reason: event.reason,
            text: `stop triggered but the order was rejected: ${event.text ?? event.reason}`,
          });
          return;
        }
      }
      if (event.type === "fill" && parent.firstFillAt === undefined) {
        parent.firstFillAt = this.#clock();
        if (!this.#replaying)
          this.#timing.firstFill.record(
            (parent.firstFillAt - parent.created) * 1_000,
          );
      }
      this.#applyParent(parent, event);
      return;
    }
    if (event.type === "fill") {
      parent.firstFillAt ??= this.#clock();
      try {
        this.#applyParent(parent, event);
      } catch (err) {
        if (!(err instanceof OrderStateError)) throw err;
        this.stats.stateErrorsIgnored++;
        this.#log(
          `${parent.orderId} fill ${event.qty}@${event.px} on ${child.orderId} not applied to the parent: ${err.message}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Journal hook: changed rows are batched and handed over at the end of the
   * current tick, or earlier by `flushJournal()` (the persistence layer
   * flushes before every exchange journal entry, keeping causal order).
   */
  setJournal(journal: OmsJournal | undefined) {
    this.#journal = journal;
  }

  #markDirty() {
    if (!this.#journal || this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => this.flushJournal());
  }

  /** Hand pending row changes to the journal now. */
  flushJournal() {
    this.#flushScheduled = false;
    const journal = this.#journal;
    if (!journal) return;
    if (
      this.#dirtyParents.size === 0 &&
      this.#dirtyChildren.size === 0 &&
      this.#dirtyPositions.size === 0 &&
      this.#newFills.length === 0
    ) {
      return;
    }
    const batch: OmsJournalBatch = { orderSeq: this.#orderSeq };
    if (this.#dirtyParents.size) batch.parents = [...this.#dirtyParents];
    if (this.#dirtyChildren.size)
      batch.children = [...this.#dirtyChildren].map(childRecord);
    if (this.#newFills.length) batch.fills = this.#newFills;
    if (this.#dirtyPositions.size) batch.positions = [...this.#dirtyPositions];
    this.#dirtyParents = new Set();
    this.#dirtyChildren = new Set();
    this.#dirtyPositions = new Set();
    this.#newFills = [];
    journal(batch);
  }

  exportState(): OmsState {
    return {
      version: 1,
      orderSeq: this.#orderSeq,
      parents: [...this.parents.values()],
      children: [...this.children.values()].map(childRecord),
      fills: this.fills,
      positions: [...this.positions.values()],
    };
  }

  /**
   * Replace all orders, fills and positions with `state` (a snapshot with
   * journal batches applied, see `applyJournalBatch`), rebuild the indexes
   * and publish every row to the sink. Call before any order flow.
   */
  restoreState(state: OmsState) {
    if (state.version !== 1) {
      throw Error(`unsupported OMS state version ${state.version}`);
    }
    this.parents.clear();
    this.children.clear();
    this.positions.clear();
    this.fills.length = 0;
    this.#byClOrdId.clear();
    this.#byExchangeId.clear();
    this.#clOrdIdsByTrader.clear();
    this.#childrenByParent.clear();
    let orderSeq = state.orderSeq;
    for (const parent of state.parents) {
      this.parents.set(parent.orderId, parent);
      orderSeq = Math.max(orderSeq, Number(parent.orderId.slice(2)) || 0);
      if (parent.clOrdId) {
        const used = this.#clOrdIdsByTrader.get(parent.trader) ?? new Set();
        used.add(parent.clOrdId);
        this.#clOrdIdsByTrader.set(parent.trader, used);
      }
      this.#publishParent(parent);
    }
    this.#orderSeq = orderSeq;
    for (const child of state.children) {
      this.#addChild(child);
      for (let k = 1; k <= child.requestSeq; k++) {
        this.#byClOrdId.set(`${child.orderId}.r${k}`, child);
        this.#byClOrdId.set(`${child.orderId}.c${k}`, child);
      }
      if (child.exchangeOrderId)
        this.#byExchangeId.set(child.exchangeOrderId, child);
      this.#publishChild(child);
    }
    for (const fill of state.fills) {
      this.fills.push(fill);
      this.#sink.fill?.(fill);
    }
    for (const position of state.positions) {
      Object.assign(position, this.#usdMarks(position));
      this.positions.set(position.id, position);
      this.#sink.position?.({ ...position });
    }
    this.#dirtyParents.clear();
    this.#dirtyChildren.clear();
    this.#dirtyPositions.clear();
    this.#newFills = [];
    this.#algos.restore(this.parents.values());
    this.#stops.clear();
    this.#stopTrades = [];
    for (const parent of this.parents.values()) {
      if (isWaitingStop(parent)) this.#stops.set(parent.orderId, parent);
    }
  }

  /**
   * Apply an execution report outside the gateway subscription, e.g. one
   * replayed from the journal. Reports already applied to the child (exec
   * seq <= child.lastExecSeq) are ignored.
   */
  applyExecutionReport(report: ExecutionReport) {
    this.#replaying = true;
    try {
      this.#onExecutionReport(report);
    } finally {
      this.#replaying = false;
    }
  }

  /**
   * After a restore (and replay of journaled reports), make the OMS agree
   * with the exchange:
   * - a child still waiting on a request whose report never came (lost in
   *   the restart) is resolved: PENDING_NEW -> REJECTED, PENDING_REPLACE ->
   *   replace rejected, PENDING_CANCEL -> cancel rejected;
   * - a working child with no live exchange order is expired;
   * - quantity / status differences are logged;
   * - live exchange orders with no OMS child are returned as orphans.
   */
  reconcile(view: ExchangeView): ReconcileResult {
    const result: ReconcileResult = {
      resolved: [],
      expired: [],
      orphans: [],
      discrepancies: [],
    };
    const note = (text: string) => {
      result.discrepancies.push(text);
      this.#log(`reconcile: ${text}`);
    };
    const lost = "request lost in server restart";
    for (const child of this.children.values()) {
      const parent = this.parents.get(child.parentOrderId);
      if (!parent || isTerminalStatus(child.state.status)) continue;
      const apply = (event: OrderEvent) => {
        try {
          this.#applyChild(child, event);
          this.#applyChildEventToParent(parent, child, event);
        } catch (err) {
          if (!(err instanceof OrderStateError)) throw err;
          note(`${child.orderId} ${event.type} not applied: ${err.message}`);
        }
        this.#algos.onChildEvent(parent);
      };
      const { status } = child.state;
      if (!child.exchangeOrderId) {
        if (status === OrdStatus.PendingNew) {
          apply({
            type: "reject",
            reason: RejectReason.InternalError,
            text: lost,
          });
          result.resolved.push(child.orderId);
          note(
            `${child.orderId} was never acknowledged by the exchange: rejected`,
          );
        }
        continue;
      }
      const exchange = view.getOrder(child.exchangeOrderId);
      if (status === OrdStatus.PendingReplace) {
        apply({
          type: "replaceReject",
          reason: RejectReason.InternalError,
          text: lost,
        });
        result.resolved.push(child.orderId);
      } else if (status === OrdStatus.PendingCancel) {
        apply({
          type: "cancelReject",
          reason: RejectReason.InternalError,
          text: lost,
        });
        result.resolved.push(child.orderId);
      }
      if (child.expiring) {
        child.expiring = false;
        this.#dirtyChildren.add(child);
      }
      if (!exchange || isTerminalStatus(exchange.ordStatus)) {
        note(
          `${child.orderId} is ${child.state.status} but exchange order ${child.exchangeOrderId} is ${exchange?.ordStatus ?? "unknown"}: expired`,
        );
        apply({
          type: "expired",
          text: "order not found at the exchange after restart",
        });
        result.expired.push(child.orderId);
        continue;
      }
      const { cumQty, quantity, price } = child.state;
      if (
        exchange.cumQty !== cumQty ||
        exchange.quantity !== quantity ||
        (child.ordType === OrdType.Limit && exchange.price !== price)
      ) {
        note(
          `${child.orderId} OMS qty ${quantity} @ ${price} cum ${cumQty} != exchange ${exchange.exchangeOrderId} qty ${exchange.quantity} @ ${exchange.price} cum ${exchange.cumQty}`,
        );
      }
    }
    for (const order of view.liveOrders()) {
      if (!this.#byExchangeId.has(order.exchangeOrderId)) {
        result.orphans.push(order.exchangeOrderId);
        note(
          `exchange order ${order.exchangeOrderId} (${order.account} ${order.clOrdId}) has no OMS order`,
        );
      }
    }
    return result;
  }

  /**
   * Receive every row published from now on, after the sink (rows already
   * published, e.g. on recovery, are not replayed). Returns unsubscribe.
   */
  observe(observer: OmsSink) {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  onFill(listener: (fill: Fill) => void) {
    this.#fillListeners.add(listener);
    return () => {
      this.#fillListeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- queries

  getOrder(orderId: string) {
    return this.parents.get(orderId);
  }

  getPosition(account: string, ric: string) {
    return this.positions.get(positionKey(account, ric));
  }

  /** Parent orders that are live (not terminal), optionally filtered. */
  liveOrders(filter: (order: ParentOrder) => boolean = () => true) {
    return [...this.parents.values()].filter(
      (o) => !isTerminalStatus(o.state.status) && filter(o),
    );
  }

  #workingQty(account: string, ric: string, excludeOrderId?: string) {
    let buy = 0;
    let sell = 0;
    for (const o of this.parents.values()) {
      if (
        o.account !== account ||
        o.ric !== ric ||
        o.orderId === excludeOrderId ||
        isTerminalStatus(o.state.status)
      ) {
        continue;
      }
      if (o.side === Side.Buy) buy += o.state.leavesQty;
      else sell += o.state.leavesQty;
    }
    return { buy, sell };
  }

  #riskContext(account: string, ric: string, excludeOrderId?: string) {
    const top = this.#gateway.getTopOfBook(ric);
    const working = this.#workingQty(account, ric, excludeOrderId);
    return {
      account: this.accounts.get(account),
      instrument: this.#gateway.getInstrument(ric),
      phase: top?.phase ?? this.#gateway.getPhase(ric) ?? TradingPhase.Closed,
      market: top,
      restricted: this.restricted,
      collarPct: this.collarPct,
      positionQty: this.getPosition(account, ric)?.quantity ?? 0,
      workingBuyQty: working.buy,
      workingSellQty: working.sell,
    };
  }

  // ---------------------------------------------------------------- requests

  /**
   * Create a parent order. Risk rejects are recorded as REJECTED parent
   * orders (and returned as failures carrying the orderId); request errors
   * (permission, duplicate clOrdId) are returned without creating an order.
   */
  createOrder(
    request: CreateOrderRequest,
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; clOrdId?: string; status: OrdStatus }> {
    const timer = this.#timing.createOrder;
    const t0 = timer.start();
    const result = this.#createOrder(request, ctx);
    timer.stop(t0);
    if (!result.ok) this.#countReject(this.rejects, result.reason);
    return result;
  }

  #countReject(counts: Map<string, number>, reason: string) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  /** checkPreTradeRisk, timed. */
  #checkRisk(...args: Parameters<typeof checkPreTradeRisk>) {
    const timer = this.#timing.risk;
    const t0 = timer.start();
    const reject = checkPreTradeRisk(...args);
    timer.stop(t0);
    return reject;
  }

  #createOrder(
    request: CreateOrderRequest,
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; clOrdId?: string; status: OrdStatus }> {
    const { access } = ctx;
    if (
      access &&
      !(access.canExecute && canSeeAccount(access, request.account))
    ) {
      return fail(
        RejectReason.PermissionDenied,
        `${ctx.user} may not trade account ${request.account}`,
      );
    }
    if (request.clOrdId) {
      const used = this.#clOrdIdsByTrader.get(ctx.user) ?? new Set();
      if (used.has(request.clOrdId)) {
        return fail(
          RejectReason.DuplicateClOrdId,
          `duplicate clOrdId ${request.clOrdId}`,
        );
      }
    }
    const now = this.#clock();
    const strategy = request.strategy ?? AlgoStrategy.Dma;
    const stop = isStopOrdType(request.ordType);
    if (stop && strategy !== AlgoStrategy.Dma) {
      return fail(
        RejectReason.UnsupportedOrdType,
        `${request.ordType} orders are DMA only, not ${strategy}`,
      );
    }
    let algo: AlgoState | undefined;
    if (strategy !== AlgoStrategy.Dma) {
      const resolved = resolveAlgoParams(request, this.#schedule(), now);
      if (!resolved.ok) return fail(resolved.reason, resolved.text);
      algo = resolved.algo;
    }
    if (request.clOrdId) {
      const used = this.#clOrdIdsByTrader.get(ctx.user) ?? new Set();
      used.add(request.clOrdId);
      this.#clOrdIdsByTrader.set(ctx.user, used);
    }

    const timeInForce = request.timeInForce ?? TimeInForce.Day;
    const price =
      request.ordType === OrdType.Market || request.ordType === OrdType.Stop
        ? 0
        : (request.price ?? 0);
    const instrument = this.#gateway.getInstrument(request.ric);
    const top = this.#gateway.getTopOfBook(request.ric);
    // 1e-8 strips float noise from the mid of two tick prices
    const arrivalPrice =
      Math.round(
        (top && top.bid > 0 && top.ask > 0
          ? (top.bid + top.ask) / 2
          : instrument
            ? referencePrice(instrument, top)
            : 0) * 1e8,
      ) / 1e8;
    const parent: ParentOrder = {
      orderId: `O-${++this.#orderSeq}`,
      clOrdId: request.clOrdId,
      trader: ctx.user,
      account: request.account,
      ric: request.ric,
      side: request.side,
      ordType: request.ordType,
      timeInForce,
      currency: instrument?.currency ?? "",
      created: now,
      lastUpdate: now,
      state: newOrderState(request.quantity, price),
      arrivalPrice,
      strategy,
      ...(algo ? { algo, childSeq: 0 } : {}),
      ...(stop ? { stopPrice: request.stopPrice } : {}),
    };
    this.parents.set(parent.orderId, parent);

    const riskReject = this.#checkRisk(
      { ...request, timeInForce },
      this.#riskContext(request.account, request.ric),
    );
    if (riskReject) {
      this.#applyParent(parent, { type: "reject", ...riskReject });
      return fail(riskReject.reason, riskReject.text, parent.orderId);
    }
    this.#publishParent(parent);

    if (isAlgoParent(parent)) {
      this.#applyParent(parent, { type: "ack" });
      this.#algos.start(parent);
      return {
        ok: true,
        value: {
          orderId: parent.orderId,
          clOrdId: parent.clOrdId,
          status: parent.state.status,
        },
      };
    }

    if (isStopOrdType(parent.ordType)) {
      // Held here until a trade reaches the stop price.
      this.#applyParent(parent, { type: "ack" });
      this.#stops.set(parent.orderId, parent);
      return {
        ok: true,
        value: {
          orderId: parent.orderId,
          clOrdId: parent.clOrdId,
          status: parent.state.status,
        },
      };
    }

    this.#sendDmaChild(parent, parent.ordType, timeInForce);

    const { status, rejectReason, text } = parent.state;
    if (status === OrdStatus.Rejected) {
      return fail(
        rejectReason ?? RejectReason.InternalError,
        text ?? "rejected by exchange",
        parent.orderId,
      );
    }
    return {
      ok: true,
      value: { orderId: parent.orderId, clOrdId: parent.clOrdId, status },
    };
  }

  /** Create and submit the only child of a DMA order (or of a triggered stop). */
  #sendDmaChild(
    parent: ParentOrder,
    ordType: OrdType,
    timeInForce: TimeInForce,
  ) {
    const childOrderId = `${parent.orderId}-1`;
    const now = this.#clock();
    const child: ChildOrder = {
      ...orderInfo(parent),
      orderId: childOrderId,
      parentOrderId: parent.orderId,
      clOrdId: childOrderId,
      exchangeClOrdId: childOrderId,
      ordType,
      timeInForce,
      created: now,
      lastUpdate: now,
      state: newOrderState(
        parent.state.leavesQty,
        ordType === OrdType.Market ? 0 : parent.state.price,
      ),
      requestSeq: 0,
    };
    parent.childOrderId = childOrderId;
    this.#addChild(child);
    this.#publishChild(child);

    this.#gateway.submit({
      account: child.account,
      clOrdId: childOrderId,
      ric: child.ric,
      side: child.side,
      ordType,
      quantity: child.state.quantity,
      price: ordType === OrdType.Market ? undefined : child.state.price,
      timeInForce,
    });
  }

  /** Resolve a parent + its child for an amend / cancel request. */
  #liveOrderFor(
    orderId: string,
    ctx: RequestContext,
    tooLate: RejectReason,
  ): OmsResult<{ parent: ParentOrder; child?: ChildOrder }> {
    const parent = this.parents.get(orderId);
    const { access } = ctx;
    if (!parent || (access && !canSeeAccount(access, parent.account))) {
      return fail(RejectReason.UnknownOrder, `unknown order ${orderId}`);
    }
    if (access && !access.canExecute) {
      return fail(
        RejectReason.PermissionDenied,
        `${ctx.user} may not trade account ${parent.account}`,
        orderId,
      );
    }
    const { status } = parent.state;
    if (isTerminalStatus(status)) {
      return fail(tooLate, `order is ${status}`, orderId);
    }
    if (isAlgoParent(parent)) {
      if (!isWorkingStatus(status) || parent.algo.phase !== "WORKING") {
        return fail(
          RejectReason.OrderPending,
          `order is ${status}, retry when the pending request completes`,
          orderId,
        );
      }
      return { ok: true, value: { parent } };
    }
    if (isWaitingStop(parent) && isWorkingStatus(status)) {
      return { ok: true, value: { parent } };
    }
    const child = parent.childOrderId
      ? this.children.get(parent.childOrderId)
      : undefined;
    if (!isWorkingStatus(status) || !child?.exchangeOrderId) {
      return fail(
        RejectReason.OrderPending,
        `order is ${status}, retry when the pending request completes`,
        orderId,
      );
    }
    return { ok: true, value: { parent, child } };
  }

  amendOrder(
    request: AmendOrderRequest,
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; status: OrdStatus }> {
    const timer = this.#timing.amendOrder;
    const t0 = timer.start();
    const result = this.#amendOrder(request, ctx);
    timer.stop(t0);
    if (!result.ok) this.#countReject(this.rejects, result.reason);
    return result;
  }

  #amendOrder(
    request: AmendOrderRequest,
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; status: OrdStatus }> {
    const found = this.#liveOrderFor(
      request.orderId,
      ctx,
      RejectReason.TooLateToAmend,
    );
    if (!found.ok) return found;
    const { parent, child } = found.value;
    if (!canAmend(parent.state.status)) {
      return fail(RejectReason.OrderPending, "order cannot be amended now");
    }
    const algoParent = isAlgoParent(parent) ? parent : undefined;
    const waitingStop = isWaitingStop(parent);
    const quantity = request.quantity ?? parent.state.quantity;
    const price = request.price ?? parent.state.price;
    const stopPrice = request.stopPrice ?? parent.stopPrice;
    if (
      request.stopPrice !== undefined &&
      isStopOrdType(parent.ordType) &&
      !waitingStop
    ) {
      return fail(
        RejectReason.InvalidStopPrice,
        "the stop has already triggered",
        parent.orderId,
      );
    }
    if (
      quantity === parent.state.quantity &&
      price === parent.state.price &&
      stopPrice === parent.stopPrice
    ) {
      return fail(
        RejectReason.InvalidRequest,
        "amend does not change the order",
      );
    }
    const instrument = this.#gateway.getInstrument(parent.ric);
    if (!instrument) {
      return fail(
        RejectReason.UnknownInstrument,
        `unknown instrument ${parent.ric}`,
      );
    }
    // A triggered stop is checked as the order it became at the exchange.
    const riskOrdType =
      isStopOrdType(parent.ordType) && !waitingStop
        ? triggeredOrdType(parent.ordType)
        : parent.ordType;
    const invalid =
      validateAmend(request, instrument, {
        ordType: parent.ordType,
        cumQty: parent.state.cumQty,
        side: parent.side,
        price: parent.state.price,
        stopPrice: parent.stopPrice,
      }) ??
      this.#checkRisk(
        {
          account: parent.account,
          ric: parent.ric,
          side: parent.side,
          ordType: riskOrdType,
          timeInForce: child?.timeInForce ?? parent.timeInForce,
          // Risk applies to what is still to trade; the filled part is already in the position.
          quantity: quantity - parent.state.cumQty || instrument.lotSize,
          price:
            riskOrdType === OrdType.Market || riskOrdType === OrdType.Stop
              ? undefined
              : price,
          stopPrice: waitingStop ? stopPrice : undefined,
        },
        this.#riskContext(parent.account, parent.ric, parent.orderId),
      );
    if (invalid) return fail(invalid.reason, invalid.text, parent.orderId);

    if (waitingStop) {
      // Nothing at the exchange: the amend applies at once.
      this.#applyParent(parent, { type: "pendingReplace", quantity, price });
      parent.stopPrice = stopPrice;
      this.#applyParent(parent, { type: "replaced", quantity, price });
      return {
        ok: true,
        value: { orderId: parent.orderId, status: parent.state.status },
      };
    }

    if (algoParent || !child) {
      this.#algos.amend(parent as AlgoParent, quantity, price);
      return {
        ok: true,
        value: { orderId: parent.orderId, status: parent.state.status },
      };
    }

    const event: OrderEvent = { type: "pendingReplace", quantity, price };
    this.#applyParent(parent, event);
    this.#applyChild(child, event);
    const clOrdId = `${child.orderId}.r${++child.requestSeq}`;
    this.#publishChild(child);
    this.#byClOrdId.set(clOrdId, child);
    child.lastRequestReject = undefined;
    this.#gateway.amend(child.exchangeOrderId as string, {
      quantity: quantity !== child.state.quantity ? quantity : undefined,
      price: price !== child.state.price ? price : undefined,
      clOrdId,
    });
    return this.#requestResult(parent, child);
  }

  cancelOrder(
    request: { orderId: string },
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; status: OrdStatus }> {
    const timer = this.#timing.cancelOrder;
    const t0 = timer.start();
    const result = this.#cancelOrder(request, ctx);
    timer.stop(t0);
    if (!result.ok) this.#countReject(this.rejects, result.reason);
    return result;
  }

  #cancelOrder(
    request: { orderId: string },
    ctx: RequestContext,
  ): OmsResult<{ orderId: string; status: OrdStatus }> {
    const found = this.#liveOrderFor(
      request.orderId,
      ctx,
      RejectReason.TooLateToCancel,
    );
    if (!found.ok) return found;
    const { parent, child } = found.value;
    if (!canCancel(parent.state.status)) {
      return fail(RejectReason.OrderPending, "order cannot be cancelled now");
    }
    if (isWaitingStop(parent)) {
      this.#stops.delete(parent.orderId);
      this.#applyParent(parent, { type: "pendingCancel" });
      this.#applyParent(parent, { type: "cancelled" });
      return {
        ok: true,
        value: { orderId: parent.orderId, status: parent.state.status },
      };
    }
    if (isAlgoParent(parent) || !child) {
      this.#algos.cancel(parent as AlgoParent);
      return {
        ok: true,
        value: { orderId: parent.orderId, status: parent.state.status },
      };
    }
    this.#sendCancel(parent, child);
    return this.#requestResult(parent, child);
  }

  #sendCancel(parent: ParentOrder, child: ChildOrder, expiring = false) {
    if (!expiring) {
      this.#applyParent(parent, { type: "pendingCancel" });
      this.#applyChild(child, { type: "pendingCancel" });
    }
    child.expiring = expiring;
    const clOrdId = `${child.orderId}.c${++child.requestSeq}`;
    this.#publishChild(child);
    this.#byClOrdId.set(clOrdId, child);
    child.lastRequestReject = undefined;
    this.#gateway.cancel(child.exchangeOrderId as string, { clOrdId });
  }

  #requestResult(
    parent: ParentOrder,
    child: ChildOrder,
  ): OmsResult<{ orderId: string; status: OrdStatus }> {
    const reject = child.lastRequestReject;
    if (reject) {
      child.lastRequestReject = undefined;
      return fail(reject.reason, reject.text, parent.orderId);
    }
    return {
      ok: true,
      value: { orderId: parent.orderId, status: parent.state.status },
    };
  }

  /**
   * Cancel matching working orders. With no account filter only the caller's
   * own orders (trader = user) are cancelled; with an account filter, any
   * order of that (visible) account. Orders with a request in flight are skipped.
   */
  cancelAll(filter: CancelAllRequest, ctx: RequestContext) {
    const { access } = ctx;
    if (access && !access.canExecute) {
      return fail<{ orderIds: string[] }>(
        RejectReason.PermissionDenied,
        `${ctx.user} may not trade`,
      );
    }
    const orderIds: string[] = [];
    for (const parent of this.liveOrders(
      (o) =>
        (filter.account
          ? o.account === filter.account
          : o.trader === ctx.user) &&
        (!filter.ric || o.ric === filter.ric) &&
        (!filter.side || o.side === filter.side) &&
        (!access || canSeeAccount(access, o.account)),
    )) {
      const result = this.cancelOrder({ orderId: parent.orderId }, ctx);
      if (result.ok || result.reason !== RejectReason.OrderPending) {
        orderIds.push(parent.orderId);
      }
    }
    return { ok: true as const, value: { orderIds } };
  }

  /**
   * End of trading day: expire working DAY orders (cancelled at the exchange,
   * recorded as EXPIRED). With a configured exchange-sim session the exchange
   * expires DAY orders at its close itself (EXPIRED reports); this is the
   * manual equivalent, e.g. for an always-open market. Orders with a request
   * in flight are skipped.
   */
  endOfDay() {
    const expired: string[] = [];
    for (const parent of this.liveOrders(
      (o) =>
        o.timeInForce === TimeInForce.Day && isWorkingStatus(o.state.status),
    )) {
      if (isAlgoParent(parent)) {
        if (parent.algo.phase !== "WORKING") continue;
        this.#algos.expire(parent, "DAY order expired at end of day");
        expired.push(parent.orderId);
        continue;
      }
      if (isWaitingStop(parent)) {
        this.#expireStop(parent, "DAY stop expired at end of day");
        expired.push(parent.orderId);
        continue;
      }
      const child = parent.childOrderId
        ? this.children.get(parent.childOrderId)
        : undefined;
      if (!child?.exchangeOrderId) continue;
      this.#sendCancel(parent, child, true);
      expired.push(parent.orderId);
    }
    return expired;
  }

  // ---------------------------------------------------------------- positions

  /** Mark every position to the gateway's last / mid / reference price. */
  markToMarket() {
    let changed = 0;
    for (const position of this.positions.values()) {
      const instrument = this.#gateway.getInstrument(position.ric);
      if (!instrument) continue;
      const px = referencePrice(
        instrument,
        this.#gateway.getTopOfBook(position.ric),
      );
      if (px === position.markPx) continue;
      const marks = markPosition(position, px);
      Object.assign(
        position,
        marks,
        this.#usdMarks({ ...position, ...marks }),
        {
          lastUpdate: this.#clock(),
        },
      );
      this.#sink.position?.({ ...position });
      changed++;
    }
    return changed;
  }

  /** USD market value / P&L (2 dp) via the instrument's usdPerPriceUnit. */
  #usdMarks({
    ric,
    marketValue,
    totalPnl,
  }: Pick<Position, "ric" | "marketValue" | "totalPnl">) {
    const usd = this.#gateway.getInstrument(ric)?.usdPerPriceUnit ?? 1;
    return {
      marketValueUsd: Math.round(marketValue * usd * 100) / 100,
      totalPnlUsd: Math.round(totalPnl * usd * 100) / 100,
    };
  }

  #applyFillToPosition(fill: Fill) {
    const id = positionKey(fill.account, fill.ric);
    const existing = this.positions.get(id);
    const state = applyFill(
      existing ?? FLAT_POSITION,
      fill.side,
      fill.quantity,
      fill.price,
    );
    const markPx = existing?.markPx || fill.price;
    const instrument = this.#gateway.getInstrument(fill.ric);
    const marks = markPosition(state, markPx);
    const position: Position = {
      id,
      account: fill.account,
      ric: fill.ric,
      currency: fill.currency,
      exchange: instrument?.exchange ?? "",
      sector: instrument?.sector ?? "",
      ...state,
      ...marks,
      ...this.#usdMarks({ ric: fill.ric, ...marks }),
      lastUpdate: fill.timestamp,
    };
    this.positions.set(id, position);
    if (this.#journal) {
      this.#dirtyPositions.add(position);
      this.#markDirty();
    }
    this.#sink.position?.({ ...position });
  }

  // ---------------------------------------------------------------- reports

  #onExecutionReport = (report: ExecutionReport) => {
    const timer = this.#timing.executionReport;
    const t0 = timer.start();
    try {
      this.#applyReport(report);
    } finally {
      timer.stop(t0);
    }
  };

  #applyReport(report: ExecutionReport) {
    const child =
      this.#byExchangeId.get(report.exchangeOrderId) ??
      this.#byClOrdId.get(report.clOrdId);
    if (!child) {
      this.stats.unknownReports++;
      return;
    }
    const execSeq = execSeqOf(report.execId);
    if (execSeq !== undefined) {
      if (child.lastExecSeq !== undefined && execSeq <= child.lastExecSeq) {
        this.stats.duplicateReports++;
        return;
      }
      child.lastExecSeq = execSeq;
    }
    if (this.#journal) {
      this.#dirtyChildren.add(child);
      this.#markDirty();
    }
    if (!child.exchangeOrderId && report.exchangeOrderId) {
      child.exchangeOrderId = report.exchangeOrderId;
      this.#byExchangeId.set(report.exchangeOrderId, child);
    }
    if (report.clOrdId && report.execType !== ExecType.Rejected) {
      child.exchangeClOrdId = report.clOrdId;
    }
    const parent = this.parents.get(child.parentOrderId);
    if (!parent) return;
    const event = this.#toEvent(report, child);
    if (!event) return;
    try {
      this.#applyChild(child, event);
      this.#applyChildEventToParent(parent, child, event);
    } catch (err) {
      if (!(err instanceof OrderStateError)) throw err;
      this.stats.stateErrorsIgnored++;
      this.#log(
        `${child.orderId} ${report.execType}/${report.ordStatus} ignored: ${err.message}`,
      );
      return;
    }
    if (event.type === "ack" && !this.#replaying)
      this.#timing.childAck.record((this.#clock() - child.created) * 1_000);
    else if (event.type === "reject")
      this.#countReject(this.exchangeRejects, event.reason);
    if (event.type === "fill") this.#recordFill(report, parent, child);
    this.#algos.onChildEvent(parent);
  }

  #toEvent(report: ExecutionReport, child: ChildOrder): OrderEvent | undefined {
    const reason = report.rejectReason ?? RejectReason.InternalError;
    const text = report.text;
    switch (report.execType) {
      case ExecType.New:
        return { type: "ack" };
      case ExecType.Rejected:
        if (report.responseTo === "NEW")
          return { type: "reject", reason, text };
        if (report.responseTo === "CANCEL" && child.expiring) {
          child.expiring = false;
          return undefined;
        }
        child.lastRequestReject = { reason, text: text ?? reason };
        return report.responseTo === "AMEND"
          ? { type: "replaceReject", reason, text }
          : { type: "cancelReject", reason, text };
      case ExecType.Trade:
        return { type: "fill", qty: report.lastQty, px: report.lastPx };
      case ExecType.Replaced:
        return {
          type: "replaced",
          quantity: report.quantity,
          price: report.price,
        };
      case ExecType.Cancelled:
        return child.expiring
          ? { type: "expired", text: "DAY order expired at end of day" }
          : { type: "cancelled" };
      case ExecType.Expired:
        return { type: "expired", reason: report.rejectReason, text };
      default:
        return undefined;
    }
  }

  #recordFill(report: ExecutionReport, parent: ParentOrder, child: ChildOrder) {
    const fill: Fill = {
      execId: report.execId,
      orderId: parent.orderId,
      childOrderId: child.orderId,
      tradeId: report.tradeId ?? "",
      account: parent.account,
      trader: parent.trader,
      ric: parent.ric,
      side: parent.side,
      quantity: report.lastQty,
      price: report.lastPx,
      notional: report.lastQty * report.lastPx,
      currency: parent.currency,
      liquidity: report.liquidity ?? "",
      timestamp: report.timestamp,
    };
    this.fills.push(fill);
    if (this.#journal) {
      this.#newFills.push(fill);
      this.#markDirty();
    }
    this.#sink.fill?.(fill);
    this.#applyFillToPosition(fill);
    this.#algos.onOwnFill(parent, fill.quantity);
    for (const listener of this.#fillListeners) listener(fill);
  }

  // ---------------------------------------------------------------- state

  #applyParent(parent: ParentOrder, event: OrderEvent) {
    parent.state = reduceOrder(parent.state, event);
    parent.lastUpdate = this.#clock();
    if (parent.state.status === OrdStatus.Filled) {
      parent.completedAt ??= parent.lastUpdate;
    }
    this.#publishParent(parent);
  }

  #applyChild(child: ChildOrder, event: OrderEvent) {
    child.state = reduceOrder(child.state, event);
    child.lastUpdate = this.#clock();
    this.#publishChild(child);
  }

  #orderRow(order: OrderInfo) {
    const { state } = order;
    return {
      ric: order.ric,
      side: order.side,
      ordType: order.ordType,
      timeInForce: order.timeInForce,
      quantity: state.quantity,
      price: state.price,
      status: state.status,
      cumQty: state.cumQty,
      leavesQty: state.leavesQty,
      avgPx: state.avgPx,
      lastQty: state.lastQty,
      lastPx: state.lastPx,
      account: order.account,
      currency: order.currency,
      rejectReason: state.rejectReason ?? "",
      text: state.text ?? "",
      created: order.created,
      lastUpdate: order.lastUpdate,
    };
  }

  #publishParent(parent: ParentOrder) {
    if (this.#journal) {
      this.#dirtyParents.add(parent);
      this.#markDirty();
    }
    this.#sink.parentOrder?.({
      orderId: parent.orderId,
      clOrdId: parent.clOrdId ?? "",
      trader: parent.trader,
      ...this.#orderRow(parent),
      version: parent.state.version,
      notional: parent.state.cumQty * parent.state.avgPx,
      ...executionQuality(parent),
      strategy: parent.strategy ?? AlgoStrategy.Dma,
      algoStart: parent.algo?.startAt ?? 0,
      algoEnd: parent.algo?.endAt ?? 0,
      participationPct: (parent.algo?.participation ?? 0) * 100,
      targetQty: parent.algo ? parent.algo.targetQty : parent.state.quantity,
      stopPrice: parent.stopPrice ?? 0,
      triggeredAt: parent.triggeredAt ?? 0,
    });
  }

  #publishChild(child: ChildOrder) {
    if (this.#journal) {
      this.#dirtyChildren.add(child);
      this.#markDirty();
    }
    this.#sink.childOrder?.({
      childOrderId: child.orderId,
      parentOrderId: child.parentOrderId,
      exchangeOrderId: child.exchangeOrderId ?? "",
      ...this.#orderRow(child),
    });
  }
}
