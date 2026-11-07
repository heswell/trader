import { roundToLot } from "@heswell/trading-schemas";
import {
  type BotCreateOptions,
  BotKind,
  type BotKindDef,
  type BotStepContext,
} from "./Bot";
import { LIMIT_SPECS, num, pick, specs } from "./common";
import { DirectionalBot } from "./Directional";

export const MR_ANCHORS = ["ema", "fair"] as const;

/**
 * Fades moves away from a value: the 60s mid average (`anchor: ema`) or
 * the true fair value (`anchor: fair`, an informed version). Beyond
 * `entryBps` it leans against the gap, `maxQty` at `fullBps`; it unwinds
 * as the gap closes under `exitBps`. Crosses the spread by default:
 * `passive` joins the touch instead, which adds depth (damping the bid-ask
 * bounce) rather than pulling the price back.
 */
export class MeanReversion extends DirectionalBot {
  readonly kind = BotKind.MeanReversion;

  #gapBps({ signals }: BotStepContext) {
    const anchor =
      pick(this.params.anchor, MR_ANCHORS, "ema") === "fair"
        ? this.book.model.fairValue
        : signals.midEma[2];
    const price = signals.price;
    if (!(anchor > 0) || !(price > 0)) return 0;
    return ((price - anchor) / anchor) * 1e4;
  }

  protected target(ctx: BotStepContext) {
    const p = this.params;
    const gap = this.#gapBps(ctx);
    const entry = num(p.entryBps, 8);
    const full = Math.max(entry, num(p.fullBps, 25));
    const maxQty = num(p.maxQty, 0);
    const position = this.position;
    let target: number;
    if (Math.abs(gap) >= entry) {
      const f = Math.min(1, Math.abs(gap) / full);
      target =
        -Math.sign(gap) * roundToLot(maxQty * f, this.book.instrument.lotSize);
      // keep a bigger position from an earlier, larger gap until it closes
      if (
        Math.sign(target) === Math.sign(position) &&
        Math.abs(position) > Math.abs(target)
      )
        target = position;
    } else if (Math.abs(gap) <= num(p.exitBps, 2)) target = 0;
    else target = position;
    this.lastTarget = target;
    return target;
  }

  protected passive() {
    return this.params.passive === true;
  }
}

export const MEAN_REVERSION: BotKindDef = Object.freeze({
  kind: BotKind.MeanReversion,
  stage: "take",
  idPrefix: "MR",
  localId: (n: number) => `MR${n}`,
  account: (n: number) => `MR${n}`,
  limits: true,
  paramSpec: specs([
    {
      name: "anchor",
      type: "string",
      description:
        "Value it reverts to: ema (60s mid average) or fair (true fair value)",
      options: MR_ANCHORS,
    },
    {
      name: "entryBps",
      type: "number",
      description: "Gap from the anchor to start leaning at",
      min: 0,
      unit: "bps",
    },
    {
      name: "fullBps",
      type: "number",
      description: "Gap at which it holds maxQty",
      min: 0,
      unit: "bps",
    },
    {
      name: "exitBps",
      type: "number",
      description: "Unwind when the gap is under this",
      min: 0,
      unit: "bps",
    },
    {
      name: "maxQty",
      type: "number",
      description: "Largest position",
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
      name: "passive",
      type: "boolean",
      description: "Join the touch instead of crossing the spread",
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
    const maxQty = num(params.maxQty, roundToLot(baseQty * 8, lot));
    return new MeanReversion(
      localId,
      {
        anchor: pick(params.anchor, MR_ANCHORS, "ema"),
        entryBps: num(params.entryBps, 6),
        fullBps: num(params.fullBps, 20),
        exitBps: num(params.exitBps, 2),
        maxQty,
        clipQty: num(
          params.clipQty,
          Math.max(lot, roundToLot(maxQty / 4, lot)),
        ),
        passive: params.passive === true,
        checkSecs: num(params.checkSecs, 1),
        maxPositionUsd: num(params.maxPositionUsd, 0),
        maxOrdersPerSec: num(params.maxOrdersPerSec, 0),
      },
      port,
      rng,
    );
  },
});
