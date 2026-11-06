import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { filterString } from "../../utils/filters";
import { formatNotional, formatQuantity } from "../../utils/formatting";
import { formatTime } from "../../utils/time";
import { PnlValue } from "../PnlValue";
import simulatorGridsCss from "./SimulatorGrids.css";

const classBase = "tradingBotDetail";

export interface BotDetailProps extends HTMLAttributes<HTMLDivElement> {
  /** The bot to show (`bots.botId`), e.g. from BotsGrid `onBotSelect`. */
  botId: string | undefined;
}

const num = (value: unknown) => (typeof value === "number" ? value : undefined);
const plain = (value: unknown) =>
  value === null || value === undefined || value === "" ? "–" : String(value);

/**
 * One bot's stats (from `bots`) and parameters with their specs (from
 * `botParams`). Read only until bot parameters can be changed at run time.
 */
export const BotDetail = forwardRef<HTMLDivElement, BotDetailProps>(
  function BotDetail({ botId, className, ...htmlAttributes }, ref) {
    useComponentCssInjection({
      testId: "trading-simulator-grids",
      css: simulatorGridsCss,
      window: useWindow(),
    });
    const filter = botId ? `botId = ${filterString(botId)}` : "";
    const { rows: bots } = useTradingRows("bots", {
      enabled: botId !== undefined,
      filter,
      rowCount: 1,
    });
    const { rows: params } = useTradingRows("botParams", {
      enabled: botId !== undefined,
      filter,
      rowCount: 50,
    });
    const bot = botId ? bots.find((row) => row.botId === botId) : undefined;

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-bot-detail"
        ref={ref}
      >
        {bot === undefined ? (
          <span className={`${classBase}-empty`}>Select a bot</span>
        ) : (
          <>
            <h3>
              {plain(bot.botId)} <small>{plain(bot.kind)}</small>
            </h3>
            <dl>
              <dt>Account</dt>
              <dd>{plain(bot.account)}</dd>
              <dt>Position</dt>
              <dd>
                {formatQuantity(bot.position)} @ {plain(bot.avgPrice)}
              </dd>
              <dt>Position $</dt>
              <dd>{formatNotional(bot.positionUsd)}</dd>
              <dt>P&amp;L $</dt>
              <dd>
                <PnlValue value={num(bot.totalPnlUsd)} /> (realised{" "}
                {formatNotional(bot.realisedPnlUsd, { signed: true })})
              </dd>
              <dt>Orders</dt>
              <dd>
                {formatQuantity(bot.orders)} ({formatQuantity(bot.modifies)}{" "}
                modified, {formatQuantity(bot.cancels)} cancelled)
              </dd>
              <dt>Fills</dt>
              <dd>
                {formatQuantity(bot.fills)} ({formatQuantity(bot.makerFills)} as
                maker), volume {formatQuantity(bot.volume)}
              </dd>
              <dt>Resting</dt>
              <dd>
                {formatQuantity(bot.restingOrders)} orders, bid{" "}
                {formatQuantity(bot.restingBidQty)} / ask{" "}
                {formatQuantity(bot.restingAskQty)}
              </dd>
              <dt>Rate</dt>
              <dd>
                {plain(bot.rate)} /s (actual {plain(bot.effectiveRate)} /s)
              </dd>
              {bot.skewTicks !== null && bot.skewTicks !== undefined ? (
                <>
                  <dt>Skew</dt>
                  <dd>{plain(bot.skewTicks)} ticks</dd>
                </>
              ) : null}
              <dt>Updated</dt>
              <dd>{formatTime(bot.updated)}</dd>
            </dl>
            <h3>Parameters</h3>
            <dl data-testid="trading-bot-params">
              {params.map((param) => (
                <div key={String(param.id)} style={{ display: "contents" }}>
                  <dt title={plain(param.description)}>{plain(param.name)}</dt>
                  <dd>
                    {plain(param.value)} {param.unit ? plain(param.unit) : ""}
                    {(param.min ?? null) !== null ||
                    (param.max ?? null) !== null ? (
                      <small>
                        {" "}
                        [{plain(param.min)}…{plain(param.max)}]
                      </small>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    );
  },
);
