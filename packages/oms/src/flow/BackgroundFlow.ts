import type { Random } from "@heswell/exchange-sim";
import {
  type CreateOrderRequest,
  isWorkingStatus,
  OrdType,
  roundToLot,
  Side,
  stepTicks,
  TimeInForce,
  tickScheduleOf,
} from "@heswell/trading-schemas";
import type { OmsEngine } from "../engine/OmsEngine";
import type { OmsGateway } from "../engine/gateway";
import type { Account } from "../reference/accounts";
import { referencePrice } from "../risk/preTradeRisk";

export interface BackgroundFlowOptions {
  engine: OmsEngine;
  gateway: OmsGateway;
  /** Instruments to trade (must have a live book). */
  rics: readonly string[];
  /** Accounts to trade for; each order is entered as the account owner. */
  accounts: readonly Account[];
  random: Random;
  /** Orders per second, total. */
  rate: number;
  notionalUsd: number;
  maxWorking: number;
  cancelRate: number;
}

/**
 * Simulated "other traders": a Poisson stream of orders entered through the
 * OMS (risk, routing and positions apply exactly as for UI orders) so the
 * blotters tick. Mix: passive limits, marketable limits, IOC limits and
 * market IOCs, plus amends / cancels of resting flow orders. Side is skewed
 * to reduce large positions so positions stay within limits.
 */
export class BackgroundFlow {
  readonly orderIds = new Set<string>();
  submitted = 0;
  rejected = 0;
  #carry = 0;

  constructor(private options: BackgroundFlowOptions) {}

  set rate(rate: number) {
    this.options.rate = rate;
  }
  get rate() {
    return this.options.rate;
  }

  /** Advance the flow by elapsed ms (called from a timer or tests). */
  step(elapsedMs: number) {
    const { rate, random, rics, accounts } = this.options;
    if (rate <= 0 || rics.length === 0 || accounts.length === 0) return 0;
    this.#carry += (rate * elapsedMs) / 1000;
    const n = random.poisson(this.#carry);
    this.#carry = 0;
    for (let i = 0; i < n; i++) this.#event();
    return n;
  }

  #working() {
    const { engine } = this.options;
    const working = [];
    for (const orderId of this.orderIds) {
      const order = engine.getOrder(orderId);
      if (!order || !isWorkingStatus(order.state.status)) {
        if (!order || order.state.leavesQty === 0)
          this.orderIds.delete(orderId);
        continue;
      }
      working.push(order);
    }
    return working;
  }

  #event() {
    const { random, maxWorking, cancelRate } = this.options;
    const working = this.#working();
    if (
      working.length > 0 &&
      (working.length >= maxWorking || random.chance(cancelRate))
    ) {
      this.#amendOrCancel(random.pick(working));
    } else {
      this.#newOrder();
    }
  }

  #amendOrCancel(order: NonNullable<ReturnType<OmsEngine["getOrder"]>>) {
    const { engine, gateway, random } = this.options;
    const ctx = { user: order.trader };
    const instrument = gateway.getInstrument(order.ric);
    if (order.ordType === OrdType.Limit && instrument && random.chance(0.35)) {
      const toward = order.side === Side.Buy ? 1 : -1;
      const price = stepTicks(
        order.state.price,
        tickScheduleOf(instrument),
        toward * random.int(1, 3),
      );
      const result = engine.amendOrder({ orderId: order.orderId, price }, ctx);
      if (result.ok) return;
    }
    engine.cancelOrder({ orderId: order.orderId }, ctx);
  }

  #newOrder() {
    const { engine, gateway, random, rics, accounts, notionalUsd } =
      this.options;
    const account = random.pick(accounts);
    const ric = random.pick(rics);
    const instrument = gateway.getInstrument(ric);
    const top = gateway.getTopOfBook(ric);
    if (!instrument || !top) return;
    const ref = referencePrice(instrument, top);
    const schedule = tickScheduleOf(instrument);

    const position = engine.getPosition(account.account, ric);
    const positionUsd =
      (position?.quantity ?? 0) * ref * instrument.usdPerPriceUnit;
    const skew = positionUsd / (account.maxPositionNotional * 0.5);
    const side: Side =
      Math.abs(skew) > 1 && random.chance(0.8)
        ? skew > 0
          ? Side.Sell
          : Side.Buy
        : random.chance(0.5)
          ? Side.Buy
          : Side.Sell;
    const sign = side === Side.Buy ? 1 : -1;

    const targetUsd = Math.min(
      notionalUsd * random.uniform(0.3, 1.5),
      account.maxOrderNotional * 0.8,
    );
    const rawQty = targetUsd / (ref * instrument.usdPerPriceUnit);
    const quantity = Math.min(
      Math.max(instrument.lotSize, roundToLot(rawQty, instrument.lotSize)),
      roundToLot(account.maxOrderQty, instrument.lotSize, "down"),
    );
    if (!(quantity > 0)) return;

    const near = sign > 0 ? top.bid : top.ask;
    const far = sign > 0 ? top.ask : top.bid;
    const roll = random.next();
    let order: Pick<CreateOrderRequest, "ordType" | "price" | "timeInForce">;
    if (roll < 0.5 || !(far > 0)) {
      const base = near > 0 ? near : ref;
      order = {
        ordType: OrdType.Limit,
        price: stepTicks(base, schedule, -sign * random.int(0, 4)),
        timeInForce: TimeInForce.Day,
      };
    } else if (roll < 0.75) {
      order = {
        ordType: OrdType.Limit,
        price: stepTicks(far, schedule, sign * random.int(0, 1)),
        timeInForce: TimeInForce.Day,
      };
    } else if (roll < 0.9) {
      order = {
        ordType: OrdType.Limit,
        price: far,
        timeInForce: TimeInForce.ImmediateOrCancel,
      };
    } else {
      order = {
        ordType: OrdType.Market,
        timeInForce: TimeInForce.ImmediateOrCancel,
      };
    }

    const result = engine.createOrder(
      { account: account.account, ric, side, quantity, ...order },
      { user: account.owner },
    );
    this.submitted++;
    if (result.ok) this.orderIds.add(result.value.orderId);
    else this.rejected++;
  }
}
