import type {
  ExecutionReport,
  ExecutionReportListener,
  GatewayAmend,
  GatewayCancel,
  GatewayNewOrder,
  TopOfBook,
} from "@heswell/exchange-sim";
import type { TradingPhase } from "@heswell/trading-schemas";
import type { RiskInstrument } from "../risk/preTradeRisk";

/**
 * The part of exchange-sim's ExchangeGateway the OMS uses. submit's return
 * value is not relied on: orders are correlated by clOrdId, so a gateway may
 * deliver the ack asynchronously (see DelayedGateway).
 */
export interface OmsGateway {
  submit(order: GatewayNewOrder): unknown;
  amend(exchangeOrderId: string, amend: GatewayAmend): void;
  cancel(exchangeOrderId: string, cancel?: GatewayCancel): void;
  onExecutionReport(listener: ExecutionReportListener): () => void;
  getInstrument(ric: string): RiskInstrument | undefined;
  getPhase(ric: string): TradingPhase | undefined;
  getTopOfBook(ric: string): TopOfBook | undefined;
}

export type Scheduler = (fn: () => void, delayMs: number) => void;

/**
 * Adds a one-way latency to requests (OMS -> exchange) and execution reports
 * (exchange -> OMS) so that cancel / amend requests genuinely race fills.
 * Reference data / top of book are read directly.
 */
export class DelayedGateway implements OmsGateway {
  #listeners = new Set<ExecutionReportListener>();
  #unsubscribe: () => void;

  constructor(
    private inner: OmsGateway,
    private latencyMs: number,
    private schedule: Scheduler = (fn, ms) => {
      setTimeout(fn, ms);
    },
  ) {
    this.#unsubscribe = inner.onExecutionReport((report) =>
      this.schedule(() => {
        for (const listener of this.#listeners) listener(report);
      }, this.latencyMs),
    );
  }

  submit(order: GatewayNewOrder) {
    this.schedule(() => this.inner.submit(order), this.latencyMs);
    return undefined;
  }
  amend(exchangeOrderId: string, amend: GatewayAmend) {
    this.schedule(
      () => this.inner.amend(exchangeOrderId, amend),
      this.latencyMs,
    );
  }
  cancel(exchangeOrderId: string, cancel?: GatewayCancel) {
    this.schedule(
      () => this.inner.cancel(exchangeOrderId, cancel),
      this.latencyMs,
    );
  }
  onExecutionReport(listener: ExecutionReportListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  getInstrument(ric: string) {
    return this.inner.getInstrument(ric);
  }
  getPhase(ric: string) {
    return this.inner.getPhase(ric);
  }
  getTopOfBook(ric: string) {
    return this.inner.getTopOfBook(ric);
  }
  dispose() {
    this.#unsubscribe();
    this.#listeners.clear();
  }
}

/** Deterministic scheduler for tests: run() executes due tasks in time order. */
export class ManualScheduler {
  #tasks: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;
  constructor(public now = 0) {}

  readonly schedule: Scheduler = (fn, delayMs) => {
    this.#tasks.push({ at: this.now + delayMs, seq: this.#seq++, fn });
  };

  get pending() {
    return this.#tasks.length;
  }

  /** Advance time by ms, running every task that becomes due (including newly scheduled ones). */
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      this.#tasks.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#tasks[0];
      if (!next || next.at > until) break;
      this.#tasks.shift();
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }

  /** Run until no tasks are left. */
  drain(maxMs = 60_000) {
    this.advance(maxMs);
  }
}

export type { ExecutionReport };
