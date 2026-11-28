import {
  LIMIT_OVERRIDE_REASON_LABEL,
  LIMIT_STATE_RANK,
  type LimitCheckLine,
  LimitMetric,
  LimitOverrideReason,
  LimitState,
  Side,
} from "@heswell/trading-schemas";
import { Button } from "@salt-ds/core";
import cx from "clsx";
import { useEffect, useRef } from "react";
import { formatQuantity } from "../../utils/formatting";
import {
  formatLimitAmount,
  formatUtilisation,
  LIMIT_STATE_LABEL,
  limitLabel,
} from "../Limits/limitFormat";
import {
  isOverrideComplete,
  OVERRIDE_REASONS,
  type OrderTicketState,
} from "./useOrderTicket";

const classBase = "tradingOrderTicket";

/** The bar's scale: 125% of the limit fills it. */
const SCALE = 1.25;

const PER_ORDER: ReadonlySet<string> = new Set([
  LimitMetric.OrderQty,
  LimitMetric.OrderNotional,
]);

/** Metrics an order on the other side can reduce. */
const REDUCIBLE: ReadonlySet<string> = new Set([
  LimitMetric.PositionNotional,
  LimitMetric.GrossPositionNotional,
  LimitMetric.NetDelta,
]);

const rank = (line: LimitCheckLine) =>
  line.breach
    ? 10 + LIMIT_STATE_RANK[line.state]
    : LIMIT_STATE_RANK[line.state];

const ratio = (value: number, soft: number) => (soft > 0 ? value / soft : 0);

/**
 * The lines worth showing, most urgent first: breaches, then by state and
 * utilisation after the order; the order rate only once it warns.
 */
export const visibleLimitLines = (
  lines: readonly LimitCheckLine[],
  max = 3,
): LimitCheckLine[] =>
  lines
    .filter(
      (l) => l.metric !== LimitMetric.OrderRate || l.state !== LimitState.Ok,
    )
    .sort(
      (a, b) =>
        rank(b) - rank(a) || ratio(b.after, b.soft) - ratio(a.after, a.soft),
    )
    .slice(0, max);

/** "Gross position notional · EQ-US": totals name their entity. */
const lineLabel = (line: LimitCheckLine) =>
  line.metric === LimitMetric.GrossPositionNotional ||
  line.metric === LimitMetric.OrderRate
    ? limitLabel(line.metric, line.entityId)
    : limitLabel(line.metric, line.ric);

const LimitLine = ({ line }: { line: LimitCheckLine }) => {
  const before = ratio(line.before, line.soft);
  const after = ratio(line.after, line.soft);
  const at = (r: number) =>
    `${(Math.min(Math.max(r, 0), SCALE) / SCALE) * 100}%`;
  const low = Math.min(before, after);
  const value = PER_ORDER.has(line.metric)
    ? `${line.metric === LimitMetric.OrderQty ? formatQuantity(line.after) : formatLimitAmount(line.after)} · ${formatUtilisation(after)}`
    : `${formatUtilisation(before)} → ${formatUtilisation(after)}`;
  return (
    <li
      className={`${classBase}-limitLine`}
      data-limit-key={line.limitKey}
      data-state={line.state}
    >
      <span className={`${classBase}-limitName`}>{lineLabel(line)}</span>
      <span className={`${classBase}-limitValue`}>{value}</span>
      <span
        aria-label={`${lineLabel(line)} ${formatUtilisation(after)} of the limit after this order`}
        className={`${classBase}-limitTrack`}
        role="img"
      >
        <i className={`${classBase}-limitNow`} style={{ width: at(low) }} />
        {after > before ? (
          <i
            className={cx(
              `${classBase}-limitAdd`,
              `${classBase}-limitAdd-${line.state}`,
            )}
            style={{
              left: at(before),
              width: `calc(${at(after)} - ${at(before)})`,
            }}
          />
        ) : null}
        <em style={{ left: at(ratio(line.warning, line.soft)) }} />
        <em className={`${classBase}-limitTick-soft`} style={{ left: at(1) }} />
        {line.hard > line.soft ? (
          <em
            className={`${classBase}-limitTick-hard`}
            style={{ left: at(ratio(line.hard, line.soft)) }}
          />
        ) : null}
      </span>
    </li>
  );
};

