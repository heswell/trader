import { roundToLot } from "@heswell/trading-schemas";
import {
  type BotCreateOptions,
  BotKind,
  type BotKindDef,
  type BotStepContext,
} from "./Bot";
import { LIMIT_SPECS, num, specs } from "./common";
import { DirectionalBot } from "./Directional";

/**
 * Trend follower: the gap between the 10s and 60s mid averages (bps).
 * Beyond `entryBps` it goes long (or short) `targetQty`; it exits when the
 * trend fades under `exitBps`, the price moves `stopLossBps` against it, or
 * after `holdMaxSecs`. Market orders in clips of `clipQty`.
 */
export class Momentum extends DirectionalBot {
  readonly kind = BotKind.Momentum;

  protected target({ now, signals }: BotStepContext) {
    const p = this.params;
    const fast = signals.midEma[1];
    const slow = signals.midEma[2];
    if (!(fast > 0) || !(slow > 0)) return this.position;
    const trend = ((fast - slow) / slow) * 1e4;
    const position = this.position;
    const qty = num(p.targetQty, 0);
    let target = position;
    if (position === 0) {
      if (trend > num(p.entryBps, 5)) target = qty;
      else if (trend < -num(p.entryBps, 5)) target = -qty;
    } else {
      const dir = Math.sign(position);
      const adverse =
        this.entryPrice > 0
          ? ((this.entryPrice - signals.price) / this.entryPrice) * 1e4 * dir
          : 0;
      const held = this.openedAt > 0 ? (now - this.openedAt) / 1000 : 0;
      if (
        trend * dir < num(p.exitBps, 1) ||
        adverse > num(p.stopLossBps, 25) ||
        held > num(p.holdMaxSecs, 120)
      )
        target = 0;
      else target = dir * qty;
    }
    this.lastTarget = target;
    return target;
  }
}

export const MOMENTUM: BotKindDef = Object.freeze({
  kind: BotKind.Momentum,
  stage: "take",
  idPrefix: "MO",
  localId: (n: number) => `MOM${n}`,
  account: (n: number) => `MOM${n}`,
  limits: true,
  paramSpec: specs([
    {
      name: "entryBps",
      type: "number",
      description: "Trend (10s over 60s mid average) to enter at",
      min: 0,
      unit: "bps",
    },
    {
      name: "exitBps",
      type: "number",
      description:
        "Exit when the trend in the position's direction falls under this",
      unit: "bps",
    },
    {
      name: "stopLossBps",
      type: "number",
      description: "Exit after this adverse move from the entry",
      min: 0,
      unit: "bps",
    },
    {
      name: "holdMaxSecs",
      type: "number",
      description: "Exit after holding this long",
      min: 0,
      unit: "s",
    },
    {
      name: "targetQty",
      type: "number",
      description: "Position to take",
      min: 0,
      unit: "shares",
    },
    {
      name: "clipQty",
      type: "number",
      description: "Most traded per check",
      min: 0,
      unit: "shares",
    },
    {
      name: "checkSecs",
      type: "number",
      description: "Seconds between decisions",
      min: 0.05,
      unit: "s",
    },
    ...LIMIT_SPECS,
  ]),
  create({ localId, book, port, rng, baseQty, params = {} }: BotCreateOptions) {
    const lot = book.instrument.lotSize;
    const targetQty = num(params.targetQty, roundToLot(baseQty * 8, lot));
    return new Momentum(
      localId,
      {
        entryBps: num(params.entryBps, 4),
        exitBps: num(params.exitBps, 1),
        stopLossBps: num(params.stopLossBps, 25),
        holdMaxSecs: num(params.holdMaxSecs, 120),
        targetQty,
        clipQty: num(
          params.clipQty,
          Math.max(lot, roundToLot(targetQty / 4, lot)),
        ),
        checkSecs: num(params.checkSecs, 1),
        maxPositionUsd: num(params.maxPositionUsd, 0),
        maxOrdersPerSec: num(params.maxOrdersPerSec, 0),
      },
      port,
      rng,
    );
  },
});
