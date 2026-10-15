import type {
  ExchangeJournalEntry,
  ExchangeSimulator,
  ExchangeState,
  ExecutionReport,
} from "@heswell/exchange-sim/engine";
import type { PersistenceStore } from "@heswell/trading-persistence";
import type {
  OmsEngine,
  OmsJournalBatch,
  OmsState,
  ReconcileResult,
} from "../engine/OmsEngine";

export const EXCHANGE_STREAM = "exchange";
export const OMS_STREAM = "oms";
/** Recent gateway reports kept in each snapshot (see `recover`). */
export const RECENT_REPORTS = 2_000;

interface Meta {
  version: 1;
  /** Clock time of the snapshot. */
  savedAt: number;
}

/** What a snapshot holds, per stream. */
export interface TradingSnapshot {
  meta: Meta;
  exchange: ExchangeState;
  oms: OmsState;
  /**
   * The last gateway reports (oldest first). Replayed into the OMS on
   * recovery so reports still in flight (gateway latency) when the snapshot
   * was taken are not lost; already-applied ones are skipped.
   */
  reports: ExecutionReport[];
}

export interface RecoveryReport {
  /** False when the store was empty (fresh start). */
  restored: boolean;
  store: string;
  snapshotSeq?: number;
  journalEntries: number;
  warnings: string[];
  /** When the state was last persisted (snapshot or last journal entry). */
  lastActiveAt?: number;
  workingOrders: number;
  restoredBookOrders: number;
  fills: number;
  positions: number;
  tradeSeq: number;
  reconcile?: ReconcileResult;
  /** Exchange orders expired: instrument gone, orphans, DAY expiry across a close. */
  expiredExchangeOrders: string[];
  /** DAY orders expired because a market close passed while down. */
  dayExpired: string[];
}

export interface TradingPersistenceOptions {
  store: PersistenceStore;
  sim: ExchangeSimulator;
  engine: OmsEngine;
  /** Periodic snapshot interval (ms); 0 = only on demand / shutdown. */
  snapshotIntervalMs?: number;
  /** Snapshot once this many journal entries accumulate; 0 = off. */
  snapshotEveryEntries?: number;
  /** Expire live exchange orders with no OMS owner after a restore (default true). */
  cancelOrphans?: boolean;
  log?: (message: string) => void;
}

const emptyOmsState = (): OmsState => ({
  version: 1,
  orderSeq: 0,
  parents: [],
  children: [],
  fills: [],
  positions: [],
});

/** Fold OMS journal batches (row upserts, fills keyed by execId) into a state. */
export const applyOmsBatches = (
  base: OmsState,
  batches: readonly OmsJournalBatch[],
): OmsState => {
  const parents = new Map(base.parents.map((p) => [p.orderId, p]));
  const children = new Map(base.children.map((c) => [c.orderId, c]));
  const positions = new Map(base.positions.map((p) => [p.id, p]));
  const fills = [...base.fills];
  const execIds = new Set(fills.map((f) => f.execId));
  let { orderSeq } = base;
  for (const batch of batches) {
    orderSeq = Math.max(orderSeq, batch.orderSeq);
    for (const p of batch.parents ?? []) parents.set(p.orderId, p);
    for (const c of batch.children ?? []) children.set(c.orderId, c);
    for (const p of batch.positions ?? []) positions.set(p.id, p);
    for (const f of batch.fills ?? []) {
      if (execIds.has(f.execId)) continue;
      execIds.add(f.execId);
      fills.push(f);
    }
  }
  return {
    version: 1,
    orderSeq,
    parents: [...parents.values()],
    children: [...children.values()],
    fills,
    positions: [...positions.values()],
  };
};

/**
 * Makes the exchange simulator and the OMS durable through one store: a
 * single write-ahead journal (streams "exchange" and "oms", interleaved in
 * causal order) plus periodic snapshots of both. See docs/persistence.md.
 *
 * Lifecycle: `recover()` once, before tables attach / timers start; then
 * `start()` for periodic snapshots; `close()` on shutdown (final snapshot).
 */
