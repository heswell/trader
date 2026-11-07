import {
  ALGO_STRATEGIES,
  AlgoStrategy,
  RpcName,
  Side,
} from "@heswell/trading-schemas";
import { Button, Input } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useState } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { filterString } from "../../utils/filters";
import { formatNotional, formatQuantity } from "../../utils/formatting";
import { formatTime } from "../../utils/time";
import { useSimRpc } from "../SimulatorControls/useSimRpc";
import { BotFillsTape } from "./BotFillsTape";
import { BotParamList } from "./BotParamList";
import simulatorGridsCss from "./SimulatorGrids.css";

const classBase = "tradingBotDetail";

export interface ClientBotDetailProps extends HTMLAttributes<HTMLDivElement> {
  /** The client bot to show (`clientBots.botId`), e.g. from ClientBotsGrid. */
  botId: string | undefined;
}

const plain = (value: unknown) =>
  value === null || value === undefined || value === "" ? "–" : String(value);

/** Algo strategies a client bot can send (not DMA). */
const ALGOS = ALGO_STRATEGIES.filter((s) => s !== AlgoStrategy.Dma);

/**
 * One OMS client bot (sim-admin only): its stats from `clientBots`,
 * parameters from `clientBotParams` (editable, changes marked), pause /
 * resume / remove, a form to send one algo parent now, and its account's
 * attributed fills on the exchange (`botFills`, party `OMS:<account>`).
 */
export const ClientBotDetail = forwardRef<HTMLDivElement, ClientBotDetailProps>(
  function ClientBotDetail({ botId, className, ...htmlAttributes }, ref) {
    useComponentCssInjection({
      testId: "trading-simulator-grids",
      css: simulatorGridsCss,
      window: useWindow(),
    });
    const filter = botId ? `botId = ${filterString(botId)}` : "";
    const { rows: bots } = useTradingRows("clientBots", {
      enabled: botId !== undefined,
      filter,
      rowCount: 1,
    });
    const { rows: params, dataSource } = useTradingRows("clientBotParams", {
      enabled: botId !== undefined,
      filter,
      rowCount: 50,
    });
    const { send, message, pending } = useSimRpc(dataSource);
    const [order, setOrder] = useState({
      ric: "",
      side: Side.Buy as Side,
      notionalUsd: "500000",
      strategy: AlgoStrategy.Twap as AlgoStrategy,
      durationMins: "10",
    });
    const bot = botId ? bots.find((row) => row.botId === botId) : undefined;
    const setParam = async (name: string, value: string) =>
      botId !== undefined &&
      (await send(
        RpcName.SetClientBotParams,
        { botId, name, value },
        `${name} set to ${value}`,
      )) !== undefined;

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-client-bot-detail"
        ref={ref}
      >
        {bot === undefined || !botId ? (
          <span className={`${classBase}-empty`}>Select a client bot</span>
        ) : (
          <>
            <h3>
              {plain(bot.botId)} <small>{plain(bot.persona)}</small>
              {bot.paused ? <small> · paused</small> : null}
            </h3>
            <div className={`${classBase}-actions`}>
              <Button
                disabled={pending}
                onClick={() =>
                  bot.paused
                    ? send(
                        RpcName.ResumeClientBots,
                        { botId },
                        `${botId} resumed`,
                      )
                    : send(
                        RpcName.PauseClientBots,
                        { botId },
                        `${botId} paused`,
                      )
                }
                sentiment="neutral"
              >
                {bot.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  send(RpcName.RemoveClientBot, { botId }, `${botId} removed`)
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
              <dt>Parents</dt>
              <dd>
                {formatQuantity(bot.live)} working,{" "}
                {formatQuantity(bot.submitted)} sent (
                {formatQuantity(bot.rejected)} rejected,{" "}
                {formatQuantity(bot.completed)} done)
              </dd>
              <dt>Filled</dt>
              <dd>
                {formatQuantity(bot.filledQty)} ·{" "}
                {formatNotional(bot.filledUsd)}
              </dd>
              <dt>Slippage</dt>
              <dd>{plain(bot.slippageBps)} bps vs arrival</dd>
              {bot.lastReject ? (
                <>
                  <dt>Last reject</dt>
                  <dd>{plain(bot.lastReject)}</dd>
                </>
              ) : null}
              <dt>Updated</dt>
              <dd>{formatTime(bot.updated)}</dd>
            </dl>
            <h3>Send an algo</h3>
            <form
              className={`${classBase}-actions`}
              data-testid="trading-client-bot-submit"
              onSubmit={(e) => {
                e.preventDefault();
                send(
                  RpcName.SubmitClientAlgo,
                  {
                    botId,
                    ric: order.ric.trim(),
                    side: order.side,
                    notionalUsd: Number(order.notionalUsd),
                    strategy: order.strategy,
                    durationMins: Number(order.durationMins),
                  },
                  ({ orderId }) => `${orderId} sent`,
                );
              }}
            >
              <Input
                inputProps={{ "aria-label": "RIC" }}
                onChange={(e) =>
                  setOrder((o) => ({
                    ...o,
                    ric: (e.target as HTMLInputElement).value,
                  }))
                }
                placeholder="RIC"
                style={{ width: 90 }}
                value={order.ric}
              />
              <select
                aria-label="Side"
                onChange={(e) =>
                  setOrder((o) => ({ ...o, side: e.target.value as Side }))
                }
                value={order.side}
              >
                <option value={Side.Buy}>BUY</option>
                <option value={Side.Sell}>SELL</option>
              </select>
              <Input
                inputProps={{
                  "aria-label": "Notional USD",
                  inputMode: "decimal",
                }}
                onChange={(e) =>
                  setOrder((o) => ({
                    ...o,
                    notionalUsd: (e.target as HTMLInputElement).value,
                  }))
                }
                style={{ width: 90 }}
                value={order.notionalUsd}
              />
              <select
                aria-label="Strategy"
                onChange={(e) =>
                  setOrder((o) => ({
                    ...o,
                    strategy: e.target.value as AlgoStrategy,
                  }))
                }
                value={order.strategy}
              >
                {ALGOS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Input
                inputProps={{
                  "aria-label": "Duration (session min)",
                  inputMode: "decimal",
                }}
                onChange={(e) =>
                  setOrder((o) => ({
                    ...o,
                    durationMins: (e.target as HTMLInputElement).value,
                  }))
                }
                style={{ width: 60 }}
                value={order.durationMins}
              />
              <Button
                disabled={pending || order.ric.trim() === ""}
                sentiment="accented"
                type="submit"
              >
                Send
              </Button>
            </form>
            <h3>Parameters</h3>
            <BotParamList
              data-testid="trading-client-bot-params"
              key={botId}
              onSet={setParam}
              params={params}
              pending={pending}
            />
            <h3>Recent fills</h3>
            <BotFillsTape
              hideToolbar
              party={`OMS:${plain(bot.account)}`}
              style={{ height: 220, flex: "0 0 auto" }}
            />
          </>
        )}
      </div>
    );
  },
);
