import { describe, expect, test } from "bun:test";
import {
  OrdType,
  RejectReason,
  RpcName,
  Side,
  TimeInForce,
  TradingPhase,
  formatRpcError,
  parseRpcError,
  rpcError,
  rpcSuccess,
  tradingRpcRequest,
  validateAmend,
  validateOrder,
  validateRpcParams,
  type InstrumentStatic,
} from "../src";

const vod: InstrumentStatic = {
  ric: "VOD.L",
  currency: "GBP",
  exchange: "XLON",
  tickSize: 0.01,
  lotSize: 100,
};

describe("validateRpcParams", () => {
  test("createOrder: valid, defaults TIF to DAY, coerces numeric strings", () => {
    const r = validateRpcParams(RpcName.CreateOrder, {
      account: "ACC1",
      ric: "VOD.L",
      side: "BUY",
      ordType: "LIMIT",
      quantity: "500",
      price: 101.25,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        account: "ACC1",
        ric: "VOD.L",
        side: Side.Buy,
        ordType: OrdType.Limit,
        quantity: 500,
        price: 101.25,
        timeInForce: TimeInForce.Day,
      },
    });
  });

  test("createOrder: reports every error, rejects unknown keys", () => {
    const r = validateRpcParams(RpcName.CreateOrder, {
      ric: "",
      side: "LONG",
      ordType: "LIMIT",
      quantity: -1,
      qty: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        "params.qty is not a known field",
        "params.account is required",
        "params.ric is required",
        "params.side must be one of BUY, SELL",
        "params.quantity must be > 0",
      ]);
    }
  });

  test("amendOrder requires quantity or price", () => {
    expect(validateRpcParams(RpcName.AmendOrder, { orderId: "o1" }).ok).toBe(
      false,
    );
    expect(
      validateRpcParams(RpcName.AmendOrder, { orderId: "o1", price: 1 }).ok,
    ).toBe(true);
  });

  test("cancelOrder / cancelAll", () => {
    expect(validateRpcParams(RpcName.CancelOrder, {}).ok).toBe(false);
    expect(validateRpcParams(RpcName.CancelAll, {})).toEqual({
      ok: true,
      value: {},
    });
    expect(
      validateRpcParams(RpcName.CancelAll, { side: "SELL", ric: "" }),
    ).toEqual({
      ok: true,
      value: { side: "SELL" },
    });
  });

  test("admin rpcs", () => {
    expect(
      validateRpcParams(RpcName.SetVolatility, { volatility: 0.3 }).ok,
    ).toBe(true);
    expect(
      validateRpcParams(RpcName.SetVolatility, { volatility: -1 }).ok,
    ).toBe(false);
    expect(validateRpcParams(RpcName.HaltInstrument, {}).ok).toBe(false);
    expect(
      validateRpcParams(RpcName.ResumeInstrument, {
        ric: "VOD.L",
        auction: "true",
      }),
    ).toEqual({
      ok: true,
      value: { ric: "VOD.L", auction: true },
    });
    expect(
      validateRpcParams(RpcName.SetBotRate, { bot: "TAKER", rate: 50 }).ok,
    ).toBe(true);
    expect(
      validateRpcParams(RpcName.SetBotRate, { bot: "X", rate: 50 }).ok,
    ).toBe(false);
    expect(
      validateRpcParams(RpcName.SetMarketPhase, { phase: "CLOSED" }),
    ).toEqual({ ok: true, value: { phase: "CLOSED" } });
    expect(
      validateRpcParams(RpcName.SetMarketPhase, { phase: "HALTED" }).ok,
    ).toBe(false);
    expect(validateRpcParams(RpcName.SetMarketPhase, {}).ok).toBe(false);
  });

  test("unknown rpc / non-object", () => {
    expect(validateRpcParams("nope" as RpcName, {}).ok).toBe(false);
    expect(validateRpcParams(RpcName.CancelOrder, null).ok).toBe(false);
  });
});

