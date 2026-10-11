import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import {
  type CreateOrderRequest,
  OrdType,
  Side,
} from "@heswell/trading-schemas";
import { OmsEngine, type OmsEngineOptions } from "../src/engine/OmsEngine";
import { DelayedGateway, ManualScheduler } from "../src/engine/gateway";
import { SEED_ACCOUNTS } from "../src/reference/accounts";

export { BookSide };
export const AAPL = "AAPL.OQ";
export const VOD = "VOD.L";

export interface SetupOptions extends Partial<OmsEngineOptions> {
  /** One-way gateway latency (ms) driven by a ManualScheduler. */
  latencyMs?: number;
}

/** A real exchange-sim (no bots) + OmsEngine with a deterministic clock. */
export const setup = ({ latencyMs = 0, ...options }: SetupOptions = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: `${AAPL},${VOD}`, mmRate: 0, takerRate: 0 },
  });
  const scheduler = new ManualScheduler();
  const gateway =
    latencyMs > 0
      ? new DelayedGateway(sim.gateway, latencyMs, scheduler.schedule)
      : sim.gateway;
  const log: string[] = [];
  const engine = new OmsEngine({
    gateway,
    accounts: SEED_ACCOUNTS,
    clock: clock.now,
    log: (m) => log.push(m),
    ...options,
  });
  let n = 0;
  /** Resting liquidity from a "bot" (not the OMS). */
  const rest = (ric: string, side: BookSide, price: number, size: number) => {
    const id = `bot${++n}`;
    sim.getBook(ric)?.limit({ id, side, price, size });
    return id;
  };
  const order = (o: Partial<CreateOrderRequest> = {}): CreateOrderRequest => ({
    account: "ACC-US-01",
    ric: AAPL,
    side: Side.Buy,
    ordType: OrdType.Limit,
    quantity: 100,
    price: 170,
    ...o,
  });
  const ctx = { user: "alice" };
  const create = (o: Partial<CreateOrderRequest> = {}) => {
    const result = engine.createOrder(order(o), ctx);
    if (!result.ok) throw Error(`${result.reason}: ${result.text}`);
    return result.value.orderId;
  };
  const status = (orderId: string) => engine.getOrder(orderId)?.state;
  return {
    clock,
    sim,
    gateway,
    scheduler,
    engine,
    rest,
    order,
    ctx,
    create,
    status,
    log,
  };
};
