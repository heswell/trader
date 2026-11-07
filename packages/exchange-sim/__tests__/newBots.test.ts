import { describe, expect, test } from "bun:test";
import type { AggressiveTrader } from "../src/engine/bots/AggressiveTrader";
import { BotKind } from "../src/engine/bots/Bot";
import type { Iceberg } from "../src/engine/bots/Iceberg";
import type { MarketMaker } from "../src/engine/bots/MarketMaker";
import { parseExtraBots } from "../src/engine/bots/roster";
import type { StopLosses } from "../src/engine/bots/StopLosses";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { ManualClock } from "../src/util/clock";

const RIC = "AAPL.OQ";
const STEP_MS = 20;

const setup = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: RIC, defaultVolatility: 0.3, seed: 11, ...config },
  });
  const book = () => sim.getBook(RIC) ?? Throw();
  const mid = () => {
    const top = book().topOfBook();
    return top.bid > 0 && top.ask > 0
      ? (top.bid + top.ask) / 2
      : book().model.fairValue;
  };
  /** Run `ms`, calling `sample` every `everyMs`. */
  const run = (ms: number, sample?: () => void, everyMs = 1_000) => {
    for (let t = STEP_MS; t <= ms; t += STEP_MS) {
      sim.step(clock.advance(STEP_MS));
      if (sample && t % everyMs === 0) sample();
    }
  };
  const bots = <T>(kind: string) =>
    sim.getBots(RIC).filter((b) => b.kind === kind) as T[];
  return { clock, sim, book, mid, run, bots };
};

function Throw(): never {
  throw Error("no book");
}

/** Lag-1 autocorrelation of log returns of `prices`. */
const autocorrelation = (prices: number[]) => {
  const r = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < r.length; i++) {
    den += (r[i] - mean) ** 2;
    if (i > 0) num += (r[i] - mean) * (r[i - 1] - mean);
  }
  return num / den;
};

/** Mid every 5s over 20 minutes, after a minute to settle. */
const midPath = (s: ReturnType<typeof setup>) => {
  s.run(60_000);
  const prices: number[] = [];
  s.run(1_200_000, () => prices.push(s.mid()), 5_000);
  return prices;
};

describe("extraBots", () => {
  test("parses kind:count[@sector] and rejects unknown kinds", () => {
    expect(parseExtraBots("momentum:2, stopLosses:1@Energy")).toEqual([
      { kind: "momentum", count: 2 },
      { kind: "stopLosses", count: 1, sector: "Energy" },
    ]);
    expect(() => parseExtraBots("robot:1")).toThrow("bad entry 'robot:1'");
  });

  test("adds bots per sector; the default roster is unchanged", () => {
    const { sim } = setup({
      instruments: "AAPL.OQ,XOM.N",
      extraBots: "momentum:1,iceberg:1@Energy",
    });
    const ids = (ric: string) => sim.getBots(ric).map((b) => b.localId);
    expect(ids("AAPL.OQ")).toEqual([
      "MM1",
      "MM2",
      "TAKER1",
      "TAKER2",
      "TAKER3",
      "MOM1",
    ]);
    expect(ids("XOM.N")).toEqual([
      "MM1",
      "MM2",
      "ICE1",
      "TAKER1",
      "TAKER2",
      "TAKER3",
      "MOM1",
    ]);
  });
});

