import { Side } from "@heswell/trading-schemas";
import type { InstrumentDef } from "../reference/instruments";
import { Random } from "../util/random";
import type { TapeTrade } from "./MarketDataPublisher";

/** Mean gap between seeded trades (ms). */
const GAP_MS = 5;

/**
 * `count` historical trades over `instruments`, oldest first, ending just
 * before `now`: a random walk from each instrument's refPrice (within ±10%),
 * sizes of 1–50 lots. For a large trades table at startup
 * (exchangeSim.tradesSeed); ids `TH…` never collide with live `TR…` ids.
 */
export function* seedTrades(
  count: number,
  instruments: readonly InstrumentDef[],
  now: number,
  seed = 1,
): Generator<TapeTrade> {
  if (count <= 0 || instruments.length === 0) return;
  const random = new Random(seed);
  const prices = instruments.map((def) => def.refPrice);
  const seqs = instruments.map(() => 0);
  let timestamp = now - count * GAP_MS - 1_000;
  for (let i = 0; i < count; i++) {
    const n = random.int(0, instruments.length - 1);
    const def = instruments[n];
    const step = 1 + (random.next() - 0.5) * 0.002;
    prices[n] = Math.min(
      def.refPrice * 1.1,
      Math.max(def.refPrice * 0.9, prices[n] * step),
    );
    const scale = 10 ** def.priceDecimals;
    timestamp += random.int(1, 2 * GAP_MS - 1);
    yield {
      tradeId: `TH${String(i + 1).padStart(9, "0")}`,
      ric: def.ric,
      price: Math.round(prices[n] * scale) / scale,
      size: random.int(1, 50) * (def.lotSize || 1),
      aggressorSide: random.chance(0.5) ? Side.Buy : Side.Sell,
      timestamp,
      seq: ++seqs[n],
    };
  }
}
