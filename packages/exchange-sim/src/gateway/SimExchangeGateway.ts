import type { Trade } from "@heswell/hft-limit-order-book";
import { TimeInForce as BookTif } from "@heswell/hft-limit-order-book";
import {
  ExecType,
  Liquidity,
  OrdStatus,
  OrdType,
  RejectReason,
  TimeInForce,
  TradingPhase,
  validateAmend,
  validateOrder,
  workingStatusFor,
} from "@heswell/trading-schemas";
import {
  type FillSink,
  type InstrumentBook,
  toBookSide,
} from "../engine/InstrumentBook";
import type { InstrumentDef } from "../reference/instruments";
import type { Clock } from "../util/clock";
import type {
  ExchangeGateway,
  ExecutionReport,
  ExecutionReportListener,
  GatewayAmend,
  GatewayCancel,
  GatewayNewOrder,
  GatewayRequestType,
  TopOfBook,
} from "./types";

export const GATEWAY_OWNER = "gateway";

/** What the gateway needs from the simulator. */
export interface GatewayVenue {
  clock: Clock;
  getInstrument(ric: string): InstrumentDef | undefined;
  getBook(ric: string): InstrumentBook | undefined;
}

interface OrderState {
  report: ExecutionReport;
  book?: InstrumentBook;
  live: boolean;
  amended: boolean;
  notional: number;
}

const TERMINAL: ReadonlySet<string> = new Set([
  OrdStatus.Filled,
  OrdStatus.Cancelled,
  OrdStatus.Rejected,
  OrdStatus.Expired,
]);

export class SimExchangeGateway implements ExchangeGateway, FillSink {
  readonly #orders = new Map<string, OrderState>();
  readonly #clOrdIds = new Set<string>();
  readonly #listeners = new Set<ExecutionReportListener>();
  readonly #queue: ExecutionReport[] = [];
  #hold = 0;
  #draining = false;
  #orderSeq = 0;
  #execSeq = 0;

  constructor(private readonly venue: GatewayVenue) {}

