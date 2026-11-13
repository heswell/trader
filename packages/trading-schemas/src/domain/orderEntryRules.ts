import { algoStrategyDefinition } from "./algoStrategies";
import {
  AlgoStrategy,
  isStopOrdType,
  OrdType,
  STOP_TIME_IN_FORCE_VALUES,
  TimeInForce,
  TradingPhase,
} from "./enums";

/**
 * Order ticket rules shared by the OMS (orderEntry rows) and the ticket UI:
 * which strategy, order type and time in force go together.
 */

/** Display name of an order type ("Stop limit"). */
export const ORD_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  [OrdType.Limit]: "Limit",
  [OrdType.Market]: "Market",
  [OrdType.Stop]: "Stop",
  [OrdType.StopLimit]: "Stop limit",
});

/** Times in force offered on the ticket, in display order. */
export const ORDER_TICKET_TIFS: readonly TimeInForce[] = [
  TimeInForce.Day,
  TimeInForce.ImmediateOrCancel,
  TimeInForce.FillOrKill,
  TimeInForce.GoodTillCancel,
];

/** Whether the strategy slices the order over time (anything but DMA). */
export const isAlgoStrategy = (strategy: AlgoStrategy | string | undefined) =>
  strategy !== undefined && strategy !== "" && strategy !== AlgoStrategy.Dma;

/**
 * Stop orders are worked by the OMS as DMA only: a strategy other than DMA
 * can't be combined with STOP / STOP_LIMIT.
 */
export const isStrategyAllowed = (
  ordType: OrdType | string,
  strategy: AlgoStrategy | string | undefined,
) => !(isStopOrdType(ordType as OrdType) && isAlgoStrategy(strategy));

/**
 * The order type an algo strategy turns a stop into: STOP → MARKET,
 * STOP_LIMIT → LIMIT (other types unchanged).
 */
export const nonStopOrdType = (ordType: OrdType): OrdType =>
  ordType === OrdType.Stop
    ? OrdType.Market
    : ordType === OrdType.StopLimit
      ? OrdType.Limit
      : ordType;

/**
 * TIFs the OMS accepts for an order type, strategy and trading phase: the
 * strategy definition's list, less GTC for MARKET, only DAY / GTC for stops,
 * and no IOC / FOK outside continuous trading.
 */
export const isTimeInForceAllowed = (
  ordType: OrdType | string,
  tif: TimeInForce | string,
  strategy?: AlgoStrategy | string,
  phase?: string,
) =>
  algoStrategyDefinition(
    (strategy || undefined) as AlgoStrategy | undefined,
  ).timeInForce.includes(tif as TimeInForce) &&
  !(ordType === OrdType.Market && tif === TimeInForce.GoodTillCancel) &&
  !(
    isStopOrdType(ordType as OrdType) &&
    !STOP_TIME_IN_FORCE_VALUES.includes(tif as TimeInForce)
  ) &&
  !(
    phase &&
    phase !== TradingPhase.Continuous &&
    (tif === TimeInForce.ImmediateOrCancel || tif === TimeInForce.FillOrKill)
  );

/** The TIFs to offer, in display order. */
export const allowedTimesInForce = (
  ordType: OrdType | string,
  strategy?: AlgoStrategy | string,
  phase?: string,
) =>
  ORDER_TICKET_TIFS.filter((tif) =>
    isTimeInForceAllowed(ordType, tif, strategy, phase),
  );