describe("stressed market maker", () => {
  const spreadUnderStress = (volSensitivity: number) => {
    const s = setup();
    s.sim.control.setBotParams(
      { kind: BotKind.MarketMaker },
      "volSensitivity",
      String(volSensitivity),
    );
    s.run(30_000);
    s.sim.control.setInstrumentParams(RIC, { volatility: 1.5 });
    let total = 0;
    let n = 0;
    s.run(
      60_000,
      () => {
        const top = s.book().topOfBook();
        if (top.bid > 0 && top.ask > 0) {
          total += ((top.ask - top.bid) / s.mid()) * 1e4;
          n++;
        }
      },
      500,
    );
    return {
      spread: total / n,
      widen: s.bots<MarketMaker>(BotKind.MarketMaker)[0].widen,
    };
  };

  test("widens in high volatility", () => {
    const off = spreadUnderStress(0);
    const on = spreadUnderStress(1);
    expect(off.widen).toBe(1);
    expect(on.widen).toBeGreaterThan(1);
    expect(on.spread).toBeGreaterThan(off.spread * 1.5);
  });

  test("pulls in a fast market, then requotes wide", () => {
    const s = setup();
    s.sim.control.setBotParams(
      { kind: BotKind.MarketMaker },
      "pullMoveBps",
      "30",
    );
    s.run(20_000);
    s.sim.control.shiftFairValue(RIC, 200);
    s.run(1_000);
    const [mm] = s.bots<MarketMaker>(BotKind.MarketMaker);
    expect(mm.isPulled(s.sim.clock())).toBe(true);
    expect(mm.quoteCount).toBe(0);
    s.run(6_000);
    expect(mm.isPulled(s.sim.clock())).toBe(false);
    expect(mm.quoteCount).toBeGreaterThan(0);
    expect(mm.widen).toBeGreaterThanOrEqual(2);
  });

  test("inventory limits cap the position a seller can push on the makers", () => {
    const pushed = (limit: boolean) => {
      const s = setup();
      if (limit) {
        s.sim.control.setBotParams(
          { kind: BotKind.MarketMaker },
          "maxInventory",
          "2000",
        );
        s.sim.control.setBotParams(
          { kind: BotKind.MarketMaker },
          "flattenAt",
          "4000",
        );
      }
      s.run(10_000);
      s.sim.control.addBot(RIC, BotKind.AggressiveTrader, {
        notionalUsd: "3000000",
        durationSecs: "20",
      });
      s.run(25_000);
      return Math.max(
        ...s.bots<MarketMaker>(BotKind.MarketMaker).map((mm) => mm.position),
      );
    };
    const free = pushed(false);
    const capped = pushed(true);
    expect(free).toBeGreaterThan(4_000);
    expect(capped).toBeLessThan(free);
    expect(capped).toBeLessThanOrEqual(4_000 + 1_000);
  });
});

describe("aggressive trader and stops", () => {
  test("sells its notional over its duration, then stops", () => {
    const s = setup();
    s.run(5_000);
    const bot = s.sim.control.addBot(RIC, BotKind.AggressiveTrader, {
      notionalUsd: "1000000",
      durationSecs: "10",
    }) as AggressiveTrader;
    s.run(5_000);
    expect(bot.doneUsd).toBeGreaterThan(300_000);
    expect(bot.doneUsd).toBeLessThan(700_000);
    s.run(10_000);
    expect(bot.finished).toBe(true);
    expect(bot.doneUsd).toBeGreaterThan(990_000);
    expect(bot.doneUsd).toBeLessThan(1_100_000);
    expect(bot.port.ledger.position).toBeLessThan(0);
  });

  test("a stop cascade deepens the drawdown of a sell-off", () => {
    const drawdown = (stops: boolean) => {
      const s = setup();
      if (stops)
        s.sim.control.addBot(RIC, BotKind.StopLosses, {
          perSide: "60",
          minBps: "10",
          maxBps: "150",
          meanQty: "3000",
        });
      s.run(10_000);
      const start = s.mid();
      let low = start;
      s.sim.control.addBot(RIC, BotKind.AggressiveTrader, {
        notionalUsd: "3000000",
        durationSecs: "20",
      });
      s.run(
        30_000,
        () => {
          low = Math.min(low, s.mid());
        },
        100,
      );
      const fired = stops ? s.bots<StopLosses>(BotKind.StopLosses)[0].fired : 0;
      return { bps: ((start - low) / start) * 1e4, fired };
    };
    const plain = drawdown(false);
    const cascade = drawdown(true);
    expect(cascade.fired).toBeGreaterThan(5);
    expect(cascade.bps).toBeGreaterThan(plain.bps * 1.3);
  });
});

describe("momentum and mean reversion", () => {
  test("momentum raises return autocorrelation; mean reversion lowers it", () => {
    const base = autocorrelation(midPath(setup()));
    const momentum = autocorrelation(
      midPath(setup({ extraBots: "momentum:4" })),
    );
    const reversion = autocorrelation(
      midPath(setup({ extraBots: "meanReversion:4" })),
    );
    expect(momentum).toBeGreaterThan(base + 0.05);
    expect(reversion).toBeLessThan(base - 0.04);
  }, 30_000);
});

