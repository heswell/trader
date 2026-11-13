import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import {
  AlgoStrategy,
  decodeEntryMessages,
  type EntryMessage,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import { createOms } from "../src/engine/OmsService";
import { ORDER_ENTRY_IDLE_MS } from "../src/entry/OrderEntryService";
import {
  handleOrderEntryEditCell,
  handleOrderEntryRpc,
} from "../src/entry/orderEntryRpc";
import { TradingRole } from "../src/permissions/access";

const AAPL = "AAPL.OQ";
const alice = { name: "alice", authorizations: [TradingRole.Execute] };
const bob = { name: "bob", authorizations: [TradingRole.Execute] };

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
  };
};

const setup = () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 13, 15));
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: AAPL, mmRate: 0, takerRate: 0 },
  });
  const oms = createOms(sim.gateway, {
    clock: clock.now,
    config: { flowRate: 0, clientBots: "" },
    rics: [AAPL],
    log: () => {},
  });
  const { orderEntry: columns } = {
    orderEntry: [
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
      "durationMins",
      "endTime",
      "participationPct",
      "description",
      "exchange",
      "currency",
      "instrumentType",
      "contract",
      "tickSize",
      "tickBands",
      "lotSize",
      "priceDecimals",
      "contractMultiplier",
      "refPrice",
      "clOrdId",
      "orderId",
      "lastUpdate",
      "vuuMsg",
    ],
  };
  const table = memoryTable(columns);
  oms.tables.attach("orderEntry", table);
  const instrument = oms.gateway.getInstrument(AAPL);
  if (!instrument) throw Error("no AAPL");
  // a two-sided market around the reference price
  const ref = instrument.refPrice;
  const book = sim.getBook(AAPL);
  book?.limit({ id: "b1", side: BookSide.BUY, price: ref - 0.05, size: 500 });
  book?.limit({ id: "a1", side: BookSide.SELL, price: ref + 0.05, size: 500 });
  const entries = oms.orderEntry;
  const open = (fields: Record<string, unknown> = {}) => {
    const result = entries.open(alice, { ticketId: "t1", ...fields });
    if (!result.ok) throw Error(result.text);
    return result.value.entryId;
  };
  const messages = (entryId: string): EntryMessage[] =>
    decodeEntryMessages(String(table.value(entryId, "vuuMsg") ?? ""));
  const codes = (entryId: string) =>
    messages(entryId).map((m) => `${m.field}:${m.code}`);
  return { clock, sim, oms, table, entries, ref, open, messages, codes };
};