describe("rpc messages", () => {
  test("request builder", () => {
    expect(
      tradingRpcRequest(RpcName.CancelOrder, { orderId: "o1" }, "vp-1"),
    ).toEqual({
      type: "RPC_REQUEST",
      context: { type: "VIEWPORT_CONTEXT", viewPortId: "vp-1" },
      rpcName: "cancelOrder",
      params: { orderId: "o1" },
    });
  });

  test("results and error round trip", () => {
    expect(
      rpcSuccess(RpcName.CreateOrder, { orderId: "o1", status: "PENDING_NEW" }),
    ).toEqual({
      type: "SUCCESS_RESULT",
      data: { orderId: "o1", status: "PENDING_NEW" },
    });
    const err = rpcError(RejectReason.InvalidTickSize, "price 1.003: bad");
    expect(err.errorMessage).toBe("INVALID_TICK_SIZE: price 1.003: bad");
    expect(parseRpcError(err.errorMessage)).toEqual({
      reason: RejectReason.InvalidTickSize,
      text: "price 1.003: bad",
    });
    expect(parseRpcError(formatRpcError(RejectReason.UnknownOrder))).toEqual({
      reason: RejectReason.UnknownOrder,
      text: "",
    });
    expect(parseRpcError("boom")).toEqual({
      reason: RejectReason.InternalError,
      text: "boom",
    });
  });
});

describe("validateOrder", () => {
  const limit = {
    side: Side.Buy,
    ordType: OrdType.Limit,
    quantity: 200,
    price: 101.25,
  } as const;
  const reason = (r: ReturnType<typeof validateOrder>) => r?.reason;

  test("valid limit / market", () => {
    expect(validateOrder(limit, vod)).toBeUndefined();
    expect(
      validateOrder(
        { side: Side.Sell, ordType: OrdType.Market, quantity: 100 },
        vod,
      ),
    ).toBeUndefined();
  });

  test("rejects", () => {
    expect(reason(validateOrder({ ...limit, quantity: 150 }, vod))).toBe(
      RejectReason.InvalidLotSize,
    );
    expect(reason(validateOrder({ ...limit, quantity: 0 }, vod))).toBe(
      RejectReason.InvalidQuantity,
    );
    expect(reason(validateOrder({ ...limit, price: 101.255 }, vod))).toBe(
      RejectReason.InvalidTickSize,
    );
    expect(reason(validateOrder({ ...limit, price: undefined }, vod))).toBe(
      RejectReason.MissingPrice,
    );
    expect(reason(validateOrder({ ...limit, price: -1 }, vod))).toBe(
      RejectReason.InvalidPrice,
    );
    expect(
      reason(validateOrder({ ...limit, ordType: OrdType.Market }, vod)),
    ).toBe(RejectReason.InvalidPrice);
    expect(
      reason(validateOrder({ ...limit, ordType: OrdType.Stop }, vod)),
    ).toBe(RejectReason.UnsupportedOrdType);
    expect(
      reason(
        validateOrder(
          {
            ...limit,
            ordType: OrdType.Market,
            price: undefined,
            timeInForce: TimeInForce.GoodTillCancel,
          },
          vod,
        ),
      ),
    ).toBe(RejectReason.UnsupportedTimeInForce);
  });

  test("phases", () => {
    expect(reason(validateOrder(limit, vod, TradingPhase.Halted))).toBe(
      RejectReason.InstrumentHalted,
    );
    expect(reason(validateOrder(limit, vod, TradingPhase.Closed))).toBe(
      RejectReason.MarketClosed,
    );
    expect(
      validateOrder(limit, vod, TradingPhase.OpeningAuction),
    ).toBeUndefined();
    expect(
      reason(
        validateOrder(
          { ...limit, timeInForce: TimeInForce.ImmediateOrCancel },
          vod,
          TradingPhase.PreOpen,
        ),
      ),
    ).toBe(RejectReason.UnsupportedTimeInForce);
  });

  test("banded ticks via instrument tickBands", () => {
    const banded = { ...vod, tickBands: "0:0.001;1:0.005" };
    expect(validateOrder({ ...limit, price: 0.999 }, banded)).toBeUndefined();
    expect(reason(validateOrder({ ...limit, price: 1.001 }, banded))).toBe(
      RejectReason.InvalidTickSize,
    );
  });

  test("validateAmend", () => {
    const orig = { ordType: OrdType.Limit, cumQty: 300 };
    expect(
      validateAmend({ quantity: 400, price: 101.3 }, vod, orig),
    ).toBeUndefined();
    expect(validateAmend({ quantity: 200 }, vod, orig)?.reason).toBe(
      RejectReason.InvalidQuantity,
    );
    expect(validateAmend({ price: 101.301 }, vod, orig)?.reason).toBe(
      RejectReason.InvalidTickSize,
    );
    expect(
      validateAmend({ price: 101 }, vod, { ordType: OrdType.Market, cumQty: 0 })
        ?.reason,
    ).toBe(RejectReason.InvalidPrice);
  });
});
