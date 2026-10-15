import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileStore,
  MemoryStore,
  type PersistenceStore,
  SqliteStore,
} from "@heswell/trading-persistence/server";
import {
  OrdStatus,
  OrdType,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import type { OmsJournalBatch } from "../src/engine/OmsEngine";
import {
  createTradingPersistence,
  loadPersistenceConfig,
} from "../src/persistence";
import { AAPL, BookSide, setup, VOD } from "./fixture";
import {
  bookOrders,
  boot,
  type Observed,
  observe,
  T0,
  trade,
} from "./persistenceFixture";

const stores: [
  string,
  () => { store: () => PersistenceStore; done(): void },
][] = [
  [
    "memory",
    () => {
      const store = new MemoryStore();
      return { store: () => store, done() {} };
    },
  ],
  [
    "file",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "trader-persist-"));
      return {
        store: () => new FileStore(dir),
        done: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    "sqlite",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "trader-persist-"));
      return {
        store: () => new SqliteStore(join(dir, "t.sqlite")),
        done: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
];

describe.each(stores)("restart (%s store)", (_name, make) => {
  test("graceful restart restores books, orders, fills, positions and ids", () => {
    const s = make();
    try {
      const a = boot(s.store());
      expect(a.report.restored).toBe(false);
      const ids = trade(a);
      expect(a.status(ids.partial)?.status).toBe(OrdStatus.PartiallyFilled);
      expect(a.status(ids.filled)?.status).toBe(OrdStatus.Filled);
      expect(a.status(ids.amended)?.quantity).toBe(80);
      expect(a.status(ids.cancelled)?.status).toBe(OrdStatus.Cancelled);
      const before = observe(a);
      expect(before.books[AAPL].bids).toHaveLength(1);
      expect(before.books[VOD].asks).toHaveLength(1);
      expect(before.tradeCount).toBe(2);
      a.persistence.close();

      const b = boot(s.store());
      expect(b.report.restored).toBe(true);
      expect(b.report.reconcile?.discrepancies).toEqual([]);
      expect(observe(b)).toEqual(before);
      expect(b.report.workingOrders).toBe(2);
      expect(b.report.fills).toBe(2);
      expect(b.engine.getPosition("ACC-US-01", AAPL)?.quantity).toBe(100);

      // Trading continues: the restored order fills, ids keep counting.
      b.rest(AAPL, BookSide.SELL, 171, 200);
      expect(b.status(ids.partial)?.status).toBe(OrdStatus.Filled);
      expect(b.engine.getPosition("ACC-US-01", AAPL)?.quantity).toBe(300);
      expect(b.sim.tradeCount).toBe(3);
      const execIds = b.engine.fills.map((f) => f.execId);
      expect(new Set(execIds).size).toBe(execIds.length);
      const next = b.create({ price: 165 });
      expect(Object.keys(before.oms)).toContain("orderSeq");
      expect(before.oms.parents.map((p) => p.orderId).includes(next)).toBe(
        false,
      );
      const exchangeIds = [...b.sim.gateway.liveOrders()].map(
        (r) => r.exchangeOrderId,
      );
      expect(new Set(exchangeIds).size).toBe(exchangeIds.length);
      b.persistence.close();
    } finally {
      s.done();
    }
  });

  test("crash (no shutdown snapshot) recovers from the journal", () => {
    const s = make();
    try {
      const a = boot(s.store());
      trade(a);
      a.engine.flushJournal();
      const before = observe(a);
      // No close(): the process dies, the store is only what was journaled.
      a.persistence.stop();
      a.sim.setJournal(undefined);
      a.engine.setJournal(undefined);
      // Release the lock as the OS would for a dead process.
      a.persistence.store.close();
      const b = boot(s.store());
      expect(b.report.journalEntries).toBeGreaterThan(0);
      expect(b.report.reconcile?.discrepancies).toEqual([]);
      // Trade ids are reserved in blocks: after a crash they skip ahead
      // (never reused).
      const after = observe(b);
      expect(after.tradeCount).toBeGreaterThan(before.tradeCount);
      expect({ ...after, tradeCount: before.tradeCount }).toEqual(before);
      b.persistence.close();
    } finally {
      s.done();
    }
  });
});

