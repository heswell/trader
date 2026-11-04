import { describe, expect, test } from "bun:test";
import {
  activityAt,
  FLAT_PROFILE,
  U_SHAPED_PROFILE,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { ManualClock } from "../src/util/clock";

/** Midnight UTC, 5 Jan 2026 (a multiple of the compressed day length). */
const DAY0 = Date.UTC(2026, 0, 5);
/** A 4 minute simulated day: 08:00-16:30 is 80s..165s of clock. */
const DAY_MS = 240_000;
const OPEN = DAY0 + 80_000;
const SESSION_MS = 85_000;

const simAt = (time: number, config: Record<string, unknown> = {}) => {
  const clock = new ManualClock(time);
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      instruments: "AAPL.OQ",
      sessionDayMs: DAY_MS,
      volumeNoise: 0,
      ...config,
    },
  });
  return { clock, sim };
};

/** Tape volume traded in [from, from + ms), stepping the bots every 20ms. */
const volumeBetween = (from: number, ms: number, config = {}) => {
  const { clock, sim } = simAt(from, config);
  let volume = 0;
  sim.onTape((trade) => {
    volume += trade.size;
  });
  for (let t = 0; t < ms; t += 20) {
    sim.step(clock.advance(20));
  }
  return volume;
};

describe("intraday volume curve", () => {
  test("the gateway publishes the session schedule and the curve", () => {
    const { sim } = simAt(OPEN);
    expect(sim.gateway.getSessionSchedule()).toEqual({
      scheduled: true,
      dayMs: DAY_MS,
      openAt: 80_000,
      closeAt: 165_000,
      profile: U_SHAPED_PROFILE,
    });
    const flat = simAt(OPEN, { volumeProfile: "flat" }).sim;
    expect(flat.gateway.getSessionSchedule().profile).toEqual(FLAT_PROFILE);
    const always = simAt(OPEN, { sessionDayMs: 0 }).sim;
    expect(always.gateway.getSessionSchedule().scheduled).toBe(false);
  });

  test("takers trade more just after the open than mid-session", () => {
    const window = SESSION_MS * 0.05;
    const atOpen = volumeBetween(OPEN, window);
    const midday = volumeBetween(OPEN + SESSION_MS * 0.475, window);
    const schedule = simAt(OPEN).sim.sessionSchedule;
    // The curve itself: ~3.5x busier at the open.
    expect(activityAt(schedule, OPEN + window / 2)).toBeGreaterThan(
      3 * activityAt(schedule, OPEN + SESSION_MS / 2),
    );
    expect(atOpen).toBeGreaterThan(2 * midday);
  });

  test("a flat profile keeps activity constant", () => {
    const window = SESSION_MS * 0.05;
    const atOpen = volumeBetween(OPEN, window, { volumeProfile: "flat" });
    const midday = volumeBetween(OPEN + SESSION_MS * 0.475, window, {
      volumeProfile: "flat",
    });
    expect(atOpen).toBeLessThan(2 * midday);
  });

  test("the gateway streams every trade to OMS subscribers", () => {
    const { clock, sim } = simAt(OPEN);
    const trades: { ric: string; size: number }[] = [];
    const off = sim.gateway.onTrade((t) => trades.push(t));
    for (let i = 0; i < 200; i++) sim.step(clock.advance(20));
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.every((t) => t.ric === "AAPL.OQ" && t.size > 0)).toBe(true);
    off();
    const seen = trades.length;
    for (let i = 0; i < 200; i++) sim.step(clock.advance(20));
    expect(trades.length).toBe(seen);
  });

  test("rejects an unknown profile and out-of-range noise", () => {
    expect(() => simAt(OPEN, { volumeProfile: "w" })).toThrow(/volumeProfile/);
    expect(() => simAt(OPEN, { volumeNoise: 1 })).toThrow(/volumeNoise/);
  });
});
