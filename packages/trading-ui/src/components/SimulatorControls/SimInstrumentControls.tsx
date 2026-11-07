import {
  BotType,
  RpcName,
  SIM_BOT_KINDS,
  TradingPhase,
} from "@heswell/trading-schemas";
import { Button, Dropdown, Input, Option } from "@salt-ds/core";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useEffect, useState } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { useFollowedInstrument } from "../../hooks/useMarketData";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { LinkGroupSelector } from "../LinkGroupSelector";
import { controlsClass, plain, useControlsCss } from "./useControlsCss";
import { useSimRpc } from "./useSimRpc";

export interface SimInstrumentControlsProps
  extends HTMLAttributes<HTMLDivElement>,
    LinkGroupProps {
  /** Instrument; default: the followed (linked) instrument. */
  ric?: string;
}

/** Fields of setInstrumentParams, with the simBooks column showing each. */
const MODEL_FIELDS = [
  {
    name: "volatility",
    column: "volatility",
    label: "Volatility",
    unit: "annual",
  },
  {
    name: "driftBpsPerHour",
    column: "driftBpsPerHour",
    label: "Drift",
    unit: "bps / model hour",
  },
  {
    name: "impactBps",
    column: "impactK",
    label: "Impact",
    unit: "bps per $100k",
  },
] as const;

const RATE_FIELDS = [
  { bot: BotType.MarketMaker, column: "mmRate", label: "Market makers" },
  { bot: BotType.Taker, column: "takerRate", label: "Takers" },
] as const;

const JUMPS = [-100, -25, 25, 100];

type Drafts = Record<string, string>;

/**
 * Run-time controls for one simulated instrument (sim-admin only): price
 * model (volatility, drift, impact), fair-value jumps, halt / resume, bot
 * rates, pausing and pulling its bots, and adding a bot. Follows the
 * linked instrument; current values come from `simBooks`.
 */
export const SimInstrumentControls = forwardRef<
  HTMLDivElement,
  SimInstrumentControlsProps