/** Lines of a limit check: name, use before → after, and a bar. */
export const LimitCheckLines = ({
  lines,
}: {
  lines: readonly LimitCheckLine[];
}) => (
  <ul className={`${classBase}-limitLines`}>
    {lines.map((line) => (
      <LimitLine key={line.limitKey} line={line} />
    ))}
  </ul>
);

const HEAD: Partial<Record<LimitState, string>> = {
  [LimitState.Warning]: "Limits after this order",
  [LimitState.SoftBreach]: "Exceeds limit",
  [LimitState.HardBreach]: "Over hard limit",
};

/**
 * The ticket's limit check, once the order reaches a warning: the limits
 * nearest their levels, before and after this order. A warning is only
 * shown; over a limit the order needs an override reason; over a hard limit
 * it is blocked, with the largest quantity that fits (Alt+U) and Request
 * increase.
 */
export const OrderTicketLimitCheck = ({
  ticket,
  onRequestIncrease,
}: {
  ticket: OrderTicketState;
  /** Request increase… on the limit that blocks the order. */
  onRequestIncrease?: (line: LimitCheckLine) => void;
}) => {
  const { limits, limitState, maxQuantity, applyMaxQuantity, draft, position } =
    ticket;
  if (limits.length === 0 || limitState === LimitState.Ok) return null;
  const blocking = limits.find(
    (l) => l.breach && l.state === LimitState.HardBreach,
  );
  const buy = draft.side === Side.Buy;
  const reducible =
    blocking &&
    REDUCIBLE.has(blocking.metric) &&
    (position ?? 0) !== 0 &&
    (buy ? (position ?? 0) > 0 : (position ?? 0) < 0);
  return (
    <section
      aria-label="Limit check"
      className={`${classBase}-limits`}
      data-state={limitState}
    >
      <div className={`${classBase}-limitsHead`}>
        <span>{HEAD[limitState]}</span>
        <span className={`${classBase}-limitPill`}>
          {LIMIT_STATE_LABEL[limitState]}
        </span>
      </div>
      <LimitCheckLines lines={visibleLimitLines(limits)} />
      {limitState === LimitState.Warning ? (
        <p className={`${classBase}-limitsMsg`}>
          Warnings don't stop the order and need no extra step.
        </p>
      ) : limitState === LimitState.SoftBreach ? (
        <p className={`${classBase}-limitsMsg`}>
          Sending it over the limit needs a reason.
        </p>
      ) : blocking ? (
        <>
          <p className={`${classBase}-limitsMsg`}>
            The hard limit is{" "}
            <b>
              {formatUtilisation(ratio(blocking.hard, blocking.soft))} (
              {blocking.metric === LimitMetric.OrderQty
                ? formatQuantity(blocking.hard)
                : formatLimitAmount(blocking.hard)}
              )
            </b>
            , and the OMS would reject this order.
            {maxQuantity !== undefined && maxQuantity > 0
              ? ` You can ${buy ? "buy" : "sell"} up to ${formatQuantity(maxQuantity)}.`
              : ""}
          </p>
          <div className={`${classBase}-limitsActions`}>
            {maxQuantity !== undefined && maxQuantity > 0 ? (
              <Button
                appearance="bordered"
                onClick={applyMaxQuantity}
                sentiment="neutral"
                type="button"
              >
                Use {formatQuantity(maxQuantity)} <kbd>Alt U</kbd>
              </Button>
            ) : null}
            {onRequestIncrease ? (
              <Button
                appearance="transparent"
                onClick={() => onRequestIncrease(blocking)}
                sentiment="neutral"
                type="button"
              >
                Request increase…
              </Button>
            ) : null}
          </div>
          {reducible ? (
            <p className={`${classBase}-limitsNote`}>
              {buy ? "Selling" : "Buying"} is still allowed
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

/**
 * The override step, in place of Review for an order over a limit (a soft
 * breach): the limits it exceeds, the room left under the hard limit, a
 * reason (1-4) and a note (needed for Other). Enter sends, Esc goes back.
 */
export const OrderTicketOverride = ({
  ticket,
  summary,
}: {
  ticket: OrderTicketState;
  /** "Buy 40,000 BARC.L @ 228.80". */
  summary: string;
}) => {
  const { limits, override, setOverride, submit, closeReview, risk, draft } =
    ticket;
  const breached = limits.filter((l) => l.breach);
  const quantity = risk.quantity ?? 0;
  let room: number | undefined;
  for (const line of breached) {
    if (line.maxQty === undefined) continue;
    const left = Math.max(0, line.maxQty - quantity);
    room = room === undefined ? left : Math.min(room, left);
  }
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const other = override.reason === LimitOverrideReason.Other;
  const ready = isOverrideComplete(override);
  return (
    <div
      aria-label="Override limit"
      className={cx(`${classBase}-review`, `${classBase}-override`)}
      role="dialog"
    >
      <h3>
        Override{" "}
        <span
          className={`${classBase}-limitPill`}
          data-state={LimitState.SoftBreach}
        >
          Soft
        </span>
      </h3>
      <p className={`${classBase}-overrideOrder`}>{summary}</p>
      <section
        className={`${classBase}-limits`}
        data-state={LimitState.SoftBreach}
      >
        <div className={`${classBase}-limitsHead`}>
          <span>Exceeds limit</span>
        </div>
        <LimitCheckLines lines={breached} />
      </section>
      {room !== undefined ? (
        <div className={`${classBase}-overrideRoom`}>
          <span>Room to hard limit after</span>
          <b>{formatQuantity(room)}</b>
        </div>
      ) : null}
      <div
        aria-label="Reason (required)"
        className={`${classBase}-overrideReasons`}
        role="radiogroup"
      >
        <span className={`${classBase}-overrideLabel`}>Reason (required)</span>
        {OVERRIDE_REASONS.map((reason, i) => (
          // biome-ignore lint/a11y/useSemanticElements: a button radio, picked with 1-4 as well
          <button
            aria-checked={override.reason === reason}
            className={`${classBase}-overrideReason`}
            key={reason}
            onClick={() => setOverride({ reason })}
            ref={i === 0 ? first : undefined}
            role="radio"
            type="button"
          >
            <kbd>{i + 1}</kbd>
            {LIMIT_OVERRIDE_REASON_LABEL[reason]}
          </button>
        ))}
      </div>
      <label className={`${classBase}-overrideNote`}>
        <span className={`${classBase}-overrideLabel`}>
          Note{other ? " (required)" : ""}
        </span>
        <textarea
          onChange={(e) => setOverride({ note: e.target.value })}
          rows={2}
          value={override.note}
        />
      </label>
      <p className={`${classBase}-overrideHint`}>
        1–4 picks · Enter sends · Esc back
      </p>
      <div className={`${classBase}-reviewActions`}>
        <Button
          appearance="bordered"
          data-review-back=""
          onClick={closeReview}
          sentiment="neutral"
        >
          Back <kbd>Esc</kbd>
        </Button>
        <Button
          appearance="solid"
          className={`${classBase}-confirm`}
          disabled={!ready}
          onClick={() => void submit({ confirmed: true, override })}
          sentiment={draft.side === Side.Buy ? "positive" : "negative"}
        >
          Override and send <kbd>↵</kbd>
        </Button>
      </div>
    </div>
  );
};
