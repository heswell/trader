import { afterEach, expect, test } from "bun:test";
import {
  decodeTimeSeries,
  type TimeSeriesResponse,
} from "@heswell/trading-schemas";
import { createTradingTestData, type TradingTestData } from "../src";

let td: TradingTestData | undefined;
afterEach(() => td?.dispose());

test("timeSeries: generated history joined to live samples", () => {
  td = createTradingTestData({
    seed: 1,
    manualClock: true,
    exchange: { activeInstruments: 4, timeSeriesHistoryHours: 2 },
    oms: { flowRate: 0 },
  });
  td.advance(10_000);
  const ric = td.sim.books[0].ric;
  const now = td.sim.clock();
  const result = td.rpc("timeSeries", {
    ric,
    fields: "mid,spreadBps",
    start: now - 3 * 3_600_000,
    end: now + 1_000,
    points: 800,
  });
  expect(result.type).toBe("SUCCESS_RESULT");
  const data = (result as { data: TimeSeriesResponse }).data;
  expect(data.method).toBe("m4");
  expect(data.series.map((s) => s.field)).toEqual(["mid", "spreadBps"]);
  const mid = data.series[0];
  // 2 h of history + ~10 live seconds
  expect(mid.sourcePoints).toBeGreaterThan(7_200);
  expect(mid.t.length).toBeLessThanOrEqual(802);
  const { times, values } = decodeTimeSeries(mid);
  expect(values.includes(null)).toBe(false);
  expect(times.at(-1)).toBeGreaterThan(now - 2_000);
  expect(data.last).toBe(times.at(-1) as number);
});

test("timeSeries: unknown ric and bad params are rejected", () => {
  td = createTradingTestData({
    seed: 1,
    manualClock: true,
    exchange: { activeInstruments: 2, timeSeriesHistoryHours: 1 },
  });
  expect(td.rpc("timeSeries", { ric: "NOPE.L", points: 100 })).toMatchObject({
    type: "ERROR_RESULT",
    errorMessage: expect.stringContaining("UNKNOWN_INSTRUMENT"),
  });
  expect(td.rpc("timeSeries", { ric: "X", points: 1 })).toMatchObject({
    type: "ERROR_RESULT",
  });
});
