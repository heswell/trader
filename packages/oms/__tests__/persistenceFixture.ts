import type { PersistenceStore } from "@heswell/trading-persistence";
import { Side } from "@heswell/trading-schemas";
import type { OmsState } from "../src/engine/OmsEngine";
import { TradingPersistence } from "../src/persistence/TradingPersistence";
import { AAPL, BookSide, type SetupOptions, setup, VOD } from "./fixture";

export const T0 = 1_700_000_000_000;

/** A fresh exchange + OMS "process" recovered from `store`. */
export const boot = (store: PersistenceStore, options: SetupOptions = {}) => {
  const env = setup({ time: T0, ...options });
  const plog: string[] = [];
  const persistence = new TradingPersistence({
    store,
    sim: env.sim,
    engine: env.engine,
    log: (m) => plog.push(m),
  });
  const report = persistence.recover();
  return { ...env, persistence, report, plog };
};

/** Customer (OMS) orders resting in a book, in priority order. */
export const bookOrders = (env: ReturnType<typeof setup>, ric: string) => {
  const snap = env.sim.getBook(ric)?.book.snapshot();
  const side = (levels: NonNullable<typeof snap>["bids"]) =>
    levels.flatMap((level) =>
      level.orders.map((o) => `${o.id} ${o.size}@${o.price}`),
    );
  return { bids: side(snap?.bids ?? []), asks: side(snap?.asks ?? []) };
};

/** Everything a restart must preserve. */
export interface Observed {
  oms: OmsState;
  books: Record<string, { bids: string[]; asks: string[] }>;
  live: string[];
  tradeCount: number;
}

export const observe = (env: ReturnType<typeof boot>): Observed =>
  // JSON round trip: persisted state has no undefined-valued keys.
  JSON.parse(
    JSON.stringify({
      oms: env.engine.exportState(),
      books: { [AAPL]: bookOrders(env, AAPL), [VOD]: bookOrders(env, VOD) },
      live: [...env.sim.gateway.liveOrders()]
        .map((r) => r.exchangeOrderId)
        .sort(),
      tradeCount: env.sim.tradeCount,
    }),
  );

/**
 * A partially filled buy, an amended sell, a cancelled order and a filled
 * order across two instruments.
 */
export const trade = (env: ReturnType<typeof boot>) => {
  env.rest(AAPL, BookSide.SELL, 171, 100);
  const partial = env.create({ quantity: 300, price: 171 });
  env.rest(VOD, BookSide.BUY, 224, 40);
  const filled = env.create({
    ric: VOD,
    side: Side.Sell,
    quantity: 40,
    price: 224,
  });
  const amended = env.create({
    ric: VOD,
    side: Side.Sell,
    quantity: 50,
    price: 226,
  });
  const result = env.engine.amendOrder(
    { orderId: amended, quantity: 80, price: 227 },
    env.ctx,
  );
  if (!result.ok) throw Error(`amend failed: ${result.text}`);
  const cancelled = env.create({ price: 160 });
  if (!env.engine.cancelOrder({ orderId: cancelled }, env.ctx).ok)
    throw Error("cancel failed");
  return { partial, filled, amended, cancelled };
};
