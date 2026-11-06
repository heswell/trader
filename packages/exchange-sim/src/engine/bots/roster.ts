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
import { MARKET_MAKER } from "./MarketMaker";
import { DEFAULT_TAKERS, NOISE_TAKER } from "./NoiseTaker";
import { OrderPort } from "./OrderPort";

/** Every bot kind the simulator can run. */
export const BOT_KINDS: Readonly<Record<BotKind, BotKindDef>> = Object.freeze({
  [BotKind.MarketMaker]: MARKET_MAKER,
  [BotKind.NoiseTaker]: NOISE_TAKER,
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
