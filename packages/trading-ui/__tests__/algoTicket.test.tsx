import { afterEach, describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  OrdType,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import { cleanup, render, screen } from "@testing-library/react";
import {
  EMPTY_DRAFT,
  FillProgressBar,
  isTimeInForceAllowed,
  type OrderDraft,
  type OrderTicketInstrument,
  validateDraft,
} from "../src";

afterEach(cleanup);

const instrument: OrderTicketInstrument = {
  ric: "VOD.L",
  currency: "GBX",
  exchange: "XLON",
  tickSize: 0.5,
  lotSize: 100,
  bid: 100,
  ask: 100.5,
};

const draft = (overrides: Partial<OrderDraft> = {}): OrderDraft => ({
  ...EMPTY_DRAFT,
  ric: "VOD.L",
  account: "ACC1",
  side: Side.Buy,
  ordType: OrdType.Limit,
  timeInForce: TimeInForce.Day,
  quantity: "1000",
  price: "100",
  ...overrides,
});

describe("algo fields on the order ticket", () => {
  test("DMA sends no strategy params", () => {
    const { params } = validateDraft(draft(), instrument);
    expect(params?.strategy).toBeUndefined();
    expect(params).not.toHaveProperty("durationMins");
  });

  test("TWAP: optional duration in minutes", () => {
    expect(
      validateDraft(draft({ strategy: AlgoStrategy.Twap }), instrument).params,
    ).toMatchObject({ strategy: "TWAP" });
    expect(
      validateDraft(
        draft({
          strategy: AlgoStrategy.Twap,
          algoParams: { durationMins: "45" },
        }),
        instrument,
      ).params,
    ).toMatchObject({ strategy: "TWAP", durationMins: 45 });
    expect(
      validateDraft(
        draft({
          strategy: AlgoStrategy.Twap,
          algoParams: { durationMins: "-1" },
        }),
        instrument,
      ).errors.durationMins,
    ).toBeDefined();
  });

  test("VWAP: optional HH:MM end time", () => {
    expect(
      validateDraft(
        draft({
          strategy: AlgoStrategy.Vwap,
          algoParams: { endTime: "15:30" },
        }),
        instrument,
      ).params,
    ).toMatchObject({ strategy: "VWAP", endTime: "15:30" });
    expect(
      validateDraft(
        draft({ strategy: AlgoStrategy.Vwap, algoParams: { endTime: "3pm" } }),
        instrument,
      ).errors.endTime,
    ).toBe("End time must be HH:MM");
  });

  test("POV: participation is required", () => {
    expect(
      validateDraft(draft({ strategy: AlgoStrategy.Pov }), instrument).errors
        .participationPct,
    ).toBeDefined();
    expect(
      validateDraft(
        draft({
          strategy: AlgoStrategy.Pov,
          algoParams: { participationPct: "10" },
        }),
        instrument,
      ).params,
    ).toMatchObject({ strategy: "POV", participationPct: 10 });
  });

  test("algo orders take DAY or GTC only", () => {
    expect(
      isTimeInForceAllowed(OrdType.Limit, TimeInForce.ImmediateOrCancel),
    ).toBe(true);
    expect(
      isTimeInForceAllowed(
        OrdType.Limit,
        TimeInForce.ImmediateOrCancel,
        AlgoStrategy.Twap,
      ),
    ).toBe(false);
    expect(
      validateDraft(
        draft({
          strategy: AlgoStrategy.Twap,
          timeInForce: TimeInForce.FillOrKill,
        }),
        instrument,
      ).errors.timeInForce,
    ).toBe("FOK is not valid for TWAP orders");
  });
});

describe("FillProgressBar schedule marker", () => {
  test("draws the target and says whether the order is behind", () => {
    render(<FillProgressBar filled={200} target={500} total={1000} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.dataset.targetPct).toBe("50");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "200 / 1,000 (20%), behind schedule (target 500)",
    );
    expect(bar.querySelector(".tradingFillProgressBar-target")).not.toBeNull();
  });

  test("no marker without a target", () => {
    render(<FillProgressBar filled={200} total={1000} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.dataset.targetPct).toBeUndefined();
    expect(bar.querySelector(".tradingFillProgressBar-target")).toBeNull();
  });
});