describe("recovery", () => {
  test("OMS updates lost after the exchange journaled a fill are rebuilt from exec reports", () => {
    const store = new MemoryStore();
    const a = boot(store);
    a.rest(AAPL, BookSide.SELL, 171, 100);
    // The OMS batch is flushed by a microtask; dying before it runs loses
    // the OMS side of this fill but not the exchange's report.
    const id = a.create({ quantity: 300, price: 171 });
    const expected = observe(a);
    const journaledFills = store
      .load()
      .entries.flatMap((e) =>
        e.stream === "oms" ? ((e.data as OmsJournalBatch).fills ?? []) : [],
      );
    expect(journaledFills).toEqual([]);
    const b = boot(store);
    expect(b.status(id)?.status).toBe(OrdStatus.PartiallyFilled);
    expect(b.status(id)?.cumQty).toBe(100);
    expect(b.engine.fills).toHaveLength(1);
    expect(b.engine.getPosition("ACC-US-01", AAPL)?.quantity).toBe(100);
    expect(observe(b).books).toEqual(expected.books);
    expect(b.report.reconcile?.discrepancies).toEqual([]);
  });

  test("replaying already-applied reports is idempotent", () => {
    const store = new MemoryStore();
    const a = boot(store);
    trade(a);
    a.engine.flushJournal();
    const before = a.engine.exportState();
    for (const entry of store.load().entries) {
      const data = entry.data as { k?: string; r?: never };
      if (entry.stream === "exchange" && data.k === "report" && data.r)
        a.engine.applyExecutionReport(data.r);
    }
    expect(a.engine.exportState()).toEqual(before);
  });

  test("a request lost in the gateway is resolved by reconcile", () => {
    const store = new MemoryStore();
    const a = boot(store, { latencyMs: 5 });
    const working = a.create({ price: 160 });
    a.scheduler.advance(10);
    expect(a.status(working)?.status).toBe(OrdStatus.New);
    const lost = a.create({ price: 161 });
    const cancel = a.engine.cancelOrder({ orderId: working }, a.ctx);
    expect(cancel.ok).toBe(true);
    // Crash with the new order and the cancel still in the DelayedGateway.
    a.engine.flushJournal();
    const b = boot(store, { latencyMs: 5 });
    expect(b.status(lost)?.status).toBe(OrdStatus.Rejected);
    expect(b.status(working)?.status).toBe(OrdStatus.New);
    expect(b.report.reconcile?.resolved.length).toBe(2);
    expect(bookOrders(b, AAPL).bids).toHaveLength(1);
  });

  test("orphan exchange orders (no OMS order) are expired", () => {
    const store = new MemoryStore();
    const a = boot(store);
    const exchangeOrderId = a.sim.gateway.submit({
      clOrdId: "foreign-1",
      account: "ACC-US-01",
      ric: AAPL,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: 10,
      price: 150,
      timeInForce: TimeInForce.Day,
    });
    a.persistence.close();
    const b = boot(store);
    expect(b.report.reconcile?.orphans).toEqual([exchangeOrderId]);
    expect(b.report.expiredExchangeOrders).toEqual([exchangeOrderId]);
    expect(b.sim.gateway.getOrder(exchangeOrderId)?.ordStatus).toBe(
      OrdStatus.Expired,
    );
    expect(bookOrders(b, AAPL).bids).toEqual([]);
  });

  test("DAY orders expire when a close passed while the server was down", () => {
    const session = { sessionDayMs: 24_000 };
    const store = new MemoryStore();
    const a = boot(store, { simConfig: session });
    // Find the open.
    while (a.sim.marketPhase !== "CONTINUOUS") a.clock.advance(100);
    const day = a.create({ price: 160 });
    const gtc = a.create({
      price: 159,
      timeInForce: TimeInForce.GoodTillCancel,
    });
    a.persistence.close();

    // Restart before the close: nothing expires.
    const b = boot(store, { simConfig: session, time: a.clock.time + 10 });
    expect(b.status(day)?.status).toBe(OrdStatus.New);
    expect(b.report.dayExpired).toEqual([]);
    b.persistence.close();

    // Restart a (simulated) day later: the close passed.
    const c = boot(store, {
      simConfig: session,
      time: b.clock.time + 24_000,
    });
    expect(c.status(day)?.status).toBe(OrdStatus.Expired);
    expect(c.status(gtc)?.status).toBe(OrdStatus.New);
    expect(c.report.dayExpired).toHaveLength(1);
    expect(
      bookOrders(c, AAPL).bids.map((o: string) => o.split(" ")[1]),
    ).toEqual(["100@159"]);
  });

  test("session phase and admin settings survive a restart", () => {
    const store = new MemoryStore();
    const a = boot(store);
    a.sim.haltInstrument(VOD, "news");
    a.sim.setVolatility(AAPL, 0.5);
    a.persistence.close();
    const b = boot(store);
    expect(b.sim.sessionStatus().phase).toBe(a.sim.sessionStatus().phase);
    expect(b.sim.getBook(VOD)?.phase).toBe("HALTED");
    expect(b.sim.getBook(AAPL)?.model.volatility).toBe(0.5);
  });

  test("a periodic snapshot compacts the journal", () => {
    const store = new MemoryStore();
    const a = boot(store);
    trade(a);
    a.engine.flushJournal();
    expect(store.entriesSinceSnapshot).toBeGreaterThan(0);
    a.persistence.snapshot();
    expect(store.entriesSinceSnapshot).toBe(0);
    const before = observe(a);
    const b = boot(store);
    expect(observe(b)).toEqual(before);
  });
});

