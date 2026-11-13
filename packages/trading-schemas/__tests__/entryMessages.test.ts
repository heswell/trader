import { describe, expect, test } from "bun:test";
import {
  decodeEntryMessages,
  type EntryMessage,
  EntryMessageLevel,
  encodeEntryMessages,
  entryReviewMessages,
  hasEntryErrors,
  joinTableColumns,
  ORDER_ENTRY_EDITABLE_COLUMNS,
  orderEntry,
  orderEntryPrices,
  RpcName,
  validateRpcParams,
} from "../src";

const tickError: EntryMessage = {
  level: EntryMessageLevel.Error,
  field: "price",
  code: "INVALID_TICK_SIZE",
  text: "Price 100.03 is not on a 0.05 tick: use 100 or 100.05",
};
const collar: EntryMessage = {
  level: EntryMessageLevel.Review,
  field: "price",
  code: "collar",
  text: 'Price is 6.2% from the reference; "collar" ±5%',
};

describe("entry messages", () => {
  test("no messages encode as an empty string", () => {
    expect(encodeEntryMessages([])).toBe("");
    expect(decodeEntryMessages("")).toEqual([]);
    expect(decodeEntryMessages(undefined)).toEqual([]);
  });

  test("round trip, including text with separators and quotes", () => {
    const encoded = encodeEntryMessages([tickError, collar]);
    expect(encoded.startsWith("[")).toBe(true);
    expect(JSON.parse(encoded)[0]).toEqual({
      l: "E",
      f: "price",
      c: "INVALID_TICK_SIZE",
      t: tickError.text,
    });
    expect(decodeEntryMessages(encoded)).toEqual([tickError, collar]);
  });

  test("plain text (a vuu-server stale message) is one form error", () => {
    expect(decodeEntryMessages("stale:E-1:price")).toEqual([
      {
        level: "E",
        field: "form",
        code: "INTERNAL_ERROR",
        text: "stale:E-1:price",
      },
    ]);
  });

  test("malformed items are dropped", () => {
    expect(
      decodeEntryMessages('[{"l":"X","f":"a","c":"b","t":"c"},{"l":"I"}]'),
    ).toEqual([]);
  });

  test("errors block, review warnings are picked out", () => {
    expect(hasEntryErrors([collar])).toBe(false);
    expect(hasEntryErrors([collar, tickError])).toBe(true);
    expect(entryReviewMessages([tickError, collar])).toEqual([collar]);
  });
});

describe("orderEntry schema", () => {
  test("editable columns are orderEntry columns", () => {
    const names = orderEntry.columns.map(({ name }) => name);
    for (const c of ORDER_ENTRY_EDITABLE_COLUMNS) expect(names).toContain(c);
  });

  test("the join adds live prices without clobbering draft columns", () => {
    const names = joinTableColumns(orderEntryPrices).map(({ name }) => name);
    expect(names).toContain("bid");
    expect(names).toContain("phase");
    expect(names.filter((n) => n === "ric")).toHaveLength(1);
  });
});

describe("order entry RPCs", () => {
  test("openOrderEntry needs a ticketId; fields are optional", () => {
    expect(validateRpcParams(RpcName.OpenOrderEntry, {}).ok).toBe(false);
    const r = validateRpcParams(RpcName.OpenOrderEntry, {
      ticketId: "t1",
      side: "SELL",
      price: 0,
      ric: "",
    });
    expect(r.ok).toBe(true);
  });

  test("updateOrderEntry rejects values outside the closed sets", () => {
    expect(
      validateRpcParams(RpcName.UpdateOrderEntry, {
        entryId: "u:t1",
        ordType: "ICEBERG",
      }).ok,
    ).toBe(false);
    expect(
      validateRpcParams(RpcName.UpdateOrderEntry, {
        entryId: "u:t1",
        quantity: -1,
      }).ok,
    ).toBe(false);
  });

  test("sendOrder takes confirmed", () => {
    const r = validateRpcParams(RpcName.SendOrder, {
      entryId: "u:t1",
      confirmed: true,
    });
    expect(r.ok && r.value.confirmed).toBe(true);
  });
});
