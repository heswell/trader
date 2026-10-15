import {
  type AmendOrderRequest,
  type CancelAllRequest,
  type CreateOrderRequest,
  canAmend,
  canCancel,
  ExecType,
  isTerminalStatus,
  isWorkingStatus,
  OrdStatus,
  OrdType,
  type OrderReject,
  positionKey,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
  validateAmend,
} from "@heswell/trading-schemas";
import type { ExecutionReport } from "@heswell/exchange-sim";
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
  childOrderId?: string;
}

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
}

/**
 * Transport-independent OMS core: pre-trade risk, 1:1 parent -> child routing
 * to the exchange gateway, execution report handling and positions.
 */
export class OmsEngine {
  readonly accounts = new Map<string, Account>();
  readonly parents = new Map<string, ParentOrder>();
  readonly children = new Map<string, ChildOrder>();
  readonly fills: Fill[] = [];
  readonly positions = new Map<string, Position>();
  readonly restricted: Set<string>;
  collarPct: number;

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
  #journal: OmsJournal | undefined;
  #dirtyParents = new Set<ParentOrder>();
  #dirtyChildren = new Set<ChildOrder>();
  #dirtyPositions = new Set<Position>();
  #newFills: Fill[] = [];
  #flushScheduled = false;

  constructor({
    gateway,
    accounts,
    clock = Date.now,
    sink = {},
    collarPct = 0.1,
    restrictedRics = [],
    log = (message) => console.warn(`[OMS] ${message}`),
  }: OmsEngineOptions) {
    this.#gateway = gateway;
    this.#clock = clock;
    this.#sink = sink;
    this.#log = log;
    this.collarPct = collarPct;
    this.restricted = new Set(restrictedRics);
    for (const account of accounts) {
      this.accounts.set(account.account, account);
      sink.account?.(account);
    }
    this.#unsubscribe = gateway.onExecutionReport(this.#onExecutionReport);
  }

  dispose() {
    this.#unsubscribe();
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
      this.children.set(child.orderId, child);
      this.#byClOrdId.set(child.orderId, child);
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
      this.positions.set(position.id, position);
      this.#sink.position?.({ ...position });
    }
    this.#dirtyParents.clear();
    this.#dirtyChildren.clear();
    this.#dirtyPositions.clear();
    this.#newFills = [];
  }

  /**
   * Apply an execution report outside the gateway subscription, e.g. one
   * replayed from the journal. Reports already applied to the child (exec
   * seq <= child.lastExecSeq) are ignored.
   */
  applyExecutionReport(report: ExecutionReport) {
    this.#onExecutionReport(report);
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
          this.#applyParent(parent, event);
        } catch (err) {
          if (!(err instanceof OrderStateError)) throw err;
          note(`${child.orderId} ${event.type} not applied: ${err.message}`);
        }
      };
      const { status } = child.state;
      if (!child.exchangeOrderId) {
        if (status === OrdStatus.PendingNew) {
          apply({ type: "reject", reason: RejectReason.InternalError, text: lost });
          result.resolved.push(child.orderId);
          note(`${child.orderId} was never acknowledged by the exchange: rejected`);
        }
        continue;
      }
      const exchange = view.getOrder(child.exchangeOrderId);
      if (status === OrdStatus.PendingReplace) {
        apply({ type: "replaceReject", reason: RejectReason.InternalError, text: lost });
        result.resolved.push(child.orderId);
      } else if (status === OrdStatus.PendingCancel) {
        apply({ type: "cancelReject", reason: RejectReason.InternalError, text: lost });
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
        apply({ type: "expired", text: "order not found at the exchange after restart" });
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
      used.add(request.clOrdId);
      this.#clOrdIdsByTrader.set(ctx.user, used);
    }

    const now = this.#clock();
    const timeInForce = request.timeInForce ?? TimeInForce.Day;
    const price = request.ordType === OrdType.Market ? 0 : (request.price ?? 0);
    const instrument = this.#gateway.getInstrument(request.ric);
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
    };
    this.parents.set(parent.orderId, parent);

    const riskReject = checkPreTradeRisk(
      { ...request, timeInForce },
      this.#riskContext(request.account, request.ric),
    );
    if (riskReject) {
      this.#applyParent(parent, { type: "reject", ...riskReject });
      return fail(riskReject.reason, riskReject.text, parent.orderId);
    }
    this.#publishParent(parent);

    const childOrderId = `${parent.orderId}-1`;
    const child: ChildOrder = {
      ...parent,
      orderId: childOrderId,
      parentOrderId: parent.orderId,
      clOrdId: childOrderId,
      exchangeClOrdId: childOrderId,
      requestSeq: 0,
    };
    parent.childOrderId = childOrderId;
    this.children.set(childOrderId, child);
    this.#byClOrdId.set(childOrderId, child);
    this.#publishChild(child);

    this.#gateway.submit({
      account: child.account,
      clOrdId: childOrderId,
      ric: child.ric,
      side: child.side,
      ordType: child.ordType,
      quantity: child.state.quantity,
      price: child.ordType === OrdType.Market ? undefined : child.state.price,
      timeInForce,
    });

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

  /** Resolve a parent + its child for an amend / cancel request. */
  #liveOrderFor(
    orderId: string,
    ctx: RequestContext,
    tooLate: RejectReason,
  ): OmsResult<{ parent: ParentOrder; child: ChildOrder }> {
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
    const quantity = request.quantity ?? parent.state.quantity;
    const price = request.price ?? parent.state.price;
    if (quantity === parent.state.quantity && price === parent.state.price) {
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
    const invalid =
      validateAmend(request, instrument, {
        ordType: parent.ordType,
        cumQty: parent.state.cumQty,
      }) ??
      checkPreTradeRisk(
        {
          account: parent.account,
          ric: parent.ric,
          side: parent.side,
          ordType: parent.ordType,
          timeInForce: parent.timeInForce,
          // Risk applies to what is still to trade; the filled part is already in the position.
          quantity: quantity - parent.state.cumQty || instrument.lotSize,
          price: parent.ordType === OrdType.Market ? undefined : price,
        },
        this.#riskContext(parent.account, parent.ric, parent.orderId),
      );
    if (invalid) return fail(invalid.reason, invalid.text, parent.orderId);

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
      Object.assign(position, markPosition(position, px), {
        lastUpdate: this.#clock(),
      });
      this.#sink.position?.({ ...position });
      changed++;
    }
    return changed;
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
    const position: Position = {
      id,
      account: fill.account,
      ric: fill.ric,
      currency: fill.currency,
      exchange: instrument?.exchange ?? "",
      sector: instrument?.sector ?? "",
      ...state,
      ...markPosition(state, markPx),
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
    const child =
      this.#byExchangeId.get(report.exchangeOrderId) ??
      this.#byClOrdId.get(report.clOrdId);
    if (!child) return;
    const execSeq = execSeqOf(report.execId);
    if (execSeq !== undefined) {
      if (child.lastExecSeq !== undefined && execSeq <= child.lastExecSeq)
        return;
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
      this.#applyParent(parent, event);
    } catch (err) {
      if (!(err instanceof OrderStateError)) throw err;
      this.#log(
        `${child.orderId} ${report.execType}/${report.ordStatus} ignored: ${err.message}`,
      );
      return;
    }
    if (event.type === "fill") this.#recordFill(report, parent, child);
  };

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
    for (const listener of this.#fillListeners) listener(fill);
  }

  // ---------------------------------------------------------------- state

  #applyParent(parent: ParentOrder, event: OrderEvent) {
    parent.state = reduceOrder(parent.state, event);
    parent.lastUpdate = this.#clock();
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
