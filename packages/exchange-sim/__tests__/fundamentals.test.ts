import { describe, expect, test } from "bun:test";
import { InstrumentType } from "@heswell/trading-schemas";
import {
  generateFundamentals,
  MAX_MARKET_CAP_USD,
  MEGA_CAPS,
  MIN_MARKET_CAP_USD,
  ratiosAt,
  SECTOR_PROFILES,
} from "../src/reference/fundamentals";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { listFutures } from "../src/reference/futures";
import { SYNTHETIC_INDICES, toIndexDef } from "../src/reference/indices";
import {
  ALL_INSTRUMENTS,
  type InstrumentDef,
} from "../src/reference/instruments";
import { Sector } from "../src/reference/sectors";
import { createFakeTables } from "./fakeTables";

const marketCapUsd = (i: InstrumentDef) =>
  (i.fundamentals?.sharesOutstanding ?? 0) * i.refPrice * i.usdPerPriceUnit;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

describe("simulated fundamentals", () => {
  test("every equity has them, with whole positive share counts", () => {
    for (const i of ALL_INSTRUMENTS) {
      expect(i.instrumentType).toBe(InstrumentType.Equity);
      const f = i.fundamentals;
      expect({ ric: i.ric, has: f !== undefined }).toEqual({
        ric: i.ric,
        has: true,
      });
      if (!f) continue;
      expect(Number.isInteger(f.sharesOutstanding)).toBe(true);
      expect(f.sharesOutstanding).toBeGreaterThan(0);
      expect(f.bookValuePerShare).toBeGreaterThan(0);
      expect(f.dividendPerShare).toBeGreaterThanOrEqual(0);
      if (f.eps <= 0) expect(f.dividendPerShare).toBe(0);
      expect(f.roe).toBeCloseTo((100 * f.eps) / f.bookValuePerShare, 1);
    }
  });

  test("are deterministic per ric and independent of the universe", () => {
    const vod = ALL_INSTRUMENTS.find((i) => i.ric === "VOD.L");
    if (!vod) throw Error("no VOD.L");
    const again = generateFundamentals(vod);
    expect(again).toEqual(vod.fundamentals as NonNullable<typeof again>);
    const other = generateFundamentals({ ...vod, ric: "VOD2.L" });
    expect(other).not.toEqual(again);
  });

  test("market caps are in USD, within bounds, mega caps on top", () => {
    for (const i of ALL_INSTRUMENTS) {
      const cap = marketCapUsd(i);
      // whole shares: allow a rounding margin for low-priced names
      expect(cap).toBeGreaterThan(MIN_MARKET_CAP_USD * 0.99);
      if (MEGA_CAPS.has(i.ric)) expect(cap).toBeGreaterThanOrEqual(1e12 * 0.99);
      else expect(cap).toBeLessThanOrEqual(MAX_MARKET_CAP_USD * 1.01);
    }
    const top = [...ALL_INSTRUMENTS]
      .sort((a, b) => marketCapUsd(b) - marketCapUsd(a))
      .slice(0, MEGA_CAPS.size)
      .map((i) => i.ric);
    expect(new Set(top)).toEqual(new Set(MEGA_CAPS));
  });

  test("GBX prices: EPS in pence, cap converted at the pence rate", () => {
    const vod = ALL_INSTRUMENTS.find((i) => i.ric === "VOD.L");
    const f = vod?.fundamentals;
    if (!vod || !f) throw Error("no VOD.L");
    expect(vod.usdPerPriceUnit).toBeCloseTo(0.0127, 6);
    if (f.eps > 0) {
      const pe = vod.refPrice / f.eps;
      expect(pe).toBeGreaterThan(4);
      expect(pe).toBeLessThan(120);
    }
  });

  test("sector medians follow their profiles", () => {
    for (const sector of Object.values(Sector)) {
      const names = ALL_INSTRUMENTS.filter((i) => i.sector === sector);
      if (names.length < 10) continue;
      const profile = SECTOR_PROFILES[sector];
      const pes = names.flatMap(({ fundamentals: f, refPrice }) =>
        f && f.eps > 0 ? [refPrice / f.eps] : [],
      );
      const roes = names.flatMap(({ fundamentals: f }) =>
        f && f.eps > 0 ? [f.roe] : [],
      );
      // log distance within 0.35 (about x1.4 either way)
      expect({
        sector,
        pe: Math.abs(Math.log(median(pes) / profile.pe)) < 0.35,
        roe: Math.abs(Math.log(median(roes) / profile.roe)) < 0.35,
      }).toEqual({ sector, pe: true, roe: true });
    }
  });

  test("banks and real estate trade near book, tech well above", () => {
    const pbOf = (sector: Sector) =>
      median(
        ALL_INSTRUMENTS.filter((i) => i.sector === sector).map(
          (i) => i.refPrice / (i.fundamentals?.bookValuePerShare ?? 1),
        ),
      );
    expect(pbOf(Sector.Financials)).toBeLessThan(1.6);
    expect(pbOf(Sector.RealEstate)).toBeLessThan(1.6);
    expect(pbOf(Sector.InformationTechnology)).toBeGreaterThan(4);
  });

  test("indices and futures have none", () => {
    for (const spec of SYNTHETIC_INDICES) {
      expect(toIndexDef(spec, ALL_INSTRUMENTS).fundamentals).toBeUndefined();
    }
    for (const future of listFutures(ALL_INSTRUMENTS, ["AZN.L"], Date.now())) {
      expect(future.fundamentals).toBeUndefined();
    }
  });

  test("the instruments table carries null for non-equities", () => {
    const sim = createExchangeSimulator({
      config: {
        instruments: "AAPL.OQ",
        futures: "AAPL.OQ",
        mmRate: 0,
        takerRate: 0,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const future = [...tables.instruments.rowsByKey.keys()].find(
      (ric) =>
        tables.instruments.get(ric)?.instrumentType === InstrumentType.Future,
    );
    expect(future).toBeDefined();
    const row = tables.instruments.get(future as string);
    for (const field of [
      "sharesOutstanding",
      "eps",
      "bookValuePerShare",
      "dividendPerShare",
      "roe",
    ]) {
      expect(row?.[field]).toBeNull();
    }
    expect(tables.instruments.get("AAPL.OQ")?.eps).toBeGreaterThan(0);
    const prices = tables.prices.get(future as string);
    for (const field of ["marketCapUsd", "pe", "pb", "dividendYield"]) {
      expect(prices?.[field]).toBeNull();
    }
  });

  test("ratiosAt: P/E null for a loss, nothing without fundamentals", () => {
    const fundamentals = {
      sharesOutstanding: 1_000,
      eps: -2,
      bookValuePerShare: 40,
      dividendPerShare: 0,
      roe: -5,
    };
    expect(ratiosAt({ fundamentals, usdPerPriceUnit: 0.5 }, 80)).toEqual({
      marketCapUsd: 40_000,
      pe: null,
      pb: 2,
      dividendYield: 0,
    });
    expect(
      ratiosAt(
        {
          fundamentals: { ...fundamentals, eps: 4, dividendPerShare: 2 },
          usdPerPriceUnit: 1,
        },
        80,
      ),
    ).toMatchObject({ pe: 20, dividendYield: 2.5 });
    expect(ratiosAt({ usdPerPriceUnit: 1 }, 80)).toBeUndefined();
    expect(ratiosAt({ fundamentals, usdPerPriceUnit: 1 }, 0)).toBeUndefined();
  });
});
