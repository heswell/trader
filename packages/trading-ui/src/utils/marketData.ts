import {
  type TickSchedule,
  TradingPhase,
  tickScheduleOf,
} from "@heswell/trading-schemas";

const INACTIVE_PHASES = new Set<string>([
  TradingPhase.Halted,
  TradingPhase.Closed,
  TradingPhase.PostClose,
]);

/** Display text for a trading phase. */
export const tradingPhaseText: Record<string, string> = {
  [TradingPhase.Halted]: "Trading halted",
  [TradingPhase.Closed]: "Market closed",
  [TradingPhase.PostClose]: "Market closed (post-close)",
  [TradingPhase.PreOpen]: "Pre-open",
  [TradingPhase.OpeningAuction]: "Opening auction",
  [TradingPhase.ClosingAuction]: "Closing auction",
  [TradingPhase.Continuous]: "Continuous trading",
};

/** HALTED, CLOSED or POST_CLOSE: no continuous trading, book frozen/empty. */
export const isInactivePhase = (phase: unknown) =>
  typeof phase === "string" && INACTIVE_PHASES.has(phase);

/** Tick schedule from instrument static data (bands take precedence). */
export const instrumentTickSchedule = (
  instrument: { tickSize?: number; tickBands?: string } | undefined,
): TickSchedule | undefined =>
  instrument?.tickSize
    ? tickScheduleOf({
        tickSize: instrument.tickSize,
        tickBands: instrument.tickBands || undefined,
      })
    : undefined;