describe("kill -9", () => {
  test("a SIGKILLed server recovers from its file journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trader-persist-"));
    try {
      const child = Bun.spawn(
        ["bun", join(import.meta.dir, "crashChild.ts"), dir],
        { stdout: "pipe", stderr: "inherit" },
      );
      const reader = child.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const before: Observed = JSON.parse(out);
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);
      expect(child.signalCode).toBe("SIGKILL");

      // The dead child's LOCK is taken over.
      const b = boot(new FileStore(dir));
      expect(b.report.restored).toBe(true);
      expect(b.report.snapshotSeq).toBeDefined();
      expect(b.report.journalEntries).toBeGreaterThan(0);
      expect(b.report.reconcile?.discrepancies).toEqual([]);
      const after = observe(b);
      expect(after.tradeCount).toBeGreaterThan(before.tradeCount);
      expect({ ...after, tradeCount: before.tradeCount }).toEqual(before);
      b.persistence.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config", () => {
  test("defaults, conf and env (env wins)", () => {
    expect(loadPersistenceConfig(undefined, {}).store).toBe("memory");
    const conf = {
      has: (k: string) =>
        k === "persistence.store" || k === "persistence.fsync",
      getString: () => "file",
      getNumber: () => 1,
    };
    const fromConf = loadPersistenceConfig(conf, {});
    expect(fromConf.store).toBe("file");
    expect(fromConf.fsync).toBe(1);
    const fromEnv = loadPersistenceConfig(conf, {
      TRADER_PERSISTENCE_STORE: "sqlite",
      TRADER_DATA_DIR: "/tmp/x",
      PERSISTENCE_SNAPSHOT_INTERVAL_MS: "0",
      TRADER_PERSISTENCE_RESET: "true",
    });
    expect(fromEnv).toMatchObject({
      store: "sqlite",
      dir: "/tmp/x",
      snapshotIntervalMs: 0,
      reset: 1,
    });
    expect(() =>
      loadPersistenceConfig(undefined, { PERSISTENCE_STORE: "x" }),
    ).toThrow();
  });

  test("reset clears the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "trader-persist-"));
    try {
      const make = (reset: number) => {
        const env = setup({ time: T0 });
        const persistence = createTradingPersistence({
          config: loadPersistenceConfig(
            undefined,
            {},
            { store: "file", dir, reset },
          ),
          sim: env.sim,
          engine: env.engine,
          log: () => {},
        });
        return { env, persistence, report: persistence.recover() };
      };
      const a = make(0);
      a.env.create({ price: 160 });
      a.persistence.close();
      const b = make(0);
      expect(b.report.restored).toBe(true);
      b.persistence.close();
      const c = make(1);
      expect(c.report.restored).toBe(false);
      expect(c.env.engine.parents.size).toBe(0);
      c.persistence.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