  onExecutionReport(listener: ExecutionReportListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getInstrument(ric: string) {
    return this.venue.getInstrument(ric);
  }

  isSimulated(ric: string) {
    return this.venue.getBook(ric) !== undefined;
  }

  getPhase(ric: string) {
    if (!this.venue.getInstrument(ric)) return undefined;
    return this.venue.getBook(ric)?.phase ?? TradingPhase.Closed;
  }

  getTopOfBook(ric: string): TopOfBook | undefined {
    const book = this.venue.getBook(ric);
    if (!book) return undefined;
    return {
      ric,
      ...book.topOfBook(),
      last: book.stats.last,
      phase: book.phase,
      seq: book.seq,
    };
  }

  getOrder(exchangeOrderId: string) {
    const state = this.#orders.get(exchangeOrderId);
    return state ? { ...state.report } : undefined;
  }

  submit(order: GatewayNewOrder): string {
    const exchangeOrderId = `X${++this.#orderSeq}`;
    this.#hold++;
    try {
      this.#submit(exchangeOrderId, order);
    } finally {
      this.#release();
    }
    return exchangeOrderId;
  }

  amend(exchangeOrderId: string, amend: GatewayAmend) {
    this.#hold++;
    try {
      this.#amend(exchangeOrderId, amend);
    } finally {
      this.#release();
    }
  }

  cancel(exchangeOrderId: string, cancel: GatewayCancel = {}) {
    this.#hold++;
    try {
      this.#cancel(exchangeOrderId, cancel);
    } finally {
      this.#release();
    }
  }

  // ---------------------------------------------------------------- requests

  #submit(exchangeOrderId: string, order: GatewayNewOrder) {
    const timeInForce = order.timeInForce ?? TimeInForce.Day;
    const report: ExecutionReport = {
      execId: "",
      execType: ExecType.New,
      ordStatus: OrdStatus.New,
      responseTo: "NEW",
      clOrdId: order.clOrdId ?? "",
      exchangeOrderId,
      account: order.account ?? "",
      ric: order.ric,
      side: order.side,
      ordType: order.ordType,
      timeInForce,
      quantity: order.quantity,
      price: order.ordType === OrdType.Market ? 0 : (order.price ?? 0),
      lastQty: 0,
      lastPx: 0,
      cumQty: 0,
      leavesQty: order.quantity,
      avgPx: 0,
      timestamp: 0,
    };
    const state: OrderState = {
      report,
      live: false,
      amended: false,
      notional: 0,
    };
    this.#orders.set(exchangeOrderId, state);

    const rejectNew = (reason: RejectReason, text: string) => {
      report.leavesQty = 0;
      this.#emit(state, ExecType.Rejected, OrdStatus.Rejected, "NEW", {
        rejectReason: reason,
        text,
      });
    };

    if (!order.account || !order.clOrdId) {
      return rejectNew(
        RejectReason.InvalidRequest,
        "account and clOrdId are required",
      );
    }
    const clOrdKey = `${order.account}\u0000${order.clOrdId}`;
    if (this.#clOrdIds.has(clOrdKey)) {
      return rejectNew(
        RejectReason.DuplicateClOrdId,
        `duplicate clOrdId ${order.clOrdId}`,
      );
    }
    this.#clOrdIds.add(clOrdKey);
    const instrument = this.venue.getInstrument(order.ric);
    if (!instrument) {
      return rejectNew(
        RejectReason.UnknownInstrument,
        `unknown instrument ${order.ric}`,
      );
    }
    const book = this.venue.getBook(order.ric);
    const invalid = validateOrder(
      { ...order, timeInForce },
      instrument,
      book?.phase ?? TradingPhase.Closed,
    );
    if (invalid) return rejectNew(invalid.reason, invalid.text);
    if (!book) {
      return rejectNew(RejectReason.MarketClosed, `${order.ric} is closed`);
    }
    if (
      order.ordType === OrdType.Limit &&
      !book.model.isWithinBand(order.price as number)
    ) {
      return rejectNew(
        RejectReason.PriceOutsideCollar,
        `price ${order.price} outside [${book.model.lowerBand}, ${book.model.upperBand}]`,
      );
    }

    state.book = book;
    state.live = true;
    this.#emit(state, ExecType.New, OrdStatus.New, "NEW");

    const side = toBookSide(order.side);
    const base = {
      id: exchangeOrderId,
      side,
      size: order.quantity,
      accountId: order.account,
      owner: GATEWAY_OWNER,
      meta: order.clOrdId,
    };
    if (order.ordType === OrdType.Market) {
      if (
        timeInForce === TimeInForce.FillOrKill &&
        book.book.calculateMarketPrice(side, order.quantity).err
      ) {
        return this.#expire(
          state,
          RejectReason.FokNotFillable,
          "FOK not fillable",
        );
      }
      book.market(base, this);
      if (state.report.leavesQty > 0) {
        this.#expire(
          state,
          RejectReason.NoLiquidity,
          "market order remainder expired",
        );
      }
      return;
    }

    const bookTif =
      timeInForce === TimeInForce.ImmediateOrCancel
        ? BookTif.IOC
        : timeInForce === TimeInForce.FillOrKill
          ? BookTif.FOK
          : BookTif.GTC;
    const result = book.limit(
      { ...base, price: order.price as number, timeInForce: bookTif },
      this,
    );
    if (result.err) {
      const fok = timeInForce === TimeInForce.FillOrKill;
      return this.#expire(
        state,
        fok ? RejectReason.FokNotFillable : RejectReason.InternalError,
        fok ? "FOK not fillable" : result.err.message,
      );
    }
    if (state.live && book.book.order(exchangeOrderId) === undefined) {
      this.#expire(state, undefined, "IOC remainder expired");
    }
  }

  #amend(exchangeOrderId: string, amend: GatewayAmend) {
    const state = this.#orders.get(exchangeOrderId);
    if (!state)
      return this.#rejectUnknown(exchangeOrderId, "AMEND", amend.clOrdId);
    const { report, book } = state;
    const reject = (reason: RejectReason, text: string) =>
      this.#emit(state, ExecType.Rejected, report.ordStatus, "AMEND", {
        rejectReason: reason,
        text,
        clOrdId: amend.clOrdId ?? report.clOrdId,
      });
    if (!state.live || !book) {
      return reject(
        RejectReason.TooLateToAmend,
        `order is ${report.ordStatus}`,
      );
    }
    if (amend.quantity === undefined && amend.price === undefined) {
      return reject(
        RejectReason.InvalidRequest,
        "one of quantity or price is required",
      );
    }
    if (book.isHalted) {
      return reject(RejectReason.InstrumentHalted, `${report.ric} is halted`);
    }
    const invalid = validateAmend(amend, book.instrument, {
      ordType: report.ordType,
      cumQty: report.cumQty,
    });
    if (invalid) return reject(invalid.reason, invalid.text);
    if (amend.price !== undefined && !book.model.isWithinBand(amend.price)) {
      return reject(
        RejectReason.PriceOutsideCollar,
        `price ${amend.price} outside [${book.model.lowerBand}, ${book.model.upperBand}]`,
      );
    }
    const quantity = amend.quantity ?? report.quantity;
    const price = amend.price ?? report.price;
    report.quantity = quantity;
    report.price = price;
    report.leavesQty = quantity - report.cumQty;
    if (amend.clOrdId) report.clOrdId = amend.clOrdId;
    state.amended = true;
    if (report.leavesQty <= 0) {
      book.cancel(exchangeOrderId);
      state.live = false;
      return this.#emit(state, ExecType.Replaced, OrdStatus.Filled, "AMEND");
    }
    const resting = book.book.order(exchangeOrderId);
    const priorityKept =
      resting !== undefined &&
      price === resting.price &&
      report.leavesQty <= resting.size;
    this.#emit(
      state,
      ExecType.Replaced,
      workingStatusFor(report.cumQty, true),
      "AMEND",
      { priorityKept },
    );
    book.modify(exchangeOrderId, { price, size: report.leavesQty });
  }

  #cancel(exchangeOrderId: string, cancel: GatewayCancel) {
    const state = this.#orders.get(exchangeOrderId);
    if (!state) {
      return this.#rejectUnknown(exchangeOrderId, "CANCEL", cancel.clOrdId);
    }
    const { report, book } = state;
    if (!state.live || !book || !book.cancel(exchangeOrderId)) {
      return this.#emit(state, ExecType.Rejected, report.ordStatus, "CANCEL", {
        rejectReason: RejectReason.TooLateToCancel,
        text: `order is ${report.ordStatus}`,
        clOrdId: cancel.clOrdId ?? report.clOrdId,
      });
    }
    if (cancel.clOrdId) report.clOrdId = cancel.clOrdId;
    state.live = false;
    report.leavesQty = 0;
    this.#emit(state, ExecType.Cancelled, OrdStatus.Cancelled, "CANCEL");
  }

  // ---------------------------------------------------------------- fills

  onFill(orderId: string, trade: Trade, isMaker: boolean, tradeId: string) {
    const state = this.#orders.get(orderId);
    if (!state?.live) return;
    const { report } = state;
    report.cumQty += trade.size;
    report.leavesQty = Math.max(0, report.quantity - report.cumQty);
    state.notional += trade.price * trade.size;
    report.avgPx = state.notional / report.cumQty;
    const filled = report.leavesQty === 0;
    if (filled) state.live = false;
    this.#emit(
      state,
      ExecType.Trade,
      filled ? OrdStatus.Filled : OrdStatus.PartiallyFilled,
      undefined,
      {
        lastQty: trade.size,
        lastPx: trade.price,
        tradeId,
        liquidity: isMaker ? Liquidity.Added : Liquidity.Removed,
      },
    );
  }

  // ---------------------------------------------------------------- helpers

  #expire(state: OrderState, reason: RejectReason | undefined, text: string) {
    state.live = false;
    state.report.leavesQty = 0;
    this.#emit(state, ExecType.Expired, OrdStatus.Expired, undefined, {
      rejectReason: reason,
      text,
    });
  }

  #rejectUnknown(
    exchangeOrderId: string,
    responseTo: GatewayRequestType,
    clOrdId = "",
  ) {
    this.#enqueue({
      execId: this.#nextExecId(),
      execType: ExecType.Rejected,
      ordStatus: OrdStatus.Rejected,
      responseTo,
      clOrdId,
      exchangeOrderId,
      account: "",
      ric: "",
      side: "BUY",
      ordType: OrdType.Limit,
      timeInForce: TimeInForce.Day,
      quantity: 0,
      price: 0,
      lastQty: 0,
      lastPx: 0,
      cumQty: 0,
      leavesQty: 0,
      avgPx: 0,
      rejectReason:
        responseTo === "CANCEL"
          ? RejectReason.TooLateToCancel
          : RejectReason.UnknownOrder,
      text: `unknown order ${exchangeOrderId}`,
      timestamp: this.venue.clock(),
    });
  }

  #emit(
    state: OrderState,
    execType: ExecType,
    ordStatus: OrdStatus,
    responseTo: GatewayRequestType | undefined,
    extra: Partial<ExecutionReport> = {},
  ) {
    const { report } = state;
    // A rejected amend/cancel doesn't change the order; only persist real transitions.
    const persistent = execType !== ExecType.Rejected || responseTo === "NEW";
    const out: ExecutionReport = {
      ...report,
      lastQty: 0,
      lastPx: 0,
      tradeId: undefined,
      liquidity: undefined,
      rejectReason: undefined,
      text: undefined,
      priorityKept: undefined,
      ...extra,
      execId: this.#nextExecId(),
      execType,
      ordStatus,
      responseTo,
      timestamp: this.venue.clock(),
    };
    for (const key of Object.keys(out) as (keyof ExecutionReport)[]) {
      if (out[key] === undefined) delete out[key];
    }
    if (persistent) {
      state.report = { ...out };
      if (TERMINAL.has(ordStatus)) state.live = false;
    }
    this.#enqueue(out);
  }

  #nextExecId() {
    return `E${++this.#execSeq}`;
  }

  #enqueue(report: ExecutionReport) {
    this.#queue.push(report);
    if (this.#hold === 0) this.#drain();
  }

  #release() {
    this.#hold--;
    if (this.#hold === 0) this.#drain();
  }

  #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const queue = this.#queue;
      for (let i = 0; i < queue.length; i++) {
        for (const listener of this.#listeners) listener(queue[i]);
      }
      queue.length = 0;
    } finally {
      this.#draining = false;
    }
  }
}
