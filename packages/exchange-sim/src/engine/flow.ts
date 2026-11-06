import { BotType } from "@heswell/trading-schemas";
import type { Bot } from "./bots/Bot";
import { BOT_OWNER_PREFIX } from "./bots/OrderPort";
import { botKindDef } from "./bots/roster";

/** Who is behind one side of a trade, for attributed volume and fills. */
export const OwnerGroup = Object.freeze({
  MarketMaker: "mm",
  Taker: "taker",
  /** Customer orders through the gateway (the OMS). */
  Oms: "oms",
  /** Any other bot kind. */
  Bot: "bot",
} as const);
export type OwnerGroup = (typeof OwnerGroup)[keyof typeof OwnerGroup];

export const OWNER_GROUPS: readonly OwnerGroup[] = Object.values(OwnerGroup);

export interface TradeParty {
  group: OwnerGroup;
  /** Bot id, or `OMS:<account>` for gateway orders. */
  id: string;
  account: string;
  bot?: Bot;
}

/** Classify one side of a trade from the order's owner and account. */
export const tradeParty = (
  owner: unknown,
  account: string | undefined,
  bots: ReadonlyMap<string, Bot>,
): TradeParty => {
  if (typeof owner === "string" && owner.startsWith(BOT_OWNER_PREFIX)) {
    const bot = bots.get(owner.slice(BOT_OWNER_PREFIX.length));
    if (bot) {
      const group = botKindDef(bot.kind).rateGroup;
      return {
        group:
          group === BotType.MarketMaker
            ? OwnerGroup.MarketMaker
            : group === BotType.Taker
              ? OwnerGroup.Taker
              : OwnerGroup.Bot,
        id: bot.id,
        account: bot.account,
        bot,
      };
    }
  }
  const acct = account ?? "";
  return { group: OwnerGroup.Oms, id: `OMS:${acct}`, account: acct };
};

/** Aggressive volume by the aggressor's owner group, since the last reset. */
export class FlowTally {
  readonly buy: Record<OwnerGroup, number> = {
    mm: 0,
    taker: 0,
    oms: 0,
    bot: 0,
  };
  readonly sell: Record<OwnerGroup, number> = {
    mm: 0,
    taker: 0,
    oms: 0,
    bot: 0,
  };

  add(group: OwnerGroup, isBuy: boolean, size: number) {
    (isBuy ? this.buy : this.sell)[group] += size;
  }

  reset() {
    for (const group of OWNER_GROUPS) {
      this.buy[group] = 0;
      this.sell[group] = 0;
    }
  }
}