export class TradingPersistence {
  readonly store: PersistenceStore;
  readonly sim: ExchangeSimulator;
  readonly engine: OmsEngine;
  readonly #options: TradingPersistenceOptions;
  readonly #log: (message: string) => void;
  #recent: ExecutionReport[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #pendingSnapshot: ReturnType<typeof setTimeout> | undefined;
  #attached = false;
  #closed = false;
  /** Snapshots written (for tests / logs). */
  snapshots = 0;

  constructor(options: TradingPersistenceOptions) {
    this.#options = options;
    this.store = options.store;
    this.sim = options.sim;
    this.engine = options.engine;
    this.#log = options.log ?? ((m) => console.info(`[persistence] ${m}`));
  }

  /**
   * Load the store and rebuild both sides, then:
   * 1. replay gateway reports (snapshot `reports` + journal) into the OMS;
   *    each child skips reports it already applied (`lastExecSeq`), so a
   *    crash between the exchange journaling a report and the OMS journaling
   *    its effect is repaired;
   * 2. `OmsEngine.reconcile`: resolve requests lost in the restart, expire
   *    working orders the exchange no longer has, log discrepancies;
   * 3. expire orphan exchange orders (no OMS owner) and live orders on
   *    instruments no longer simulated;
   * 4. catch up the trading session (DAY orders expire if a close passed);
   * 5. snapshot, so the next start begins from a compact store.
   */
  recover(): RecoveryReport {
    const { store, sim, engine } = this;
    const loaded = store.load();
    for (const warning of loaded.warnings) this.#log(`warning: ${warning}`);
    const data = loaded.snapshot?.data as Partial<TradingSnapshot> | undefined;
    const exchangeEntries: ExchangeJournalEntry[] = [];
    const omsBatches: OmsJournalBatch[] = [];
    let lastActiveAt = loaded.snapshot?.ts;
    for (const entry of loaded.entries) {
      lastActiveAt = Math.max(lastActiveAt ?? 0, entry.ts);
      if (entry.stream === EXCHANGE_STREAM)
        exchangeEntries.push(entry.data as ExchangeJournalEntry);
      else if (entry.stream === OMS_STREAM)
        omsBatches.push(entry.data as OmsJournalBatch);
      else this.#log(`warning: ignored entry of unknown stream ${entry.stream}`);
    }
    const restored = data !== undefined || loaded.entries.length > 0;
    const report: RecoveryReport = {
      restored,
      store: `${store.kind}:${store.location}`,
      snapshotSeq: loaded.snapshot?.seq,
      journalEntries: loaded.entries.length,
      warnings: loaded.warnings,
      lastActiveAt,
      workingOrders: 0,
      restoredBookOrders: 0,
      fills: 0,
      positions: 0,
      tradeSeq: sim.tradeCount,
      expiredExchangeOrders: [],
      dayExpired: [],
    };
    if (!restored) {
      this.#attach();
      this.snapshot();
      this.#log(`no persisted state in ${report.store}: fresh start`);
      return report;
    }

    const exchange = sim.restoreState(data?.exchange, exchangeEntries);
    engine.restoreState(
      applyOmsBatches(data?.oms ?? emptyOmsState(), omsBatches),
    );
    const reports = [
      ...(data?.reports ?? []),
      ...exchangeEntries.flatMap((e) => (e.k === "report" ? [e.r] : [])),
    ];
    for (const r of reports) engine.applyExecutionReport(r);
    this.#recent = reports.slice(-RECENT_REPORTS);

    this.#attach();
    const expire = (id: string, text: string) => {
      if (sim.gateway.expireOrder(id, text))
        report.expiredExchangeOrders.push(id);
    };
    for (const id of exchange.droppedOrders) {
      this.#log(`exchange order ${id}: instrument not simulated, expired`);
      expire(id, "instrument not available after restart");
    }
    report.reconcile = engine.reconcile({
      getOrder: (id) => sim.gateway.getOrder(id),
      liveOrders: () => sim.gateway.liveOrders(),
    });
    if (this.#options.cancelOrphans ?? true) {
      for (const id of report.reconcile.orphans)
        expire(id, "no OMS order after restart");
    }
    if (lastActiveAt !== undefined) {
      report.dayExpired = sim.catchUpSession(lastActiveAt);
      report.expiredExchangeOrders.push(...report.dayExpired);
    }
    engine.flushJournal();
    this.snapshot();

    report.workingOrders = engine.liveOrders().length;
    report.restoredBookOrders = exchange.restoredOrders;
    report.fills = engine.fills.length;
    report.positions = engine.positions.size;
    report.tradeSeq = sim.tradeCount;
    this.#log(
      `restored from ${report.store}: snapshot seq ${report.snapshotSeq ?? "-"}, ${report.journalEntries} journal entries, ` +
        `${report.workingOrders} working orders, ${report.restoredBookOrders} resting at the exchange, ` +
        `${report.fills} fills, ${report.positions} positions, last trade id ${report.tradeSeq}, ` +
        `${report.reconcile.discrepancies.length} discrepancies, ${report.expiredExchangeOrders.length} exchange orders expired`,
    );
    return report;
  }

  #attach() {
    if (this.#attached) return;
    this.#attached = true;
    const { store, sim, engine } = this;
    const every = this.#options.snapshotEveryEntries ?? 0;
    const appended = () => {
      if (every > 0 && store.entriesSinceSnapshot >= every)
        this.#scheduleSnapshot();
    };
    engine.setJournal((batch) => {
      store.append(OMS_STREAM, batch, sim.clock());
      appended();
    });
    sim.setJournal((entry) => {
      // OMS changes made before this exchange event go first (causal order).
      engine.flushJournal();
      store.append(EXCHANGE_STREAM, entry, sim.clock());
      if (entry.k === "report") {
        this.#recent.push(entry.r);
        if (this.#recent.length > RECENT_REPORTS * 2)
          this.#recent = this.#recent.slice(-RECENT_REPORTS);
      }
      appended();
    });
  }

  #scheduleSnapshot() {
    // Never mid-operation: wait for the current tick to finish.
    if (this.#pendingSnapshot || this.#closed) return;
    this.#pendingSnapshot = setTimeout(() => {
      this.#pendingSnapshot = undefined;
      this.snapshot();
    }, 0);
  }

  /** Start periodic snapshots. */
  start() {
    const interval = this.#options.snapshotIntervalMs ?? 0;
    if (this.#timer || interval <= 0) return;
    this.#timer = setInterval(() => this.snapshot(), interval);
    this.#timer.unref?.();
  }

  /**
   * Snapshot both sides now (synchronously, so they are mutually
   * consistent) and compact the journal. Must not be called from inside an
   * exchange / OMS operation.
   */
  snapshot() {
    if (this.#closed) return;
    const { store, sim, engine } = this;
    engine.flushJournal();
    const now = sim.clock();
    const snapshot: TradingSnapshot = {
      meta: { version: 1, savedAt: now },
      exchange: sim.exportState(),
      oms: engine.exportState(),
      reports: this.#recent.slice(-RECENT_REPORTS),
    };
    store.snapshot(snapshot as unknown as Record<string, unknown>, now);
    this.snapshots++;
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#pendingSnapshot);
    this.#timer = undefined;
    this.#pendingSnapshot = undefined;
  }

  /** Graceful shutdown: final snapshot, detach the hooks, close the store. */
  close() {
    if (this.#closed) return;
    this.stop();
    try {
      this.snapshot();
    } finally {
      this.#closed = true;
      this.sim.setJournal(undefined);
      this.engine.setJournal(undefined);
      this.store.close();
    }
  }
}
