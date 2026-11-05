import { AlgoStrategy, TimeInForce } from "./enums";

/**
 * Strategy definitions: what the order ticket shows and validates for each
 * way of working an order. A new strategy is a new entry here (plus its OMS
 * implementation); the ticket renders, validates and summarises it from the
 * definition, with no strategy-specific UI code.
 */

/** How a parameter is entered and sent. */
export type AlgoParamType =
  /** Minutes (number). Input accepts `45`, `45m`, `1h`, `1h30`. */
  | "duration"
  /** Session time "HH:MM". Input accepts `15:30` or `1530`. */
  | "time"
  /** Percent (number). Input accepts `10` or `10%`. */
  | "percent";

export interface AlgoParamDefinition {
  /** The createOrder request field the value is sent as. */
  key: "durationMins" | "endTime" | "participationPct";
  label: string;
  type: AlgoParamType;
  /** Unit shown beside the label. */
  unit?: string;
  required?: boolean;
  /** Inclusive range (duration, percent). */
  min?: number;
  max?: number;
  /** Shown when empty; describes the default the OMS applies. */
  placeholder?: string;
  /** One-click values (input text; "close" = empty, the OMS default). */
  quick?: readonly string[];
}

export type AlgoStrategyGroup = "Direct" | "Schedule" | "Liquidity" | "Close";

export interface AlgoStrategyDefinition {
  id: AlgoStrategy;
  name: string;
  group: AlgoStrategyGroup;
  /** One line, shown in the picker and under it. */
  description: string;
  /** Times in force the OMS accepts for this strategy. */
  timeInForce: readonly TimeInForce[];
  params: readonly AlgoParamDefinition[];
}

const DURATION = {
  key: "durationMins",
  type: "duration",
  unit: "min",
  min: 1,
  max: 1440,
} as const;

export const ALGO_STRATEGY_DEFINITIONS: readonly AlgoStrategyDefinition[] =
  Object.freeze([
    {
      id: AlgoStrategy.Dma,
      name: "DMA",
      group: "Direct",
      description: "Straight to the market, no slicing",
      timeInForce: [
        TimeInForce.Day,
        TimeInForce.GoodTillCancel,
        TimeInForce.ImmediateOrCancel,
        TimeInForce.FillOrKill,
      ],
      params: [],
    },
    {
      id: AlgoStrategy.Twap,
      name: "TWAP",
      group: "Schedule",
      description: "Even slices over a duration",
      timeInForce: [TimeInForce.Day, TimeInForce.GoodTillCancel],
      params: [
        {
          ...DURATION,
          label: "Duration",
          placeholder: "30",
          quick: ["15m", "30m", "1h"],
        },
      ],
    },
    {
      id: AlgoStrategy.Vwap,
      name: "VWAP",
      group: "Schedule",
      description: "Follows the volume curve to an end time",
      timeInForce: [TimeInForce.Day, TimeInForce.GoodTillCancel],
      params: [
        {
          key: "endTime",
          label: "End time",
          type: "time",
          placeholder: "Close",
          quick: ["15:00", "15:30", "16:00", "close"],
        },
      ],
    },
    {
      id: AlgoStrategy.Pov,
      name: "POV",
      group: "Liquidity",
      description: "A share of market volume",
      timeInForce: [TimeInForce.Day, TimeInForce.GoodTillCancel],
      params: [
        {
          key: "participationPct",
          label: "Participation",
          type: "percent",
          unit: "%",
          required: true,
          min: 1,
          max: 50,
          placeholder: "10",
          quick: ["5%", "10%", "20%"],
        },
        {
          ...DURATION,
          label: "Until",
          placeholder: "Close",
          quick: ["30m", "1h", "close"],
        },
      ],
    },
  ] satisfies AlgoStrategyDefinition[]);

/** Display order of the picker's groups. */
export const ALGO_STRATEGY_GROUPS: readonly AlgoStrategyGroup[] = [
  "Direct",
  "Schedule",
  "Liquidity",
  "Close",
];

const BY_ID = new Map(ALGO_STRATEGY_DEFINITIONS.map((d) => [d.id, d]));

/** The definition of a strategy (DMA when unknown or undefined). */
export const algoStrategyDefinition = (
  id: AlgoStrategy | string | undefined,
): AlgoStrategyDefinition =>
  BY_ID.get((id ?? AlgoStrategy.Dma) as AlgoStrategy) ??
  (BY_ID.get(AlgoStrategy.Dma) as AlgoStrategyDefinition);
