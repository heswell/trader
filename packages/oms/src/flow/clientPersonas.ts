import type { BotParamSpec } from "@heswell/exchange-sim/engine";
import {
  CLIENT_SIDE_MODES,
  ClientPersona,
  ClientSideMode,
  Side,
} from "@heswell/trading-schemas";

/** A client bot's settings (see CLIENT_PARAM_SPECS). */
export interface ClientBotParams {
  sideMode: ClientSideMode;
  /** Programme side mode: the side of every order. */
  programmeSide: Side;
  ordersPerMin: number;
  maxLive: number;
  minNotionalUsd: number;
  maxNotionalUsd: number;
  twapWeight: number;
  vwapWeight: number;
  povWeight: number;
  minDurationMins: number;
  maxDurationMins: number;
  minPovPct: number;
  maxPovPct: number;
  limitBps: number;
  universe: string;
  amendChance: number;
  cancelChance: number;
  informedThresholdBps: number;
}

export type ClientParamName = keyof ClientBotParams;

const spec = (s: BotParamSpec & { name: ClientParamName }) => s;

/** Every client bot parameter, in display order. */
export const CLIENT_PARAM_SPECS: readonly (BotParamSpec & {
  name: ClientParamName;
})[] = Object.freeze([
  spec({
    name: "sideMode",
    type: "string",
    options: CLIENT_SIDE_MODES,
    description:
      "How the side is picked: random, programme (programmeSide), positionReverting, momentum (with the day's move) or informed (towards fair value).",
  }),
  spec({
    name: "programmeSide",
    type: "string",
    options: [Side.Buy, Side.Sell],
    description: "Side of every order in programme mode.",
  }),
  spec({
    name: "ordersPerMin",
    type: "number",
    min: 0,
    max: 600,
    unit: "/ min",
    description:
      "New parent orders per wall-clock minute at average activity (follows the session's volume curve).",
  }),
  spec({
    name: "maxLive",
    type: "integer",
    min: 0,
    max: 100,
    description: "Most working parent orders at once.",
  }),
  spec({
    name: "minNotionalUsd",
    type: "number",
    min: 1_000,
    unit: "USD",
    description: "Smallest parent order (sizes are log-uniform).",
  }),
  spec({
    name: "maxNotionalUsd",
    type: "number",
    min: 1_000,
    unit: "USD",
    description: "Largest parent order, capped by the account's order limit.",
  }),
  spec({
    name: "twapWeight",
    type: "number",
    min: 0,
    description: "Relative chance of a TWAP.",
  }),
  spec({
    name: "vwapWeight",
    type: "number",
    min: 0,
    description: "Relative chance of a VWAP.",
  }),
  spec({
    name: "povWeight",
    type: "number",
    min: 0,
    description: "Relative chance of a POV.",
  }),
  spec({
    name: "minDurationMins",
    type: "number",
    min: 0.5,
    max: 1440,
    unit: "session min",
    description: "Shortest algo duration.",
  }),
  spec({
    name: "maxDurationMins",
    type: "number",
    min: 0.5,
    max: 1440,
    unit: "session min",
    description: "Longest algo duration.",
  }),
  spec({
    name: "minPovPct",
    type: "number",
    min: 1,
    max: 50,
    unit: "%",
    description: "Lowest POV participation.",
  }),
  spec({
    name: "maxPovPct",
    type: "number",
    min: 1,
    max: 50,
    unit: "%",
    description: "Highest POV participation.",
  }),
  spec({
    name: "limitBps",
    type: "number",
    min: 0,
    max: 900,
    unit: "bps",
    description:
      "Parent limit this far through the arrival price; 0 = a market parent.",
  }),
  spec({
    name: "universe",
    type: "string",
    description:
      "Instruments traded: empty = all, a comma separated list of rics, or sector:<name>.",
  }),
  spec({
    name: "amendChance",
    type: "number",
    min: 0,
    max: 1,
    description:
      "Chance an arrival amends a working parent (quantity) instead of adding one.",
  }),
  spec({
    name: "cancelChance",
    type: "number",
    min: 0,
    max: 1,
    description: "Chance an arrival cancels a working parent instead.",
  }),
  spec({
    name: "informedThresholdBps",
    type: "number",
    min: 0,
    max: 1_000,
    unit: "bps",
    description:
      "Informed mode: trade only when the mid is this far from fair value.",
  }),
]);

