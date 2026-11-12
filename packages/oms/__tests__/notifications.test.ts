import { describe, expect, test } from "bun:test";
import { OrdStatus, RejectReason } from "@heswell/trading-schemas";
import type { Position } from "../src/engine/OmsEngine";
import {
  type OmsNotification,
  OmsNotifier,
} from "../src/notifications/OmsNotifier";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL, setup } from "./fixture";

const accounts = new Map(SEED_ACCOUNTS.map((a) => [a.account, a]));
const ACC = "ACC-US-01";
// biome-ignore lint/style/noNonNullAssertion: seed data
const LIMIT = accounts.get(ACC)!.maxPositionNotional;

const notifier = () => {
  const published: OmsNotification[] = [];
  const n = new OmsNotifier({
    accounts: (id) => accounts.get(id),
    publish: (row) => published.push(row),
    clock: () => 1_000,
  });
  return { n, published };
};

const position = (marketValueUsd: number, id = `${ACC}|${AAPL}`) =>
  ({ id, account: ACC, ric: AAPL, marketValueUsd }) as Position;

describe("OmsNotifier", () => {
  test("a rejected order publishes one silent orders/ERROR row", () => {
    const { n, published } = notifier();
    const row = {
      orderId: "O1",
      account: ACC,
      ric: AAPL,
      side: "BUY",
      quantity: 100,
      status: OrdStatus.Rejected,
      rejectReason: RejectReason.ExceedsMaxNotional,
    };
    n.parentOrder({ ...row, status: OrdStatus.PendingNew });
    n.parentOrder(row);
    n.parentOrder(row);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "silent",
      level: "ERROR",
      topic: "orders",
      audience: "alice",
      account: ACC,
      ric: AAPL,
      orderId: "O1",
      title: `Order rejected: BUY 100 ${AAPL}`,
      expiryTime: 1_000 + 15 * 60_000,
    });
    expect(published[0].message).toContain(RejectReason.ExceedsMaxNotional);
  });

  test("a stop triggering publishes one orders/INFO toast", () => {
    const { n, published } = notifier();
    const row = {
      orderId: "O2",
      account: ACC,
      ric: AAPL,
      side: "SELL",
      quantity: 100,
      ordType: "STOP_LIMIT",
      price: 168.4,
      stopPrice: 168.5,
      status: OrdStatus.New,
      triggeredAt: 0,
    };
    n.parentOrder(row);
    n.parentOrder({ ...row, triggeredAt: 900 });
    n.parentOrder({ ...row, triggeredAt: 900, status: OrdStatus.Filled });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "toast",
      level: "INFO",
      topic: "orders",
      audience: "alice",
      orderId: "O2",
      title: `Stop triggered: SELL 100 ${AAPL}`,
    });
    expect(published[0].message).toBe(
      "O2 for ACC-US-01: stop 168.5 reached, limit 168.4, order sent to the exchange",
    );
  });

  test("position warns at 80%, errors at the limit, re-arms with hysteresis", () => {
    const { n, published } = notifier();
    n.position(position(LIMIT * 0.5));
    expect(published).toHaveLength(0);
    n.position(position(-LIMIT * 0.85));
    expect(published.at(-1)).toMatchObject({
      type: "toast",
      level: "WARNING",
      topic: "risk",
      audience: "alice",
    });
    n.position(position(LIMIT * 0.82));
    n.position(position(LIMIT * 0.78)); // within hysteresis: still warned
    n.position(position(LIMIT * 0.81));
    expect(published).toHaveLength(1);
    n.position(position(LIMIT * 1.01));
    expect(published.at(-1)).toMatchObject({ level: "ERROR", topic: "risk" });
    n.position(position(LIMIT * 0.97)); // within hysteresis of breach
    n.position(position(LIMIT * 1.02));
    expect(published).toHaveLength(2);
    n.position(position(LIMIT * 0.5)); // clears
    n.position(position(LIMIT * 0.9));
    expect(published).toHaveLength(3);
    expect(published.at(-1)?.level).toBe("WARNING");
    expect(new Set(published.map((p) => p.id)).size).toBe(3);
  });

  test("unknown accounts are ignored", () => {
    const { n, published } = notifier();
    n.position({ ...position(1e12), account: "NOPE" });
    expect(published).toHaveLength(0);
  });

  test("engine.observe fans rows out to observers alongside the sink", () => {
    const sunk: unknown[] = [];
    const published: OmsNotification[] = [];
    const { engine, order, ctx } = setup({
      sink: { parentOrder: (r) => sunk.push(r) },
    });
    const stop = engine.observe(
      new OmsNotifier({
        accounts: (id) => engine.accounts.get(id),
        publish: (row) => published.push(row),
      }),
    );
    engine.createOrder(order({ quantity: 60_000, price: 170 }), ctx);
    expect(sunk.length).toBeGreaterThan(0);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ topic: "orders", account: ACC });
    stop();
    engine.createOrder(order({ quantity: 60_000, price: 170 }), ctx);
    expect(published).toHaveLength(1);
  });
});
