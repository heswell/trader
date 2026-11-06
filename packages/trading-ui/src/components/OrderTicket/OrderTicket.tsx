import {
  type AlgoParamDefinition,
  AlgoStrategy,
  algoStrategyDefinition,
  isPricedOrdType,
  OrdStatus,
  OrdType,
  Side,
  type TimeInForce,
} from "@heswell/trading-schemas";
import {
  Button,
  ComboBox,
  Dropdown,
  Input,
  Option,
  OptionGroup,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { useGridLayoutItem } from "@vuu-ui/grid-layout";
import cx from "clsx";
import { flushSync } from "react-dom";
import {
  type ChangeEvent,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import {
  formatNotional,
  formatPercent,
  formatPrice,
  formatQuantity,
} from "../../utils/formatting";
import { FillProgressBar } from "../FillProgressBar";
import { InstrumentPicker } from "../InstrumentPicker";
import { PanelLinkGroupSelector } from "../LinkGroupSelector";
import { StaleIndicator } from "../StaleIndicator";
import {
  allowedTimesInForce,
  describePriceShorthand,
  filterStrategies,
  isOrderLine,
  isPriceShorthand,
  isValueInput,
  type OrderTicketInstrument,
  parseOrderLine,
  resolvePriceInput,
  scheduleSummary,
} from "./orderTicketModel";
import {
  algoParamField,
  focusTicketField,
  type OrderTicketState,
  type UseOrderTicketProps,
  useOrderTicket,
} from "./useOrderTicket";

import orderTicketCss from "./OrderTicket.css";

const classBase = "tradingOrderTicket";

export type OrderTicketVariant = "panel" | "compact";

export interface OrderTicketProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown">,
    Omit<UseOrderTicketProps, "linkGroup">,
    LinkGroupProps {
  /**
   * "panel" (default): full form for a docked panel or dialog.
   * "compact": a one-line strip for a grid row or ladder.
   */
  variant?: OrderTicketVariant;
  /** Show the instrument picker (default true; false for a fixed ric). */
  showInstrumentPicker?: boolean;
  /** Extra content in the actions row (e.g. a Close button). */
  actions?: ReactNode;
}

const TIF_LABEL: Record<string, string> = {
  DAY: "Day",
  IOC: "IOC",
  FOK: "FOK",
  GTC: "GTC",
};

const priceFormat = (instrument: OrderTicketInstrument | undefined) => ({
  priceDecimals: instrument?.priceDecimals,
  tickSize: instrument?.tickSize,
  tickBands: instrument?.tickBands || undefined,
});

/** Input props with data attributes (e.g. data-order-ticket-field). */
type FieldInputProps = InputHTMLAttributes<HTMLInputElement> & {
  [key: `data-${string}`]: string;
};

/**
 * Select an input's text now (so typing at once replaces it) and again
 * after a click's mouseup, which would otherwise drop the selection.
 */
const selectAll = (input: HTMLInputElement) => {
  input.select();
  requestAnimationFrame(() => {
    if (input.ownerDocument.activeElement === input) input.select();
  });
};

/** A parameter's text for display: "10" → "10%", "45" → "45 min". */
const paramText = (param: AlgoParamDefinition, text: string | undefined) =>
  text && param.unit && /^[\d.]+$/.test(text)
    ? `${text}${param.unit === "%" ? "%" : ` ${param.unit}`}`
    : text;

/** "$27.7k", "$1.25m": a short USD value for hints. */
const usdShort = (usd: number) => {
  const abs = Math.abs(usd);
  const [div, suffix] =
    abs >= 1e9
      ? [1e9, "bn"]
      : abs >= 1e6
        ? [1e6, "m"]
        : abs >= 1e3
          ? [1e3, "k"]
          : [1, ""];
  const v = usd / div;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 || !suffix ? 0 : v >= 10 ? 1 : 2 })}${suffix}`;
};

const sideLabel = (side: string) => (side === Side.Buy ? "Buy" : "Sell");

/** A shortcut badge, shown while Alt / Option is held. */
const Key = ({ children }: { children: ReactNode }) => (
  <kbd aria-hidden className={`${classBase}-key`}>
    {children}
  </kbd>
);

/* ───────────────────────── Header: side is the quote ───────────────────────── */

const SideButton = ({
  ticket,
  side,
}: {
  ticket: OrderTicketState;
  side: Side;
}) => {
  const { instrument, draft, update } = ticket;
  const buy = side === Side.Buy;
  const price = buy ? instrument?.ask : instrument?.bid;
  const size = buy ? instrument?.askSize : instrument?.bidSize;
  const selected = draft.side === side;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button radio keeps the quote layout and stays out of the tab order (Alt shortcuts pick it)
    <button
      aria-checked={selected}
      aria-label={`${sideLabel(side)}${price ? ` at ${formatPrice(price, priceFormat(instrument))}` : ""}`}
      className={`${classBase}-sideButton`}
      data-side={side}
      onClick={() => update({ side })}
      role="radio"
      tabIndex={-1}
      type="button"
    >
      <Key>{buy ? "⌥B" : "⌥S"}</Key>
      <span className={`${classBase}-sideName`}>{sideLabel(side)}</span>
      <span
        className={`${classBase}-sidePrice`}
        data-field={buy ? "ask" : "bid"}
      >
        {formatPrice(price, priceFormat(instrument)) || "–"}
      </span>
      <span className={`${classBase}-sideSize`}>
        {size ? formatQuantity(size) : " "}
      </span>
    </button>
  );
};

const Quote = ({ ticket }: { ticket: OrderTicketState }) => {
  const { instrument } = ticket;
  const format = priceFormat(instrument);
  const bid = instrument?.bid;
  const ask = instrument?.ask;
  const hasTouch = typeof bid === "number" && typeof ask === "number";
  return (
    <div aria-label="Side" className={`${classBase}-quote`} role="radiogroup">
      <SideButton side={Side.Sell} ticket={ticket} />
      <div aria-hidden className={`${classBase}-spread`}>
        {hasTouch ? (
          <>
            <span>spread</span>
            <b>{formatPrice(ask - bid, format)}</b>
            <span>mid {formatPrice((ask + bid) / 2, format)}</span>
          </>
        ) : null}
      </div>
      <SideButton side={Side.Buy} ticket={ticket} />
    </div>
  );
};

/** Description, last / change, phase, position. */
const InstrumentMeta = ({ ticket }: { ticket: OrderTicketState }) => {
  const { instrument, position } = ticket;
  const format = priceFormat(instrument);
  const change = instrument?.change;
  const direction =
    typeof change === "number" && change !== 0
      ? change > 0
        ? "up"
        : "down"
      : undefined;
  return (
    <div className={`${classBase}-meta`} data-direction={direction}>
      {instrument?.description ? (
        <span className={`${classBase}-description`}>
          {[instrument.description, instrument.exchange, instrument.currency]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
      <span className={`${classBase}-metaItem`}>
        Last{" "}
        <b data-field="last">{formatPrice(instrument?.last, format) || "–"}</b>
      </span>
      <span className={`${classBase}-change`} data-field="change">
        {direction ? (direction === "up" ? "▲ " : "▼ ") : ""}
        {formatPrice(change, format) || ""}
        {typeof change === "number" && instrument?.changePct !== undefined
          ? ` (${formatPercent(instrument.changePct)})`
          : ""}
      </span>
      {instrument?.phase && instrument.phase !== "CONTINUOUS" ? (
        <span className={`${classBase}-phase`} data-phase={instrument.phase}>
          {instrument.phase.replaceAll("_", " ").toLowerCase()}
        </span>
      ) : null}
      {position ? (
        <span className={`${classBase}-metaItem`} data-field="position">
          Position{" "}
          <b>
            {position > 0 ? "+" : ""}
            {formatQuantity(position)}
          </b>
        </span>
      ) : null}
      <StaleIndicator />
    </div>
  );
};

/** What an order line in the instrument field will set, as it is typed. */
const OrderLinePreview = ({ text }: { text: string }) => {
  const { words } = parseOrderLine(text);
  return (
    <div aria-live="polite" className={`${classBase}-orderLine`}>
      {words.map((w, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: words of one line
          key={i}
          className={`${classBase}-orderLineWord`}
          data-unknown={w.label ? undefined : ""}
        >
          {w.label ?? `? ${w.text}`}
        </span>
      ))}
      <span className={`${classBase}-orderLineHint`}>↵ to fill the ticket</span>
    </div>
  );
};

/* ───────────────────────── Core: type, quantity, price ───────────────────────── */

const Field = ({
  label,
  unit,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  unit?: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) => (
  <div
    className={cx(`${classBase}-field`, className)}
    data-error={error ? "" : undefined}
  >
    {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the child */}
    <label className={`${classBase}-label`}>
      <span>{label}</span>
      {unit ? <span className={`${classBase}-unit`}>{unit}</span> : null}
    </label>
    {children}
    {error ? (
      <span className={`${classBase}-error`} role="alert">
        {error}
      </span>
    ) : (
      <span className={`${classBase}-hint`}>{hint ?? " "}</span>
    )}
  </div>
);

const OrderTypeRow = ({ ticket }: { ticket: OrderTicketState }) => {
  const { draft, update, instrument, tifNotice, errors } = ticket;
  const tifs = allowedTimesInForce(
    draft.ordType,
    draft.strategy,
    instrument?.phase,
  );
  return (
    <div className={`${classBase}-typeRow`}>
      <div
        aria-label="Order type"
        className={`${classBase}-segments`}
        role="radiogroup"
      >
        {[OrdType.Limit, OrdType.Market].map((ordType) => (
          // biome-ignore lint/a11y/useSemanticElements: a button radio keeps the quote layout and stays out of the tab order (Alt shortcuts pick it)
          <button
            aria-checked={draft.ordType === ordType}
            className={`${classBase}-segment`}
            key={ordType}
            onClick={() => update({ ordType })}
            role="radio"
            tabIndex={-1}
            type="button"
          >
            <Key>{ordType === OrdType.Limit ? "⌥L" : "⌥M"}</Key>
            {ordType === OrdType.Limit ? "Limit" : "Market"}
          </button>
        ))}
      </div>
      <div className={`${classBase}-tif`}>
        {tifNotice || errors.timeInForce ? (
          <output className={`${classBase}-tifNotice`}>
            {errors.timeInForce ?? tifNotice}
          </output>
        ) : null}
        <Dropdown<string>
          aria-label="Time in force"
          bordered
          className={`${classBase}-chip`}
          onSelectionChange={(_, [tif]) =>
            tif && update({ timeInForce: tif as TimeInForce })
          }
          selected={[draft.timeInForce]}
          tabIndex={-1}
          value={TIF_LABEL[draft.timeInForce] ?? draft.timeInForce}
        >
          {tifs.map((tif) => (
            <Option key={tif} value={tif}>
              {TIF_LABEL[tif] ?? tif}
            </Option>
          ))}
        </Dropdown>
        <Key>⌥T</Key>
      </div>
    </div>
  );
};

const QuantityField = ({
  ticket,
  inputRef,
}: {
  ticket: OrderTicketState;
  inputRef: Ref<HTMLInputElement>;
}) => {
  const { draft, update, errors, instrument, risk, resolveShorthand } = ticket;
  const lot = instrument?.lotSize;
  const hint =
    isValueInput(draft.quantity) && risk.quantity ? (
      <>
        <b>= {formatQuantity(risk.quantity)}</b> shares
      </>
    ) : risk.notionalUsd !== undefined && risk.quantity ? (
      `≈ ${usdShort(risk.notionalUsd)}`
    ) : lot && lot > 1 ? (
      `Lot ${formatQuantity(lot)} · 10k, $250k`
    ) : (
      "10k, 1.5m, $250k"
    );
  return (
    <Field error={errors.quantity} hint={hint} label="Quantity" unit="shares">
      <Input
        className={`${classBase}-quantity`}
        inputProps={
          {
            "aria-keyshortcuts": "ArrowUp ArrowDown",
            "aria-label": "Quantity",
            "aria-invalid": errors.quantity ? true : undefined,
            autoComplete: "off",
            inputMode: "decimal",
            "data-order-ticket-field": "quantity",
            onBlur: (e) => resolveShorthand("quantity", e.currentTarget.value),
          } as FieldInputProps
        }
        inputRef={inputRef}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          update({ quantity: e.target.value })
        }
        placeholder={lot ? formatQuantity(lot) : "0"}
        textAlign="right"
        validationStatus={errors.quantity ? "error" : undefined}
        value={draft.quantity}
      />
    </Field>
  );
};

/** Where a limit sits against the touch, e.g. "2 ticks more passive". */
const priceRelation = (
  price: number,
  side: Side,
  instrument: OrderTicketInstrument | undefined,
) => {
  const bid = instrument?.bid;
  const ask = instrument?.ask;
  const tick = instrument?.tickSize;
  if (!bid || !ask || !tick) return undefined;
  const buy = side === Side.Buy;
  const near = buy ? bid : ask;
  const far = buy ? ask : bid;
  if ((buy && price >= far) || (!buy && price <= far)) {
    return price === far
      ? `At the ${buy ? "ask" : "bid"}, crosses`
      : "Through the touch, crosses";
  }
  const ticks = Math.round(((price - near) / tick) * (buy ? 1 : -1));
  if (ticks === 0) return `On the ${buy ? "bid" : "ask"}`;
  return `${Math.abs(ticks)} tick${Math.abs(ticks) === 1 ? "" : "s"} ${
    ticks > 0 ? "inside" : "behind"
  } the ${buy ? "bid" : "ask"}`;
};

const PriceField = ({ ticket }: { ticket: OrderTicketState }) => {
  const { draft, update, errors, instrument, risk, resolveShorthand } = ticket;
  const format = priceFormat(instrument);
  const currency = instrument?.currency;
  if (!isPricedOrdType(draft.ordType)) {
    return (
      <Field
        hint={`Est. at the ${draft.side === Side.Buy ? "ask" : "bid"} · no price limit`}
        label="Price"
        unit={currency}
      >
        <div className={`${classBase}-marketPrice`} data-field="marketPrice">
          <span>Market</span>
          <b>≈ {formatPrice(risk.price, format) || "–"}</b>
        </div>
      </Field>
    );
  }
  const value = resolvePriceInput(draft.price, instrument);
  const shorthand = isPriceShorthand(draft.price)
    ? describePriceShorthand(draft.price)
    : undefined;
  const relation =
    value !== undefined && Number.isFinite(value)
      ? priceRelation(value, draft.side, instrument)
      : undefined;
  const hint = (
    <span className={`${classBase}-priceHint`}>
      {shorthand && value !== undefined && Number.isFinite(value) ? (
        <b>= {formatPrice(value, format)} </b>
      ) : null}
      {relation ?? "b, a, m, b+1"}
    </span>
  );
  return (
    <Field error={errors.price} hint={hint} label="Limit price" unit={currency}>
      <Input
        className={`${classBase}-price`}
        inputProps={
          {
            "aria-keyshortcuts": "ArrowUp ArrowDown",
            "aria-label": "Limit price",
            "aria-invalid": errors.price ? true : undefined,
            autoComplete: "off",
            "data-order-ticket-field": "price",
            onBlur: (e) => resolveShorthand("price", e.currentTarget.value),
          } as FieldInputProps
        }
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          update({ price: e.target.value })
        }
        placeholder="b / a / m"
        textAlign="right"
        validationStatus={errors.price ? "error" : undefined}
        value={draft.price}
      />
    </Field>
  );
};

/* ───────────────────────── Execution: strategy and parameters ───────────────────────── */

const StrategyPicker = ({
  ticket,
  onPicked,
}: {
  ticket: OrderTicketState;
  onPicked: (strategy: AlgoStrategy) => void;
}) => {
  const { draft, update } = ticket;
  const definition = algoStrategyDefinition(draft.strategy);
  const [text, setText] = useState(definition.name);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    setText(definition.name);
    setTyping(false);
  }, [definition.name]);
  const matches = filterStrategies(typing ? text : "");
  const groups = [...new Set(matches.map((d) => d.group))];
  return (
    <ComboBox<string>
      aria-label="Execution strategy"
      className={`${classBase}-strategy`}
      inputProps={
        {
          "data-order-ticket-field": "strategy",
          onFocus: (e) => selectAll(e.currentTarget),
        } as FieldInputProps
      }
      onBlur={() => {
        setText(definition.name);
        setTyping(false);
      }}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        setTyping(true);
      }}
      onSelectionChange={(_: SyntheticEvent, [id]: string[]) => {
        if (!id) return;
        const strategy = id as AlgoStrategy;
        setTyping(false);
        // Render the new strategy's fields now, so onPicked can focus the
        // first one before the next key arrives.
        flushSync(() => update({ strategy }));
        onPicked(strategy);
      }}
      placeholder={definition.name}
      selected={[definition.id]}
      value={text}
    >
      {groups.map((group) => (
        <OptionGroup key={group} label={group}>
          {matches
            .filter((d) => d.group === group)
            .map((d) => (
              <Option key={d.id} value={d.id}>
                <span className={`${classBase}-strategyOption`}>
                  <b>{d.name}</b>
                  <span>{d.description}</span>
                </span>
              </Option>
            ))}
        </OptionGroup>
      ))}
    </ComboBox>
  );
};

const AlgoParamField = ({
  ticket,
  param,
}: {
  ticket: OrderTicketState;
  param: AlgoParamDefinition;
}) => {
  const { draft, errors, setAlgoParam } = ticket;
  const error = errors[param.key];
  const quick = param.quick?.length ? (
    <span className={`${classBase}-quick`}>
      {param.quick.map((q) => (
        <button
          key={q}
          onClick={() => setAlgoParam(param.key, q === "close" ? "" : q)}
          tabIndex={-1}
          type="button"
        >
          {q}
        </button>
      ))}
    </span>
  ) : undefined;
  return (
    <Field
      className={`${classBase}-param`}
      error={error}
      hint={quick}
      label={param.label}
      unit={[param.unit, param.required ? undefined : "optional"]
        .filter(Boolean)
        .join(" · ")}
    >
      <Input
        inputProps={
          {
            "aria-label": param.label,
            "aria-invalid": error ? true : undefined,
            autoComplete: "off",
            "data-order-ticket-field": algoParamField(param.key),
          } as FieldInputProps
        }
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setAlgoParam(param.key, e.target.value)
        }
        placeholder={param.placeholder}
        textAlign="right"
        validationStatus={error ? "error" : undefined}
        value={draft.algoParams[param.key] ?? ""}
      />
    </Field>
  );
};

const Execution = ({
  ticket,
  onPicked,
  compact,
}: {
  ticket: OrderTicketState;
  onPicked: (strategy: AlgoStrategy) => void;
  compact?: boolean;
}) => {
  const { draft, risk, instrument } = ticket;
  const definition = algoStrategyDefinition(draft.strategy);
  const summary = scheduleSummary(draft, risk.quantity);
  const priced = isPricedOrdType(draft.ordType);
  const note =
    definition.id === AlgoStrategy.Dma
      ? definition.description
      : priced
        ? `${definition.description} · limit ${
            formatPrice(risk.price, priceFormat(instrument)) || "–"
          } caps every slice`
        : `${definition.description} · no price limit`;
  return (
    <div className={`${classBase}-execution`} data-strategy={definition.id}>
      <Field
        className={`${classBase}-strategyField`}
        hint={compact ? undefined : note}
        label="Execution"
        unit="⌥E"
      >
        <StrategyPicker onPicked={onPicked} ticket={ticket} />
      </Field>
      {definition.params.length ? (
        <div className={`${classBase}-params`}>
          {definition.params.map((param) => (
            <AlgoParamField key={param.key} param={param} ticket={ticket} />
          ))}
        </div>
      ) : null}
      {summary && !compact ? (
        <div className={`${classBase}-schedule`} data-field="schedule">
          {summary}
        </div>
      ) : null}
    </div>
  );
};

/* ───────────────────────── Footer: value, warnings, status, send ───────────────────────── */

const SubmissionStatus = ({ ticket }: { ticket: OrderTicketState }) => {
  const { submission, order, instrument } = ticket;
  if (submission.state === "idle") return null;
  if (submission.state === "pending") {
    return (
      // biome-ignore lint/a11y/useSemanticElements: live status, not form output
      <div
        className={`${classBase}-status`}
        data-status="PENDING"
        role="status"
      >
        <div className={`${classBase}-statusHead`}>
          <b>Sending…</b>
          <span>{submission.clOrdId}</span>
        </div>
      </div>
    );
  }
  if (submission.state === "rejected") {
    return (
      <div
        className={cx(`${classBase}-status`, `${classBase}-status-rejected`)}
        data-reason={submission.reason}
        data-status={OrdStatus.Rejected}
        role="alert"
      >
        <div className={`${classBase}-statusHead`}>
          <b>Rejected</b>
          <span>{submission.reason}</span>
        </div>
        <div>{submission.text}</div>
      </div>
    );
  }
  const status = (order?.status as string | undefined) ?? submission.status;
  const cumQty = order?.cumQty as number | undefined;
  const avgPx = order?.avgPx as number | undefined;
  const quantity = order?.quantity as number | undefined;
  const strategy = order?.strategy as string | undefined;
  const target = order?.targetQty as number | undefined;
  const algo = strategy && strategy !== AlgoStrategy.Dma;
  const px = formatPrice(avgPx, priceFormat(instrument));
  let text: string;
  switch (status) {
    case OrdStatus.Filled:
      text = `Filled ${formatQuantity(cumQty)} @ ${px}`;
      break;
    case OrdStatus.PartiallyFilled:
      text = algo
        ? `${strategy} working · ${formatQuantity(cumQty)} / ${formatQuantity(quantity)}`
        : `Partially filled ${formatQuantity(cumQty)} / ${formatQuantity(quantity)}`;
      break;
    case OrdStatus.PendingNew:
      text = "Pending acknowledgement";
      break;
    case OrdStatus.New:
      text = algo ? `${strategy} working` : "Accepted";
      break;
    case OrdStatus.Rejected:
      text = `Rejected: ${order?.rejectReason ?? ""} ${order?.text ?? ""}`;
      break;
    default:
      text = `${status}${cumQty ? `, ${formatQuantity(cumQty)} filled` : ""}`;
  }
  const working =
    status === OrdStatus.New || status === OrdStatus.PartiallyFilled;
  return (
    <div
      className={cx(`${classBase}-status`, {
        [`${classBase}-status-rejected`]: status === OrdStatus.Rejected,
        [`${classBase}-status-filled`]: status === OrdStatus.Filled,
      })}
      data-status={status}
      role={status === OrdStatus.Rejected ? "alert" : "status"}
    >
      <div className={`${classBase}-statusHead`}>
        <b>{text}</b>
        <span className={`${classBase}-orderId`}>{submission.orderId}</span>
      </div>
      {quantity ? (
        <FillProgressBar
          filled={cumQty ?? 0}
          target={algo && working ? target : undefined}
          total={quantity}
        />
      ) : null}
      {cumQty || (algo && working && target !== undefined) ? (
        <div className={`${classBase}-statusMeta`}>
          <span>{cumQty ? `avg ${px}` : ""}</span>
          <span>
            {algo && working && target !== undefined
              ? `target ${formatQuantity(target)}`
              : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
};

const Summary = ({ ticket }: { ticket: OrderTicketState }) => {
  const { risk } = ticket;
  return (
    <div className={`${classBase}-preview`}>
      <div className={`${classBase}-summaryRow`}>
        <span>Value</span>
        <span className={`${classBase}-notional`}>
          <b data-field="notional">
            {risk.notional !== undefined
              ? formatNotional(risk.notional, { currency: risk.currency })
              : "–"}
          </b>
          {risk.notionalUsd !== undefined && risk.currency !== "USD" ? (
            <span className={`${classBase}-usd`} data-field="notionalUsd">
              {" "}
              ≈ {formatNotional(risk.notionalUsd, { currency: "USD" })}
            </span>
          ) : null}
        </span>
      </div>
      {risk.warnings.length > 0 ? (
        <ul aria-label="Risk warnings" className={`${classBase}-warnings`}>
          {risk.warnings.map((w) => (
            <li data-warning={w.code} key={w.code}>
              {w.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** "Buy 5,000 AAL.L @ 435.7" and "VWAP · until 15:30 · Day · ACC-US-01". */
const submitText = (ticket: OrderTicketState) => {
  const { draft, risk, instrument } = ticket;
  const priced = isPricedOrdType(draft.ordType);
  const definition = algoStrategyDefinition(draft.strategy);
  const qty = risk.quantity ? ` ${formatQuantity(risk.quantity)}` : "";
  const price = priced
    ? risk.price
      ? ` @ ${formatPrice(risk.price, priceFormat(instrument))}`
      : ""
    : " at market";
  const main = `${sideLabel(draft.side)}${qty}${draft.ric ? ` ${draft.ric}` : ""}${price}`;
  const params = definition.params
    .map((p) => paramText(p, draft.algoParams[p.key]))
    .filter(Boolean)
    .join(" ");
  const detail = [
    params ? `${definition.name} ${params}` : definition.name,
    TIF_LABEL[draft.timeInForce] ?? draft.timeInForce,
    draft.account ?? "no account",
  ].join(" · ");
  return { main, detail };
};

const Review = ({ ticket }: { ticket: OrderTicketState }) => {
  const { draft, risk, instrument, review, submit, closeReview } = ticket;
  const definition = algoStrategyDefinition(draft.strategy);
  const { main } = submitText(ticket);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  const rows: [string, string][] = [
    ["Side", sideLabel(draft.side)],
    ["Instrument", draft.ric ?? "–"],
    ["Quantity", formatQuantity(risk.quantity)],
    [
      "Price",
      isPricedOrdType(draft.ordType)
        ? formatPrice(risk.price, priceFormat(instrument))
        : "Market",
    ],
    [
      "Value",
      risk.notionalUsd !== undefined
        ? formatNotional(risk.notionalUsd, { currency: "USD" })
        : "–",
    ],
    ["Execution", definition.name],
    ...definition.params.map(
      (p) =>
        [p.label, paramText(p, draft.algoParams[p.key]) || "Default"] as [
          string,
          string,
        ],
    ),
    ["Time in force", TIF_LABEL[draft.timeInForce] ?? draft.timeInForce],
    ["Account", draft.account ?? "–"],
  ];
  return (
    <div
      aria-label="Review order"
      className={`${classBase}-review`}
      role="dialog"
    >
      <h3>Check this order</h3>
      <ul className={`${classBase}-reviewReasons`}>
        {review.map((w) => (
          <li key={w.code}>{w.text}</li>
        ))}
      </ul>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
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
          onClick={() => void submit({ confirmed: true })}
          ref={confirmRef}
          sentiment={draft.side === Side.Buy ? "positive" : "negative"}
        >
          Confirm {main.charAt(0).toLowerCase()}
          {main.slice(1)} <kbd>↵</kbd>
        </Button>
      </div>
    </div>
  );
};

/* ───────────────────────── The ticket ───────────────────────── */

/**
 * Order entry. The side buttons carry the quote (Sell on the bid, Buy on
 * the ask). Instrument, side, quantity and price stay in place; the
 * execution strategy and its parameters (from the strategy definitions)
 * sit below them. Keyboard first:
 * - Tab: instrument → quantity → price → strategy → its fields → send.
 * - Alt / Option + B / S side, L / M type, T next TIF, E strategy.
 * - Enter accepts a field and moves on; Ctrl+Enter or F9 sends.
 * - Price `b` / `a` / `m` / `b+2`; quantity `10k` / `$250k`.
 * - The instrument field takes a whole order line (`b 5k vod.l b twap 45m`).
 * Orders over a limit or outside the collar go through Review first.
 */
export const OrderTicket = forwardRef<HTMLDivElement, OrderTicketProps>(
  function OrderTicket(
    {
      actions,
      className,
      clOrdIdPrefix,
      collarPct,
      defaultLinkGroup,
      followSelection,
      linkGroup: linkGroupProp,
      notify,
      onClose,
      onLinkGroupChange,
      onOrderEvent,
      prefill,
      publishSelection,
      rememberAccount,
      showInstrumentPicker = true,
      showLinkGroupSelector = false,
      usdPerPriceUnit,
      variant = "panel",
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-order-ticket",
      css: orderTicketCss,
      window: targetWindow,
    });
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `OrderTicket:${htmlAttributes.id}`
        : "OrderTicket",
    });
    const ticket = useOrderTicket({
      clOrdIdPrefix,
      collarPct,
      followSelection,
      linkGroup: channel,
      notify,
      onClose,
      onOrderEvent,
      prefill,
      publishSelection,
      rememberAccount,
      usdPerPriceUnit,
    });
    const {
      accounts,
      applyOrderLine,
      blockedReason,
      connectionState,
      draft,
      errors,
      handleKeyDown,
      reset,
      review,
      reviewing,
      selectInstrument,
      submission,
      submit,
      update,
    } = ticket;
    const pending = submission.state === "pending";
    const compact = variant === "compact";
    // A grid-layout panel is the frame; elsewhere the ticket is a card.
    const framed = !useGridLayoutItem();

    const rootRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => rootRef.current as HTMLDivElement);
    const quantityRef = useRef<HTMLInputElement>(null);
    // Focus now, so keys typed straight after Enter land in the new field.
    // Check again next frame: the field may not be rendered yet (a new
    // strategy's parameters), or a list may take focus back as it closes.
    const focusField = useCallback((field: string) => {
      const find = () =>
        rootRef.current?.querySelector<HTMLElement>(
          `[data-order-ticket-field="${field}"]`,
        );
      const from = rootRef.current?.ownerDocument.activeElement;
      focusTicketField(find());
      requestAnimationFrame(() => {
        const target = find();
        const active = target?.ownerDocument.activeElement;
        if (
          target &&
          active !== target &&
          (active === from || active === target.ownerDocument.body)
        ) {
          focusTicketField(target);
        }
      });
    }, []);

    // After a send, focus returns to quantity for the next order.
    const lastSubmission = useRef(submission.state);
    useEffect(() => {
      const was = lastSubmission.current;
      lastSubmission.current = submission.state;
      if (
        was === "pending" &&
        submission.state === "accepted" &&
        rootRef.current?.contains(rootRef.current.ownerDocument.activeElement)
      ) {
        focusTicketField(quantityRef.current);
      }
    }, [submission.state]);

    // Shortcut badges while Alt / Option is held.
    const [showKeys, setShowKeys] = useState(false);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Alt") setShowKeys(true);
      handleKeyDown(e);
    };
    const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Alt") setShowKeys(false);
    };

    const [lineText, setLineText] = useState<string | undefined>();
    const onTextCommit = useCallback(
      (text: string) => {
        if (!isOrderLine(text)) return false;
        const applied = applyOrderLine(text);
        if (applied) {
          setLineText(undefined);
          focusField("submit");
        }
        return applied;
      },
      [applyOrderLine, focusField],
    );

    const onStrategyPicked = useCallback(
      (strategy: AlgoStrategy) => {
        const first = algoStrategyDefinition(strategy).params[0];
        focusField(first ? algoParamField(first.key) : "submit");
      },
      [focusField],
    );

    const { main, detail } = submitText(ticket);
    const needsReview = review.length > 0;

    const linkGroupSelector = showLinkGroupSelector ? (
      <PanelLinkGroupSelector onChange={setLinkGroup} value={linkGroup} />
    ) : null;

    const accountChip = (
      <Dropdown<string>
        aria-label="Account"
        bordered
        className={cx(`${classBase}-chip`, `${classBase}-account`)}
        onSelectionChange={(_, [account]) => account && update({ account })}
        placeholder="Account"
        selected={draft.account ? [draft.account] : []}
        tabIndex={-1}
        validationStatus={errors.account ? "error" : undefined}
        value={draft.account ?? ""}
      >
        {accounts.map((a) => (
          <Option key={a.account} value={a.account}>
            {a.account}
            {a.name ? ` – ${a.name}` : ""}
          </Option>
        ))}
      </Dropdown>
    );

    const instrumentField = showInstrumentPicker ? (
      <InstrumentPicker
        aria-label="Instrument or order line"
        className={`${classBase}-instrument`}
        inputProps={
          {
            "data-order-ticket-field": "instrument",
          } as FieldInputProps
        }
        onSelect={(instrument) => {
          selectInstrument(instrument);
          focusField("quantity");
        }}
        onTextChange={setLineText}
        onTextCommit={onTextCommit}
        placeholder={compact ? "Instrument" : "Instrument, or a whole order"}
        selectOnFocus
        validationStatus={errors.ric ? "error" : undefined}
        value={draft.ric}
      />
    ) : (
      <span className={`${classBase}-ric`} data-field="ric">
        {draft.ric}
      </span>
    );

    const submitButton = (
      <Button
        appearance="solid"
        aria-keyshortcuts="F9 Control+Enter"
        className={`${classBase}-submit`}
        data-order-ticket-field="submit"
        data-review={needsReview ? "" : undefined}
        data-side={draft.side}
        disabled={blockedReason !== undefined}
        loading={pending}
        onClick={() => void submit()}
        sentiment={draft.side === Side.Buy ? "positive" : "negative"}
        type="button"
      >
        <span className={`${classBase}-submitMain`}>
          {blockedReason
            ? "Can't send while disconnected"
            : needsReview
              ? `Review ${main.charAt(0).toLowerCase()}${main.slice(1)}`
              : main}
        </span>
        {compact ? null : (
          <span className={`${classBase}-submitDetail`}>{detail}</span>
        )}
        {compact ? null : (
          <kbd aria-hidden className={`${classBase}-submitKey`}>
            Ctrl ↵
          </kbd>
        )}
      </Button>
    );

    const statusAndErrors = (
      <>
        {errors.form && submission.state !== "rejected" ? (
          <div className={`${classBase}-formError`} role="alert">
            {errors.form}
          </div>
        ) : null}
        {errors.account ? (
          <div className={`${classBase}-formError`} role="alert">
            {errors.account}
          </div>
        ) : null}
        <SubmissionStatus ticket={ticket} />
      </>
    );

    return (
      // biome-ignore lint/a11y/useSemanticElements: no native submit; F9 / Ctrl+Enter handled explicitly
      <div
        {...htmlAttributes}
        aria-label={htmlAttributes["aria-label"] ?? "Order ticket"}
        className={cx(classBase, className, `${classBase}-${variant}`)}
        data-connection-state={connectionState}
        data-framed={framed ? "" : undefined}
        data-link-group={linkGroup}
        data-show-keys={showKeys ? "" : undefined}
        data-side={draft.side}
        data-submission={submission.state}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setShowKeys(false);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        ref={rootRef}
        role="form"
      >
        {blockedReason ? (
          <output
            className={`${classBase}-blocked`}
            data-connection-state={connectionState}
          >
            {blockedReason}
          </output>
        ) : null}

        {compact ? (
          <div className={`${classBase}-strip`}>
            {linkGroupSelector}
            {instrumentField}
            <div
              aria-label="Side"
              className={`${classBase}-segments`}
              role="radiogroup"
            >
              {[Side.Buy, Side.Sell].map((side) => (
                // biome-ignore lint/a11y/useSemanticElements: a button radio keeps the quote layout and stays out of the tab order (Alt shortcuts pick it)
                <button
                  aria-checked={draft.side === side}
                  className={`${classBase}-segment`}
                  data-side={side}
                  key={side}
                  onClick={() => update({ side })}
                  role="radio"
                  tabIndex={-1}
                  type="button"
                >
                  {sideLabel(side)}
                </button>
              ))}
            </div>
            <QuantityField inputRef={quantityRef} ticket={ticket} />
            <PriceField ticket={ticket} />
            <Execution compact onPicked={onStrategyPicked} ticket={ticket} />
            <div className={`${classBase}-actions`}>
              {actions}
              {submitButton}
            </div>
          </div>
        ) : (
          <>
            <div className={`${classBase}-header`}>
              <div className={`${classBase}-instrumentRow`}>
                {instrumentField}
                <div className={`${classBase}-context`}>
                  {accountChip}
                  {linkGroupSelector}
                </div>
              </div>
              <InstrumentMeta ticket={ticket} />
              {lineText ? <OrderLinePreview text={lineText} /> : null}
              <Quote ticket={ticket} />
            </div>
            <div className={`${classBase}-body`}>
              <OrderTypeRow ticket={ticket} />
              <div className={`${classBase}-core`}>
                <QuantityField inputRef={quantityRef} ticket={ticket} />
                <PriceField ticket={ticket} />
              </div>
              <Execution onPicked={onStrategyPicked} ticket={ticket} />
            </div>
            <div className={`${classBase}-footer`}>
              <Summary ticket={ticket} />
              {statusAndErrors}
              {submitButton}
              <div className={`${classBase}-actions`}>
                <span className={`${classBase}-nextHint`}>
                  {submission.state === "accepted"
                    ? "Next order: type a quantity"
                    : " "}
                </span>
                {actions}
                <Button
                  appearance="transparent"
                  className={`${classBase}-reset`}
                  onClick={reset}
                  sentiment="neutral"
                  tabIndex={-1}
                  type="button"
                >
                  Reset <kbd>Esc</kbd>
                </Button>
              </div>
            </div>
          </>
        )}
        {compact ? statusAndErrors : null}
        {reviewing ? <Review ticket={ticket} /> : null}
      </div>
    );
  },
);