>(function SimInstrumentControls(
  {
    className,
    defaultLinkGroup,
    linkGroup: linkGroupProp,
    onLinkGroupChange,
    ric: ricProp,
    showLinkGroupSelector = false,
    ...htmlAttributes
  },
  ref,
) {
  useControlsCss();
  const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
    defaultLinkGroup,
    linkGroup: linkGroupProp,
    onLinkGroupChange,
    persistKey: htmlAttributes.id
      ? `SimInstrumentControls:${htmlAttributes.id}`
      : "SimInstrumentControls",
  });
  const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
  const filter = ric ? `ric = ${filterString(ric)}` : "";
  const { rows, dataSource } = useTradingRows("simBooks", {
    enabled: ric !== undefined,
    filter,
    rowCount: 1,
  });
  // seconds an informed trader trades a jump for (0 = a plain jump)
  const [informedSecs, setInformedSecs] = useState(0);
  const { send, message, pending } = useSimRpc(dataSource);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [kind, setKind] = useState<string>();
  const book = rows.find((row) => row.ric === ric);

  // a new instrument starts with clean fields
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on ric change only
  useEffect(() => setDrafts({}), [ric]);

  if (!ric || !book) {
    return (
      <div
        {...htmlAttributes}
        className={cx(controlsClass, className)}
        data-testid="trading-sim-instrument-controls"
        ref={ref}
      >
        <span className={`${controlsClass}-label`}>
          {ric ? `${ric} is not simulated` : "Select an instrument"}
        </span>
      </div>
    );
  }

  const draft = (key: string, current: unknown) =>
    drafts[key] ?? plain(current).replace("–", "");
  const setDraft = (key: string, value: string) =>
    setDrafts((d) => ({ ...d, [key]: value }));
  const changedModel = MODEL_FIELDS.filter(
    ({ name }) => drafts[name] !== undefined,
  );
  const halted = book.phase === TradingPhase.Halted;

  const applyModel = async () => {
    const params: Record<string, number> = {};
    for (const { name } of changedModel) params[name] = Number(drafts[name]);
    const done = await send(
      RpcName.SetInstrumentParams,
      { ric, ...params },
      `${ric} price model updated`,
    );
    if (done)
      setDrafts((d) =>
        Object.fromEntries(Object.entries(d).filter(([k]) => !(k in params))),
      );
  };

  const applyRate = async (bot: BotType, column: string) => {
    const done = await send(
      RpcName.SetBotRate,
      { ric, bot, rate: Number(drafts[column]) },
      `${ric} ${bot === BotType.Taker ? "taker" : "market maker"} rate set`,
    );
    if (done) setDrafts(({ [column]: _, ...rest }) => rest);
  };

  return (
    <div
      {...htmlAttributes}
      className={cx(controlsClass, className)}
      data-link-group={linkGroup}
      data-testid="trading-sim-instrument-controls"
      ref={ref}
    >
      <div className={`${controlsClass}-row`}>
        {showLinkGroupSelector ? (
          <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
        ) : null}
        <strong>{ric}</strong>
        <span className={`${controlsClass}-phase`}>{plain(book.phase)}</span>
        <span className={`${controlsClass}-value`}>
          fair {plain(book.fair)}
        </span>
      </div>

      <div className={`${controlsClass}-group`}>
        <h4>Price model</h4>
        <div className={`${controlsClass}-fields`}>
          {MODEL_FIELDS.map(({ name, column, label, unit }) => (
            <div key={name} style={{ display: "contents" }}>
              <label
                className={`${controlsClass}-label`}
                htmlFor={`sim-${name}`}
              >
                {label}
              </label>
              <Input
                inputProps={{ id: `sim-${name}`, inputMode: "decimal" }}
                onChange={(e) =>
                  setDraft(name, (e.target as HTMLInputElement).value)
                }
                value={draft(name, book[column])}
              />
              <span className={`${controlsClass}-label`}>{unit}</span>
            </div>
          ))}
        </div>
        <div className={`${controlsClass}-row`}>
          <Button
            disabled={pending || changedModel.length === 0}
            onClick={applyModel}
            sentiment="accented"
          >
            Apply
          </Button>
          <span className={`${controlsClass}-label`}>Jump fair value</span>
          {JUMPS.map((bps) => (
            <Button
              disabled={pending}
              key={bps}
              onClick={() =>
                send(
                  RpcName.ShiftFairValue,
                  informedSecs > 0 ? { ric, bps, informedSecs } : { ric, bps },
                  `${ric} fair value moved ${bps} bps${
                    informedSecs > 0
                      ? `, informed trading for ${informedSecs}s`
                      : ""
                  }`,
                )
              }
              sentiment="neutral"
            >
              {bps > 0 ? `+${bps}` : bps} bp
            </Button>
          ))}
          <label className={`${controlsClass}-label`}>
            <input
              checked={informedSecs > 0}
              onChange={(e) => setInformedSecs(e.target.checked ? 30 : 0)}
              type="checkbox"
            />{" "}
            informed trader (30s)
          </label>
        </div>
      </div>

      <div className={`${controlsClass}-group`}>
        <h4>Bots</h4>
        <div className={`${controlsClass}-fields`}>
          {RATE_FIELDS.map(({ bot, column, label }) => (
            <div key={bot} style={{ display: "contents" }}>
              <label
                className={`${controlsClass}-label`}
                htmlFor={`sim-${column}`}
              >
                {label}
              </label>
              <Input
                inputProps={{ id: `sim-${column}`, inputMode: "decimal" }}
                onChange={(e) =>
                  setDraft(column, (e.target as HTMLInputElement).value)
                }
                value={draft(column, book[column])}
              />
              <Button
                disabled={pending || drafts[column] === undefined}
                onClick={() => applyRate(bot, column)}
                sentiment="neutral"
              >
                Set rate /s
              </Button>
            </div>
          ))}
        </div>
        <div className={`${controlsClass}-row`}>
          <Button
            disabled={pending}
            onClick={() =>
              send(RpcName.PauseBots, { ric }, `${ric} bots paused`)
            }
            sentiment="neutral"
          >
            Pause bots
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              send(RpcName.ResumeBots, { ric }, `${ric} bots resumed`)
            }
            sentiment="neutral"
          >
            Resume bots
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              send(RpcName.PullQuotes, { ric }, `${ric} quotes pulled`)
            }
            sentiment="neutral"
          >
            Pull quotes
          </Button>
        </div>
        <div className={`${controlsClass}-row`}>
          <Dropdown
            aria-label="Bot kind"
            onSelectionChange={(_, [value]) => setKind(value)}
            placeholder="Bot kind"
            selected={kind ? [kind] : []}
            style={{ width: 160 }}
            value={kind ?? ""}
          >
            {SIM_BOT_KINDS.map((k) => (
              <Option key={k} value={k} />
            ))}
          </Dropdown>
          <Button
            disabled={pending || !kind}
            onClick={() =>
              kind &&
              send(
                RpcName.AddBot,
                { ric, kind },
                ({ botId }) => `${botId} added`,
              )
            }
            sentiment="neutral"
          >
            Add bot
          </Button>
        </div>
      </div>

      <div className={`${controlsClass}-group`}>
        <h4>Trading</h4>
        <div className={`${controlsClass}-row`}>
          {halted ? (
            <Button
              disabled={pending}
              onClick={() =>
                send(RpcName.ResumeInstrument, { ric }, `${ric} resumed`)
              }
              sentiment="neutral"
            >
              Resume
            </Button>
          ) : (
            <Button
              disabled={pending}
              onClick={() =>
                send(
                  RpcName.HaltInstrument,
                  { ric, reason: "halted from the simulator controls" },
                  `${ric} halted`,
                )
              }
              sentiment="neutral"
            >
              Halt
            </Button>
          )}
          {halted && book.haltReason ? (
            <span className={`${controlsClass}-label`}>
              {String(book.haltReason)}
            </span>
          ) : null}
        </div>
      </div>

      {message ? (
        <output
          className={`${controlsClass}-message`}
          data-error={message.error}
        >
          {message.text}
        </output>
      ) : null}
    </div>
  );
});
