import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import {
  decodeEntryMessages,
  decodeLimitCheck,
  EntryMessageLevel,
  LimitMetric,
  LimitOverrideReason,
  LimitState,
  OrdType,
  RejectReason,
  Side,
} from "@heswell/trading-schemas";
import { createOms } from "../src/engine/OmsService";
import { handleLimitsRpc } from "../src/modules/oms/limitsRpc";
import { TradingRole } from "../src/permissions/access";

const AAPL = "AAPL.OQ";
const ACC = "ACC-US-01";
const alice = { name: "alice", authorizations: [TradingRole.Execute] };

/** A minimal OmsTable keeping rows by key, as the Vuu tables do. */
const memoryTable = (columns: readonly string[]) => {
  const columnMap = Object.fromEntries(columns.map((c, i) => [c, i]));
  const rows = new Map<string, unknown[]>();
  return {
    columnMap,
    columns,
    rows,
    insert(row: unknown[]) {
      rows.set(String(row[0]), row);
    },
    updateByKey(key: string, values: Record<string, unknown>) {
      const row = rows.get(key);
      if (!row) return;
      for (const [c, v] of Object.entries(values)) row[columnMap[c]] = v;
    },
    rowIndexAtKey: (key: string) => (rows.has(key) ? 0 : -1),
    delete(key: string) {
      rows.delete(key);
    },
    value(key: string, column: string) {
      return rows.get(key)?.[columnMap[column]];
    },
    objects() {
      return [...rows.values()].map((row) =>
        Object.fromEntries(columns.map((c, i) => [c, row[i]])),
      );
    },
  };
};

const ENTRY_COLUMNS = [
  "entryId",
  "user",
  "ticketId",
  "ric",
  "side",
  "ordType",
  "timeInForce",
  "quantity",
  "price",
  "stopPrice",
  "account",
  "strategy",
  "clOrdId",
  "orderId",
  "lastUpdate",
  "vuuMsg",
  "limitCheck",
];
const OVERRIDE_COLUMNS = [
  "overrideId",
  "time",
  "user",
  "account",
  "ric",
  "side",
  "quantity",
  "orderId",
  "limitKey",
  "entityId",
  "metric",
  "before",
  "after",
  "soft",
  "hard",
  "utilisation",
  "reason",
  "note",
];

/**
 * An OMS with AAPL quoted around its reference price, and ACC-US-01's
 * position limit at 100k USD (warning 80k, hard 110k).
 */
const setup = () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 13, 15));
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: AAPL, mmRate: 0, takerRate: 0 },
  });
  const oms = createOms(sim.gateway, {
    clock: clock.now,
    config: {
      flowRate: 0,
      clientBots: "",
      limits: `${ACC}:POSITION_NOTIONAL=100000`,
    },
    rics: [AAPL],
    log: () => {},
  });
  const entries = memoryTable(ENTRY_COLUMNS);
  const overrides = memoryTable(OVERRIDE_COLUMNS);
  oms.tables.attach("orderEntry", entries);
  oms.tables.attach("limitOverrides", overrides);
  const instrument = oms.gateway.getInstrument(AAPL);
  if (!instrument) throw Error("no AAPL");
  const ref = instrument.refPrice;
  const book = sim.getBook(AAPL);
  // far from the order price, so nothing fills
  book?.limit({ id: "b1", side: BookSide.BUY, price: ref - 1, size: 500 });
  book?.limit({ id: "a1", side: BookSide.SELL, price: ref + 1, size: 500 });
  const price = Math.round((ref - 0.5) * 100) / 100;
  /** The quantity whose position is `usd` (at the reference price). */
  const qtyFor = (usd: number) => Math.floor(usd / ref);
  const order = (quantity: number, o: Record<string, unknown> = {}) => ({
    account: ACC,
    ric: AAPL,
    side: Side.Buy,
    ordType: OrdType.Limit,
    quantity,
    price,
    ...o,
  });
  return { oms, entries, overrides, ref, price, qtyFor, order };
};

