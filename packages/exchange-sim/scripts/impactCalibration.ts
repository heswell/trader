/**
 * Measures TAKER_FLOW_FACTOR (src/engine/impact.ts) and checks the
 * calibration: how much variance aggressive flow adds per wall second, and
 * the realised volatility of fair value with and without impact.
 *
 *   bun run --cwd packages/exchange-sim scripts/impactCalibration.ts [--seconds=600]
 */
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { TAKER_FLOW_FACTOR } from "../src/engine/impact";
import { SECONDS_PER_YEAR } from "../src/engine/PriceModel";
import { ManualClock } from "../src/util/clock";

const arg = (name: string, fallback: number) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const seconds = arg("seconds", 600);
const instruments =
  "AAL.L,AAPL.OQ,BRKb.N,0001.HK,SAPG.DE,ASML.AS,LVMH.PA,ENI.MI";

const run = (impactVolShare: number) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments, defaultVolatility: 0.3, impactVolShare },
  });
  const flow = new Map<string, { sum: number; sumSq: number; n: number }>();
  const fairs = new Map<string, number[]>();
  for (const book of sim.books) {
    const acc = { sum: 0, sumSq: 0, n: 0 };
    flow.set(book.ric, acc);
    fairs.set(book.ric, []);
    const model = book.model;
    const apply = model.applyImpact.bind(model);
    const base =
      (sim.getSimulated(book.ric)?.baseQty ?? 1) *
      book.instrument.refPrice *
      book.instrument.usdPerPriceUnit;
    model.applyImpact = (sign, notional) => {
      acc.sum += (sign * notional) / base;
      apply(sign, notional);
    };
  }
  for (let t = 0; t < seconds * 1000; t += 20) {
    sim.step(clock.advance(20));
    if ((t + 20) % 1000 === 0) {
      for (const book of sim.books) {
        const acc = flow.get(book.ric) as {
          sum: number;
          sumSq: number;
          n: number;
        };
        acc.sumSq += acc.sum ** 2;
        acc.sum = 0;
        acc.n++;
        fairs.get(book.ric)?.push(book.model.fairValue);
      }
    }
  }
  let factor = 0;
  let vol = 0;
  for (const book of sim.books) {
    const acc = flow.get(book.ric) as { sumSq: number; n: number };
    factor += acc.sumSq / acc.n / sim.config.takerRate;
    // 10s log returns, annualised on the model clock
    const f = fairs.get(book.ric) as number[];
    let ss = 0;
    let m = 0;
    for (let i = 10; i < f.length; i += 10) {
      ss += Math.log(f[i] / f[i - 10]) ** 2;
      m++;
    }
    vol += Math.sqrt(
      (ss / m) * (SECONDS_PER_YEAR / (10 * sim.config.timeScale)),
    );
  }
  const k = sim.books[0]?.model.impact.k ?? 0;
  return { factor: factor / sim.books.length, vol: vol / sim.books.length, k };
};

const off = run(0);
const on = run(0.25);
console.log(
  `flow factor (impact off): ${off.factor.toFixed(2)} (TAKER_FLOW_FACTOR ${TAKER_FLOW_FACTOR})`,
);
console.log(`flow factor (impact on):  ${on.factor.toFixed(2)}`);
console.log(`k = ${(on.k * 1e4).toFixed(1)} bps per $100k at 30% vol`);
console.log(
  `realised vol, 10s returns: off ${off.vol.toFixed(3)}, on ${on.vol.toFixed(3)} (target 0.300)`,
);