describe("OrderEntryService", () => {
  test("open writes a row with defaults, the user's account and the empty-field errors", () => {
    const { open, table, codes } = setup();
    const entryId = open({ ric: AAPL });
    expect(entryId).toBe("alice:t1");
    expect(table.value(entryId, "account")).toBe("ACC-US-01");
    expect(table.value(entryId, "side")).toBe(Side.Buy);
    expect(table.value(entryId, "ordType")).toBe(OrdType.Limit);
    expect(table.value(entryId, "currency")).toBe("USD");
    expect(Number(table.value(entryId, "tickSize"))).toBeGreaterThan(0);
    expect(codes(entryId)).toEqual([
      "quantity:INVALID_QUANTITY",
      "price:MISSING_PRICE",
    ]);
  });

  test("open without fields keeps an existing row; with fields resets it", () => {
    const { open, entries, table } = setup();
    const entryId = open({ ric: AAPL });
    entries.update(alice, { entryId, quantity: 300 });
    open();
    expect(table.value(entryId, "quantity")).toBe(300);
    open({ ric: AAPL, side: Side.Sell });
    expect(table.value(entryId, "quantity")).toBe(0);
    expect(table.value(entryId, "side")).toBe(Side.Sell);
  });

  test("a business error keeps the value and is reported in vuuMsg", () => {
    const { open, entries, table, codes, ref } = setup();
    const entryId = open({ ric: AAPL });
    const offTick = Math.round(ref * 100) / 100 + 0.003;
    entries.update(alice, { entryId, quantity: 100, price: offTick });
    expect(table.value(entryId, "price")).toBe(offTick);
    expect(codes(entryId)).toEqual(["price:INVALID_TICK_SIZE"]);
  });

  test("account limits and the collar are reported on their fields", () => {
    const { open, entries, codes, ref } = setup();
    const entryId = open({ ric: AAPL });
    // ACC-US-01: maxOrderQty 50,000
    entries.update(alice, {
      entryId,
      quantity: 60_000,
      price: Math.round(ref * 1.5 * 100) / 100,
    });
    const found = codes(entryId);
    expect(found).toContain("quantity:maxOrderQty");
    expect(found).toContain("price:collar");
  });

  test("stops are DMA only: the choice just made wins", () => {
    const { open, entries, table, messages } = setup();
    const entryId = open({ ric: AAPL });
    entries.update(alice, { entryId, strategy: AlgoStrategy.Twap });
    entries.update(alice, { entryId, ordType: OrdType.Stop });
    expect(table.value(entryId, "strategy")).toBe(AlgoStrategy.Dma);
    expect(messages(entryId).find((m) => m.field === "strategy")?.level).toBe(
      "I",
    );
    entries.update(alice, { entryId, strategy: AlgoStrategy.Twap });
    expect(table.value(entryId, "ordType")).toBe(OrdType.Market);
  });

  test("an order type without a price clears it; an invalid TIF falls back to DAY", () => {
    const { open, entries, table, ref } = setup();
    const entryId = open({ ric: AAPL, price: ref });
    entries.update(alice, { entryId, timeInForce: TimeInForce.GoodTillCancel });
    entries.update(alice, { entryId, ordType: OrdType.Market });
    expect(table.value(entryId, "price")).toBe(0);
    expect(table.value(entryId, "timeInForce")).toBe(TimeInForce.Day);
  });

  test("sendOrder creates the order, records it and clears the quantity", () => {
    const { open, entries, table, oms, ref } = setup();
    const entryId = open({ ric: AAPL });
    const price = Math.round(ref * 100) / 100;
    entries.update(alice, { entryId, quantity: 100, price });
    const result = entries.send(alice, { entryId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(table.value(entryId, "orderId")).toBe(result.value.orderId);
    expect(table.value(entryId, "quantity")).toBe(0);
    expect(table.value(entryId, "price")).toBe(price);
    const order = oms.engine.getOrder(result.value.orderId);
    expect(order?.account).toBe("ACC-US-01");
    expect(order?.state.leavesQty).toBe(100);
  });

  test("sendOrder is refused while the row has errors", () => {
    const { open, entries } = setup();
    const entryId = open({ ric: AAPL });
    const result = entries.send(alice, { entryId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(RejectReason.InvalidQuantity);
  });

  test("rows belong to their user", () => {
    const { open, entries } = setup();
    const entryId = open({ ric: AAPL });
    expect(entries.update(bob, { entryId, quantity: 1 }).ok).toBe(false);
    expect(entries.send(bob, { entryId }).ok).toBe(false);
    expect(entries.close(bob, entryId).ok).toBe(false);
  });

  test("refresh deletes idle rows", () => {
    const { open, entries, table, clock } = setup();
    const entryId = open({ ric: AAPL });
    clock.advance(ORDER_ENTRY_IDLE_MS + 1);
    entries.refresh();
    expect(entries.size).toBe(0);
    expect(table.rows.has(entryId)).toBe(false);
  });
});

describe("order entry RPCs", () => {
  test("editCell refuses wrong types and closed-set values, not business errors", () => {
    const { oms, open, table } = setup();
    const entryId = open({ ric: AAPL });
    const edit = (column: string, data: unknown) =>
      handleOrderEntryEditCell(oms, { key: entryId, column, data }, alice);
    expect(edit("quantity", "abc").type).toBe("ERROR_RESULT");
    expect(edit("ordType", "ICEBERG").type).toBe("ERROR_RESULT");
    expect(edit("vuuMsg", "x").type).toBe("ERROR_RESULT");
    expect(edit("quantity", "150").type).toBe("SUCCESS_RESULT");
    expect(table.value(entryId, "quantity")).toBe(150);
    expect(
      handleOrderEntryEditCell(
        oms,
        { key: entryId, column: "quantity", data: 1 },
        bob,
      ).type,
    ).toBe("ERROR_RESULT");
  });

  test("openOrderEntry / sendOrder / closeOrderEntry", () => {
    const { oms, ref, table } = setup();
    const opened = handleOrderEntryRpc(
      oms,
      "openOrderEntry",
      {
        ticketId: "t9",
        ric: AAPL,
        quantity: 10,
        price: Math.round(ref * 100) / 100,
      },
      alice,
    );
    expect(opened.type).toBe("SUCCESS_RESULT");
    const sent = handleOrderEntryRpc(
      oms,
      "sendOrder",
      { entryId: "alice:t9" },
      alice,
    );
    expect(sent.type).toBe("SUCCESS_RESULT");
    expect(
      handleOrderEntryRpc(
        oms,
        "closeOrderEntry",
        { entryId: "alice:t9" },
        alice,
      ).type,
    ).toBe("SUCCESS_RESULT");
    expect(table.rows.has("alice:t9")).toBe(false);
  });
});