describe("pre-trade limit check", () => {
  test("lists each limit before and after, with its state", () => {
    const { oms, qtyFor, order } = setup();
    const result = oms.checkLimits(order(qtyFor(90_000)));
    if (!result.ok) throw Error(result.text);
    const position = result.value.lines.find(
      (l) => l.metric === LimitMetric.PositionNotional,
    );
    expect(position).toMatchObject({
      entityId: ACC,
      ric: AAPL,
      before: 0,
      soft: 100_000,
      state: LimitState.Warning,
      breach: false,
    });
    expect(position?.after).toBeCloseTo(90_000, -3);
    expect(result.value.state).toBe(LimitState.Warning);
    expect(result.value.lines.map((l) => l.metric)).toEqual([
      LimitMetric.OrderQty,
      LimitMetric.OrderNotional,
      LimitMetric.PositionNotional,
      LimitMetric.NetDelta,
    ]);
  });

  test("a soft breach, with the most the order could be under hard", () => {
    const { oms, qtyFor, order, ref } = setup();
    const result = oms.checkLimits(order(qtyFor(105_000)));
    if (!result.ok) throw Error(result.text);
    expect(result.value.state).toBe(LimitState.SoftBreach);
    const position = result.value.lines.find(
      (l) => l.metric === LimitMetric.PositionNotional,
    );
    expect(position?.breach).toBe(true);
    expect(position?.maxQty).toBe(Math.floor(110_000 / ref));
  });

  test("over the hard limit", () => {
    const { oms, qtyFor, order } = setup();
    const result = oms.checkLimits(order(qtyFor(115_000)));
    if (!result.ok) throw Error(result.text);
    expect(result.value.state).toBe(LimitState.HardBreach);
  });

  test("checkLimits RPC, for an account the user can see", () => {
    const { oms, qtyFor, order } = setup();
    const ok = handleLimitsRpc(
      oms,
      "checkLimits",
      order(qtyFor(105_000)),
      alice,
    );
    expect(ok.type).toBe("SUCCESS_RESULT");
    const bob = { name: "bob", authorizations: [TradingRole.Execute] };
    const other = handleLimitsRpc(
      oms,
      "checkLimits",
      order(10, { account: "NO-SUCH" }),
      bob,
    );
    expect(other.type).toBe("ERROR_RESULT");
  });
});

describe("overriding a soft breach", () => {
  test("createOrder over the limit rejects without an override", () => {
    const { oms, qtyFor, order } = setup();
    const result = oms.engine.createOrder(order(qtyFor(105_000)), {
      user: "alice",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.ExceedsMaxNotional);
  });

  test("with an override it is sent, and the override recorded", () => {
    const { oms, overrides, qtyFor, order } = setup();
    const result = oms.engine.createOrder(
      {
        ...order(qtyFor(105_000)),
        overrideReason: LimitOverrideReason.ClientFacilitation,
      },
      { user: "alice" },
    );
    if (!result.ok) throw Error(result.text);
    const rows = overrides.objects();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      overrideId: `${result.value.orderId}:${ACC}:POSITION_NOTIONAL`,
      user: "alice",
      account: ACC,
      ric: AAPL,
      orderId: result.value.orderId,
      metric: LimitMetric.PositionNotional,
      entityId: ACC,
      soft: 100_000,
      reason: LimitOverrideReason.ClientFacilitation,
    });
    expect(rows[0].utilisation).toBeCloseTo(105, 0);
  });

  test("OTHER needs a note", () => {
    const { oms, qtyFor, order } = setup();
    const result = oms.engine.createOrder(
      { ...order(qtyFor(105_000)), overrideReason: LimitOverrideReason.Other },
      { user: "alice" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.InvalidRequest);
  });

  test("nothing overrides the hard limit", () => {
    const { oms, overrides, qtyFor, order } = setup();
    const result = oms.engine.createOrder(
      {
        ...order(qtyFor(115_000)),
        overrideReason: LimitOverrideReason.Hedging,
      },
      { user: "alice" },
    );
    expect(result.ok).toBe(false);
    expect(overrides.objects()).toHaveLength(0);
  });

  test("the order ticket: Review over the limit, an error at hard", () => {
    const { oms, entries, qtyFor, price } = setup();
    const opened = oms.orderEntry.open(alice, {
      ticketId: "t1",
      ric: AAPL,
      account: ACC,
      price,
    });
    if (!opened.ok) throw Error(opened.text);
    const { entryId } = opened.value;
    const messages = () =>
      decodeEntryMessages(entries.value(entryId, "vuuMsg") as string);
    const limitCheck = () =>
      decodeLimitCheck(entries.value(entryId, "limitCheck") as string);

    oms.orderEntry.update(alice, { entryId, quantity: qtyFor(105_000) });
    expect(
      messages().find((m) => m.code === "maxPositionNotional")?.level,
    ).toBe(EntryMessageLevel.Review);
    expect(
      limitCheck().find((l) => l.metric === LimitMetric.PositionNotional)
        ?.state,
    ).toBe(LimitState.SoftBreach);

    const unconfirmed = oms.orderEntry.send(alice, { entryId });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) expect(unconfirmed.text).toMatch(/override reason/);

    const sent = oms.orderEntry.send(alice, {
      entryId,
      overrideReason: LimitOverrideReason.Hedging,
      overrideNote: "against the index future",
    });
    if (!sent.ok) throw Error(sent.text);

    oms.orderEntry.update(alice, { entryId, quantity: qtyFor(20_000) });
    expect(
      messages().find((m) => m.code === "maxPositionNotional")?.level,
    ).toBe(EntryMessageLevel.Error);
  });
});
