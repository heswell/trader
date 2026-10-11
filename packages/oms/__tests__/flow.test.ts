import { describe, expect, test } from "bun:test";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import { isTerminalStatus, OrdStatus } from "@heswell/trading-schemas";
import { createOms } from "../src/engine/OmsService";
import { SEED_ACCOUNTS } from "../src/reference/accounts";

/** Run the real simulator (bots on) + OMS background flow for `seconds`. */
const run = (seconds: number, config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { activeInstruments: 6, seed: 3, mmRate: 20, takerRate: 2 },
  });
  const log: string[] = [];
  const oms = createOms(sim.gateway, {
    config: { flowRate: 5, seed: 11, ...config },
    rics: () => sim.books.map((b) => b.ric),
    clock: clock.now,
    log: (m) => log.push(m),
  });
  // let market makers build books before the flow starts
  for (let t = 0; t < 2_000; t += 20) {
    clock.advance(20);
    sim.step();
  }
  for (let t = 0; t < seconds * 1000; t += 100) {
    clock.advance(100);
    sim.step();
    oms.flow.step(100);
    if (t % 500 === 0) oms.engine.markToMarket();
  }
  return { sim, oms, log };
};

describe("BackgroundFlow", () => {
  test("submits through the OMS at roughly the configured rate", () => {
    const { oms, log } = run(60);
    const { flow, engine } = oms;
    // 5/s for 60s, Poisson, part of the events are amends / cancels
    expect(engine.parents.size).toBeGreaterThan(150);
    expect(engine.parents.size).toBeLessThan(400);
    expect(flow.submitted).toBe(engine.parents.size);
    expect(flow.rejected / flow.submitted).toBeLessThan(0.1);
    expect(engine.fills.length).toBeGreaterThan(20);
    const statuses = new Set(
      [...engine.parents.values()].map((o) => o.state.status),
    );
    expect(statuses.has(OrdStatus.Filled)).toBe(true);
    expect(statuses.has(OrdStatus.Cancelled)).toBe(true);
    // every account traded is an enabled seeded account, entered by its owner
    const owners = new Map(SEED_ACCOUNTS.map((a) => [a.account, a]));
    for (const o of engine.parents.values()) {
      expect(owners.get(o.account)?.enabled).toBe(true);
      expect(o.trader).toBe(owners.get(o.account)?.owner as string);
    }
    // working orders stay bounded
    const working = [...engine.parents.values()].filter(
      (o) => !isTerminalStatus(o.state.status),
    );
    expect(working.length).toBeLessThanOrEqual(oms.config.flowMaxWorking + 5);
    // positions agree with the fills
    for (const p of engine.positions.values()) {
      const net = engine.fills
        .filter((f) => f.account === p.account && f.ric === p.ric)
        .reduce((q, f) => q + (f.side === "BUY" ? f.quantity : -f.quantity), 0);
      expect(p.quantity).toBe(net);
      expect(p.markPx).toBeGreaterThan(0);
    }
    expect(log).toEqual([]);
  });

  test("is deterministic for a seed and restricted to flowAccounts", () => {
    const a = run(10, { flowAccounts: "ACC-US-01,ACC-EU-01" });
    const b = run(10, { flowAccounts: "ACC-US-01,ACC-EU-01" });
    const summary = (r: typeof a) =>
      r.oms.engine.fills.map((f) => `${f.orderId}:${f.quantity}@${f.price}`);
    expect(summary(a).length).toBeGreaterThan(0);
    expect(summary(a)).toEqual(summary(b));
    const accounts = new Set(
      [...a.oms.engine.parents.values()].map((o) => o.account),
    );
    expect([...accounts].sort()).toEqual(["ACC-EU-01", "ACC-US-01"]);
  });

  test("rate 0 disables the flow", () => {
    const { oms } = run(5, { flowRate: 0 });
    expect(oms.engine.parents.size).toBe(0);
  });
});