const BASE: ClientBotParams = {
  sideMode: ClientSideMode.Random,
  programmeSide: Side.Buy,
  ordersPerMin: 2,
  maxLive: 5,
  minNotionalUsd: 100_000,
  maxNotionalUsd: 1_000_000,
  twapWeight: 1,
  vwapWeight: 1,
  povWeight: 1,
  minDurationMins: 10,
  maxDurationMins: 60,
  minPovPct: 5,
  maxPovPct: 15,
  limitBps: 50,
  universe: "",
  amendChance: 0.05,
  cancelChance: 0.05,
  informedThresholdBps: 15,
};

/** Starter personas: the base settings with these overrides. */
export const PERSONA_DEFAULTS: Readonly<
  Record<ClientPersona, Readonly<ClientBotParams>>
> = Object.freeze({
  [ClientPersona.Pension]: {
    ...BASE,
    sideMode: ClientSideMode.Programme,
    ordersPerMin: 1,
    maxLive: 6,
    minNotionalUsd: 500_000,
    maxNotionalUsd: 2_000_000,
    twapWeight: 0,
    vwapWeight: 1,
    povWeight: 0,
    minDurationMins: 30,
    maxDurationMins: 120,
    limitBps: 100,
    amendChance: 0.02,
    cancelChance: 0.01,
  },
  [ClientPersona.HedgeFund]: {
    ...BASE,
    sideMode: ClientSideMode.Momentum,
    ordersPerMin: 2,
    maxLive: 5,
    minNotionalUsd: 200_000,
    maxNotionalUsd: 1_500_000,
    twapWeight: 0,
    vwapWeight: 0,
    povWeight: 1,
    minDurationMins: 10,
    maxDurationMins: 60,
    minPovPct: 10,
    maxPovPct: 20,
    limitBps: 50,
  },
  [ClientPersona.Quant]: {
    ...BASE,
    ordersPerMin: 8,
    maxLive: 10,
    minNotionalUsd: 50_000,
    maxNotionalUsd: 300_000,
    twapWeight: 1,
    vwapWeight: 0,
    povWeight: 0,
    minDurationMins: 2,
    maxDurationMins: 10,
    limitBps: 20,
    amendChance: 0.1,
    cancelChance: 0.1,
  },
  [ClientPersona.Liquidation]: {
    ...BASE,
    sideMode: ClientSideMode.Programme,
    programmeSide: Side.Sell,
    ordersPerMin: 0.5,
    maxLive: 2,
    minNotionalUsd: 1_000_000,
    maxNotionalUsd: 2_000_000,
    twapWeight: 0,
    vwapWeight: 0,
    povWeight: 1,
    minDurationMins: 15,
    maxDurationMins: 30,
    minPovPct: 25,
    maxPovPct: 25,
    limitBps: 0,
    amendChance: 0,
    cancelChance: 0,
  },
  [ClientPersona.Informed]: {
    ...BASE,
    sideMode: ClientSideMode.Informed,
    ordersPerMin: 6,
    maxLive: 3,
    minNotionalUsd: 250_000,
    maxNotionalUsd: 1_000_000,
    twapWeight: 0,
    vwapWeight: 0,
    povWeight: 1,
    minDurationMins: 2,
    maxDurationMins: 5,
    minPovPct: 20,
    maxPovPct: 30,
    limitBps: 0,
    amendChance: 0,
    cancelChance: 0,
    informedThresholdBps: 15,
  },
});
