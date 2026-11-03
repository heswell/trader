import {
  AlgoStrategy,
  type CreateOrderRequest,
  clockAtSessionMinute,
  isSessionOpen,
  nextOpenAt,
  RejectReason,
  type SessionSchedule,
  sessionCloseAt,
  sessionToClockMs,
  TimeInForce,
} from "@heswell/trading-schemas";

/** Algo settings and progress, stored on the parent order (and journaled with it). */
export interface AlgoState {
  /** Clock time the algo starts slicing (the next open when created while closed). */
  startAt: number;
  /** Clock time the algo must finish by; 0 = none (open-ended POV). */
  endAt: number;
  /** POV target share of market volume, 0..1; 0 for other strategies. */
  participation: number;
  /**
   * WORKING: slicing. The others wind the order down: live children are
   * cancelled, then the parent gets the matching final event.
   */
  phase: AlgoPhase;
  /** Amend applied once the live children are out (phase AMENDING). */
  pendingAmend?: { quantity: number; price: number };
  /** Text of the EXPIRED event (phase FINISHING). */
  finishText?: string;
  /** POV: market volume (excluding this order's fills) since startAt. */
  marketVolume: number;
  /** Quantity the schedule says should be filled by now. */
  targetQty: number;
}

export type AlgoPhase =
  | "WORKING"
  | "AMENDING"
  | "CANCELLING"
  | "FINISHING"
  | "DONE";

export const DEFAULT_TWAP_MINUTES = 30;

type Resolved =
  | { ok: true; algo: AlgoState }
  | { ok: false; reason: RejectReason; text: string };

const invalid = (text: string): Resolved => ({
  ok: false,
  reason: RejectReason.InvalidRequest,
  text,
});

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Work out an algo's start / end clock times from the createOrder params.
 * Times are session times (see SessionSchedule): durations are scaled when
 * the exchange runs a compressed day. A DAY order never runs past the close.
 */
export const resolveAlgoParams = (
  request: CreateOrderRequest,
  schedule: SessionSchedule,
  now: number,
): Resolved => {
  const strategy = request.strategy ?? AlgoStrategy.Dma;
  const tif = request.timeInForce ?? TimeInForce.Day;
  if (tif !== TimeInForce.Day && tif !== TimeInForce.GoodTillCancel) {
    return {
      ok: false,
      reason: RejectReason.UnsupportedTimeInForce,
      text: `${tif} is not valid for ${strategy} orders`,
    };
  }
  const { durationMins, endTime, participationPct } = request;
  if (durationMins !== undefined && endTime !== undefined) {
    return invalid("give durationMins or endTime, not both");
  }
  let endMinute: number | undefined;
  if (endTime !== undefined) {
    const match = HH_MM.exec(endTime);
    if (!match) return invalid(`endTime '${endTime}' is not HH:MM`);
    endMinute = Number(match[1]) * 60 + Number(match[2]);
  }
  if (strategy === AlgoStrategy.Pov && !participationPct) {
    return invalid("participationPct is required for POV");
  }

  const startAt =
    schedule.scheduled && !isSessionOpen(schedule, now)
      ? (nextOpenAt(schedule, now) ?? now)
      : now;
  const close = sessionCloseAt(schedule, startAt);

  let endAt: number | undefined;
  if (durationMins !== undefined) {
    endAt = startAt + sessionToClockMs(schedule, durationMins * 60_000);
  } else if (endMinute !== undefined) {
    endAt = clockAtSessionMinute(schedule, startAt, endMinute);
  } else if (strategy === AlgoStrategy.Twap) {
    endAt = startAt + sessionToClockMs(schedule, DEFAULT_TWAP_MINUTES * 60_000);
  } else if (strategy === AlgoStrategy.Vwap) {
    if (close === undefined) {
      return invalid(
        "VWAP needs durationMins or endTime when the market has no session close",
      );
    }
    endAt = close;
  } else {
    endAt = close; // POV: to the close, or open-ended with no schedule
  }
  // VWAP follows the session's volume curve, so never runs past the close;
  // nor does a DAY order.
  if (
    close !== undefined &&
    endAt !== undefined &&
    (strategy === AlgoStrategy.Vwap || tif === TimeInForce.Day)
  ) {
    endAt = Math.min(endAt, close);
  }
  if (endAt !== undefined && endAt <= startAt) {
    return invalid("the algo end time is not after its start");
  }
  return {
    ok: true,
    algo: {
      startAt,
      endAt: endAt ?? 0,
      participation:
        strategy === AlgoStrategy.Pov ? (participationPct ?? 0) / 100 : 0,
      phase: "WORKING",
      marketVolume: 0,
      targetQty: 0,
    },
  };
};
