import { RpcName } from "@heswell/trading-schemas";
import { Button, Input } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useEffect, useState } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { filterString } from "../../utils/filters";
import { formatNotional, formatQuantity } from "../../utils/formatting";
import { formatTime } from "../../utils/time";
import { PnlValue } from "../PnlValue";
import { useSimRpc } from "../SimulatorControls/useSimRpc";
import { Sparkline } from "../Sparkline";
import { BotFillsTape } from "./BotFillsTape";
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
 * One bot's stats (from `bots`), P&L history (`botHistory`), parameters
 * with their specs (`botParams`) and recent fills with markouts
 * (`botFills`). Sim admins can pause, resume, pull, reset or remove the bot
 * and edit its parameters: changed ones are marked, with a reset to the
 * baseline (the value it was created with).
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
    const { rows: params, dataSource } = useTradingRows("botParams", {
      enabled: botId !== undefined,
      filter,
      rowCount: 50,
    });
    const { rows: history } = useTradingRows("botHistory", {
      enabled: botId !== undefined,
      filter,
      rowCount: 200,
      sort: { sortDefs: [{ column: "time", sortType: "A" }] },
    });
    const { send, message, pending } = useSimRpc(dataSource);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset on bot change only
    useEffect(() => setDrafts({}), [botId]);
    const bot = botId ? bots.find((row) => row.botId === botId) : undefined;
    const setParam = async (name: string, value: string) => {
      if (!botId) return;
      const done = await send(
        RpcName.SetBotParams,
        { botId, name, value },
        `${name} set to ${value}`,
      );
      if (done) setDrafts(({ [name]: _, ...rest }) => rest);
    };
    const action = (
      rpcName:
        | typeof RpcName.PauseBots
        | typeof RpcName.ResumeBots
        | typeof RpcName.PullQuotes
        | typeof RpcName.ResetBotStats,
      done: string,
    ) => botId && send(rpcName, { botId }, `${botId} ${done}`);
    const pnl = history
      .filter((row) => row.botId === botId)
      .map((row) => num(row.totalPnlUsd) ?? 0);

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
              {bot.paused ? <small> · paused</small> : null}
            </h3>
            <div className={`${classBase}-actions`}>
              {bot.paused ? (
                <Button
                  disabled={pending}
                  onClick={() => action(RpcName.ResumeBots, "resumed")}
                  sentiment="neutral"
                >
                  Resume
                </Button>
              ) : (
                <Button
                  disabled={pending}
                  onClick={() => action(RpcName.PauseBots, "paused")}
                  sentiment="neutral"
                >
                  Pause
                </Button>
              )}
              <Button
                disabled={pending}
                onClick={() => action(RpcName.PullQuotes, "quotes pulled")}
                sentiment="neutral"
              >
                Pull quotes
              </Button>
              <Button
                disabled={pending}
                onClick={() => action(RpcName.ResetBotStats, "stats reset")}
                sentiment="neutral"
              >
                Reset stats
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  botId &&
                  send(RpcName.RemoveBot, { botId }, `${botId} removed`)
                }
                sentiment="negative"
              >
                Remove
              </Button>
            </div>
            {message ? (
              <output
                className={`${classBase}-message`}
                data-error={message.error}
              >
                {message.text}
              </output>
            ) : null}
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
              {pnl.length > 1 ? (
                <>
                  <dt>P&amp;L history</dt>
                  <dd>
                    <Sparkline
                      data-testid="trading-bot-pnl-sparkline"
                      height={24}
                      label={`${plain(bot.botId)} P&L`}
                      values={pnl}
                      width={160}
                    />
                  </dd>
                </>
              ) : null}
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
              {params.map((param) => {
                const name = String(param.name);
                const value = String(param.value ?? "");
                const draft = drafts[name];
                const editing = draft !== undefined && draft !== value;
                return (
                  <div key={String(param.id)} style={{ display: "contents" }}>
                    <dt title={plain(param.description)}>
                      {name}
                      {param.changed ? (
                        <span
                          className={`${classBase}-changed`}
                          data-testid="trading-bot-param-changed"
                          title={`Changed from baseline ${plain(param.baseline)}`}
                        >
                          {" "}
                          *
                        </span>
                      ) : null}
                    </dt>
                    <dd className={`${classBase}-param`}>
                      {param.readOnly ? (
                        <span>{plain(param.value)}</span>
                      ) : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (editing) setParam(name, draft);
                          }}
                        >
                          <Input
                            inputProps={{
                              "aria-label": name,
                              inputMode:
                                param.type === "string" ? "text" : "decimal",
                            }}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [name]: (e.target as HTMLInputElement).value,
                              }))
                            }
                            style={{ width: 90 }}
                            value={draft ?? value}
                          />
                          {editing ? (
                            <Button
                              disabled={pending}
                              sentiment="accented"
                              type="submit"
                            >
                              Set
                            </Button>
                          ) : null}
                          {param.changed && !editing ? (
                            <Button
                              disabled={pending}
                              onClick={() =>
                                setParam(name, String(param.baseline))
                              }
                              sentiment="neutral"
                            >
                              Reset
                            </Button>
                          ) : null}
                        </form>
                      )}
                      {param.unit ? <small> {plain(param.unit)}</small> : null}
                      {(param.min ?? null) !== null ||
                      (param.max ?? null) !== null ? (
                        <small>
                          {" "}
                          [{plain(param.min)}…{plain(param.max)}]
                        </small>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <h3>Recent fills</h3>
            <BotFillsTape
              hideToolbar
              party={plain(bot.botId)}
              style={{ height: 220, flex: "0 0 auto" }}
            />
          </>
        )}
      </div>
    );
  },
);
