import type { BotType } from "@heswell/trading-schemas";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";
import type { MarketSignals } from "./MarketSignals";
import type { OrderPort } from "./OrderPort";

export const BotKind = Object.freeze({
  MarketMaker: "marketMaker",
  NoiseTaker: "noiseTaker",
} as const);
export type BotKind = (typeof BotKind)[keyof typeof BotKind];

/** Quoting bots step before taking bots on each instrument. */
export type BotStage = "quote" | "take";

export type BotParamValue = number | string | boolean;
export type BotParams = Readonly<Record<string, BotParamValue>>;

/** One tunable parameter of a bot kind: drives validation and the UI editor. */
export interface BotParamSpec {
  name: string;
  type: "number" | "integer" | "string" | "boolean";
  description: string;
  min?: number;
  max?: number;
  unit?: string;
  /** Fixed for the bot's life (identity, not behaviour). */
  readOnly?: boolean;
}

/** What a bot sees on each step. */
export interface BotStepContext {
  /** Wall-clock seconds since the previous step. */
  readonly dt: number;
  readonly now: number;
  /**
   * This bot's rate for the step (events / s): its share of the
   * instrument's rate for its rate group, times the activity curve for
   * takers. Bots with a rate group are only stepped while it is > 0.
   */
  readonly rate: number;
  readonly signals: MarketSignals;
}

/** A simulated participant trading on one instrument's book. */
export interface Bot {
  /** `<ric>/<localId>`, e.g. VOD.L/MM1. */
  readonly id: string;
  /** Unique on the instrument, e.g. MM1, TAKER2. */
  readonly localId: string;
  readonly kind: BotKind;
  readonly account: string;
  readonly port: OrderPort;
  readonly params: BotParams;
  step(ctx: BotStepContext): void;
  /** Cancel everything resting (market close, pause). */
  pull(): void;
  /** Kind-specific stats for monitoring, e.g. a market maker's skew. */
  extraStats?(): Record<string, number>;
}

export interface BotCreateOptions {
  localId: string;
  book: InstrumentBook;
  port: OrderPort;
  /** The bot's own generator: forked from the instrument by local id. */
  rng: Random;
  /** Market maker base size for the instrument (lots-rounded). */
  baseQty: number;
  /** Overrides of the kind's defaults. */
  params?: BotParams;
}

/** Registry entry for one kind of bot. */
export interface BotKindDef {
  kind: BotKind;
  stage: BotStage;
  /**
   * Which setBotRate group drives the bot (the instrument's rate is split
   * evenly across the group's bots). Undefined = always stepped.
   */
  rateGroup?: typeof BotType.MarketMaker | typeof BotType.Taker;
  /** Order id prefix, e.g. M for market maker quotes. */
  idPrefix: string;
  /** Local id for the n-th bot of this kind on an instrument (1-based). */
  localId(n: number): string;
  /** Account the n-th bot trades for. */
  account(n: number): string;
  paramSpec: readonly BotParamSpec[];
  create(options: BotCreateOptions): Bot;
}
