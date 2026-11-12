import type { ExchangeSimConfig } from "../../config";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";
import {
  type Bot,
  BotKind,
  type BotKindDef,
  type BotParams,
  setBotBaseline,
} from "./Bot";
import { AGGRESSIVE_TRADER } from "./AggressiveTrader";
import { ICEBERG } from "./Iceberg";
import { INFORMED } from "./Informed";
import { MARKET_MAKER } from "./MarketMaker";
import { MEAN_REVERSION } from "./MeanReversion";
import { MOMENTUM } from "./Momentum";
import { DEFAULT_TAKERS, NOISE_TAKER } from "./NoiseTaker";
import { STOP_LOSSES } from "./StopLosses";
import { OrderPort } from "./OrderPort";

/** Every bot kind the simulator can run. */
export const BOT_KINDS: Readonly<Record<BotKind, BotKindDef>> = Object.freeze({
  [BotKind.MarketMaker]: MARKET_MAKER,
  [BotKind.NoiseTaker]: NOISE_TAKER,
  [BotKind.Momentum]: MOMENTUM,
  [BotKind.MeanReversion]: MEAN_REVERSION,
  [BotKind.AggressiveTrader]: AGGRESSIVE_TRADER,
  [BotKind.StopLosses]: STOP_LOSSES,
  [BotKind.Iceberg]: ICEBERG,
  [BotKind.Informed]: INFORMED,
});

export const botKindDef = (kind: BotKind) => BOT_KINDS[kind];

/** `count` bots of one kind, with optional parameter overrides. */
export interface RosterEntry {
  kind: BotKind;
  count: number;
  params?: BotParams;
}

/** The bots an instrument starts with, in step order within each stage. */
export type Roster = readonly RosterEntry[];

/** Today's market: `mmPerInstrument` market makers and three noise takers. */
export const defaultRoster = (config: ExchangeSimConfig): Roster => [
  {
    kind: MARKET_MAKER.kind,
    count: config.mmPerInstrument,
    params: { levels: config.mmLevels },
  },
  { kind: NOISE_TAKER.kind, count: DEFAULT_TAKERS },
];

/** One `extraBots` entry: `count` bots of `kind`, on every instrument or one sector. */
export interface ExtraBots extends RosterEntry {
  sector?: string;
}

/** Parse config `extraBots` ("momentum:1,stopLosses:2@Energy"); throws on a bad entry. */
export const parseExtraBots = (text: string): ExtraBots[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(\w+):(\d+)(?:@(.+))?$/.exec(part);
      const kind = match?.[1] as BotKind | undefined;
      if (!match || !kind || !BOT_KINDS[kind])
        throw Error(
          `exchangeSim.extraBots: bad entry '${part}' (kind:count[@sector])`,
        );
      return {
        kind,
        count: Number(match[2]),
        ...(match[3] ? { sector: match[3].trim() } : {}),
      };
    });

/** The default roster plus the extra bots that apply to `sector`. */
export const rosterFor = (
  config: ExchangeSimConfig,
  extras: readonly ExtraBots[],
  sector: string,
): Roster => [
  ...defaultRoster(config),
  ...extras
    .filter((e) => !e.sector || e.sector === sector)
    .map(({ kind, count, params }) => ({ kind, count, params })),
];

/**
 * A future's roster: the equity roster plus an always-on informed bot. Its
 * fair value follows the underlying, so the informed bot trades the basis
 * back in when the future's market drifts from spot carried to expiry.
 */
export const futuresRosterFor = (
  config: ExchangeSimConfig,
  extras: readonly ExtraBots[],
  sector: string,
): Roster => [
  ...rosterFor(config, extras, sector),
  { kind: INFORMED.kind, count: 1, params: { alwaysOn: true } },
];

/** 32-bit FNV-1a: stable salts for per-bot generators. */
export const hashString = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** One bot: the n-th of its kind on the instrument. */
export const createBot = (
  def: BotKindDef,
  n: number,
  book: InstrumentBook,
  rng: Random,
  baseQty: number,
  params?: BotParams,
): Bot => {
  const localId = def.localId(n);
  const port = new OrderPort(
    book,
    `${book.ric}/${localId}`,
    def.account(n),
    def.idPrefix,
  );
  const bot = def.create({
    localId,
    book,
    port,
    rng: rng.fork(hashString(localId)),
    baseQty,
    params,
  });
  setBotBaseline(bot);
  return bot;
};

/** Quoting bots first (step order); stable within a stage. */
export const sortBots = (bots: Bot[]) => {
  const stage = (bot: Bot) => (botKindDef(bot.kind).stage === "quote" ? 0 : 1);
  return bots.sort((a, b) => stage(a) - stage(b));
};

/**
 * Create an instrument's bots from a roster. Each bot gets its own
 * generator forked from `rng` by its local id, so adding or removing a bot
 * leaves the others' random streams unchanged. Quoting bots come first.
 */
export const createBots = (
  roster: Roster,
  book: InstrumentBook,
  rng: Random,
  baseQty: number,
): Bot[] => {
  const bots: Bot[] = [];
  for (const { kind, count, params } of roster) {
    const def = botKindDef(kind);
    if (!def) throw Error(`unknown bot kind ${kind}`);
    for (let n = 1; n <= count; n++)
      bots.push(createBot(def, n, book, rng, baseQty, params));
  }
  return sortBots(bots);
};