describe("iceberg", () => {
  test("shows a slice at a time and refills until done", () => {
    const s = setup();
    s.run(5_000);
    const ice = s.sim.control.addBot(RIC, BotKind.Iceberg, {
      side: "SELL",
      totalQty: "6000",
      displayQty: "500",
      peg: "touch",
    }) as Iceberg;
    s.sim.control.addBot(RIC, BotKind.AggressiveTrader, {
      side: "BUY",
      notionalUsd: "3000000",
      durationSecs: "30",
    });
    let maxShown = 0;
    s.run(
      30_000,
      () => {
        maxShown = Math.max(maxShown, ice.port.restingQty().ask);
      },
      100,
    );
    expect(ice.refills).toBeGreaterThan(3);
    expect(maxShown).toBeLessThanOrEqual(600);
    expect(ice.filled).toBeGreaterThan(2_000);
    expect(ice.filled).toBeLessThanOrEqual(6_000);
  });
});

describe("informed trader", () => {
  const afterNews = (halfLife: number) => {
    const s = setup();
    s.sim.control.setBotParams(
      { kind: BotKind.MarketMaker },
      "fairHalfLifeSecs",
      String(halfLife),
    );
    s.run(20_000);
    s.sim.control.shiftFairValue(RIC, 100, {}, 20);
    s.run(40_000);
    const [inf] = s.sim.getBots(RIC).filter((b) => b.kind === BotKind.Informed);
    return {
      volume: inf.port.ledger.volume,
      pnl: inf.port.ledger.totalPnl(s.book().model.fairValue),
      events: s.sim.control.recent.map((e) => e.action),
    };
  };

  test("profits from news while the makers lag; nothing to do without lag", () => {
    const lag = afterNews(10);
    expect(lag.events).toContain("addBot");
    expect(lag.volume).toBeGreaterThan(0);
    expect(lag.pnl).toBeGreaterThan(0);
    const none = afterNews(0);
    expect(none.volume).toBeLessThan(lag.volume / 4);
  });
});

describe("order port limits", () => {
  test("a breach pulls and pauses the bot and is logged", () => {
    const s = setup();
    s.run(5_000);
    const bot = s.sim.control.addBot(RIC, BotKind.AggressiveTrader, {
      notionalUsd: "2000000",
      durationSecs: "10",
      maxPositionUsd: "100000",
    });
    s.run(5_000);
    expect(bot.port.paused).toBe(true);
    const breach = s.sim.control.recent.find(
      (e) => e.action === "botLimitBreach",
    );
    expect(breach?.target).toBe(bot.id);
    expect(breach?.user).toBe("limits");
    expect(JSON.parse(String(breach?.details)).reason).toContain(
      "maxPositionUsd",
    );
  });

  test("string options are checked", () => {
    const s = setup();
    const bot = s.sim.control.addBot(RIC, BotKind.Iceberg, {});
    expect(() =>
      s.sim.control.setBotParams({ botId: bot.id }, "peg", "sideways"),
    ).toThrow("peg must be one of fixed, touch, fair");
  });
});

describe("phase 4 scenarios", () => {
  test("flash-crash: sell-off, halt, resume, then the added bots go with the revert", () => {
    const s = setup();
    s.run(10_000);
    const start = s.mid();
    let low = start;
    const run = s.sim.scenarios.run("flash-crash", { rics: [RIC] });
    s.run(
      24_000,
      () => {
        low = Math.min(low, s.mid());
      },
      100,
    );
    expect(((start - low) / start) * 1e4).toBeGreaterThan(50);
    s.run(2_000);
    expect(s.book().phase).toBe("HALTED");
    s.run(30_000);
    expect(s.book().phase).toBe("CONTINUOUS");
    s.run(5_000);
    expect(run.status).toBe("DONE");
    expect(s.sim.getBots(RIC).map((b) => b.localId)).toEqual([
      "MM1",
      "MM2",
      "TAKER1",
      "TAKER2",
      "TAKER3",
    ]);
    const [mm] = s.bots<MarketMaker>(BotKind.MarketMaker);
    expect(mm.params.pullMoveBps).toBe(0);
  }, 30_000);

  test("news-jump adds an informed trader that trades the lag", () => {
    const s = setup();
    s.run(10_000);
    s.sim.scenarios.run("news-jump", { rics: [RIC] });
    s.run(30_000);
    const [inf] = s.sim.getBots(RIC).filter((b) => b.kind === BotKind.Informed);
    expect(inf.port.ledger.volume).toBeGreaterThan(0);
    s.run(70_000);
    expect(s.sim.getBots(RIC).some((b) => b.kind === BotKind.Informed)).toBe(
      false,
    );
  }, 30_000);
});
