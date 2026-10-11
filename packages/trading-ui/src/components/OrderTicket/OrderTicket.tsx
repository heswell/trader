import {
  isPricedOrdType,
  OrdStatus,
  OrdType,
  Side,
  type TimeInForce,
} from "@heswell/trading-schemas";
import {
  Button,
  Dropdown,
  FormField,
  FormFieldHelperText,
  FormFieldLabel,
  Input,
  Option,
  ToggleButton,
  ToggleButtonGroup,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  type ChangeEvent,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  formatNotional,
  formatPercent,
  formatPrice,
  formatQuantity,
} from "../../utils/formatting";
import { InstrumentPicker } from "../InstrumentPicker";
import { StaleIndicator } from "../StaleIndicator";
import {
  isTimeInForceAllowed,
  ORDER_TICKET_ORD_TYPES,
  ORDER_TICKET_TIFS,
  type OrderTicketInstrument,
} from "./orderTicketModel";
import {
  type OrderTicketState,
  type UseOrderTicketProps,
  useOrderTicket,
} from "./useOrderTicket";

import orderTicketCss from "./OrderTicket.css";

const classBase = "tradingOrderTicket";

export type OrderTicketVariant = "panel" | "compact";

export interface OrderTicketProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown">,
    UseOrderTicketProps {
  /**
   * "panel" (default): full form for a docked panel or dialog.
   * "compact": a dense inline strip for a grid row or ladder.
   */
  variant?: OrderTicketVariant;
  /** Show the instrument picker (default true; false for a fixed ric). */
  showInstrumentPicker?: boolean;
  /** Extra content in the actions row (e.g. a Close button). */
  actions?: ReactNode;
}

const ORD_TYPE_LABEL: Record<string, string> = {
  [OrdType.Market]: "Market",
  [OrdType.Limit]: "Limit",
  [OrdType.Stop]: "Stop",
  [OrdType.StopLimit]: "Stop limit",
};
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

const fieldInputProps = (field: "price" | "quantity") =>
  ({
    "aria-keyshortcuts": "ArrowUp ArrowDown",
    "aria-label": field === "price" ? "Limit price" : "Quantity",
    autoComplete: "off",
    inputMode: "decimal",
    "data-order-ticket-field": field,
  }) as InputHTMLAttributes<HTMLInputElement> & {
    [key: `data-${string}`]: string;
  };

const sideLabel = (side: string) => (side === Side.Buy ? "Buy" : "Sell");

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
        Sending order {submission.clOrdId}…
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
        Rejected: {submission.reason} {submission.text}
      </div>
    );
  }
  const status = (order?.status as string | undefined) ?? submission.status;
  const cumQty = order?.cumQty as number | undefined;
  const avgPx = order?.avgPx as number | undefined;
  const quantity = order?.quantity as number | undefined;
  let text: string;
  switch (status) {
    case OrdStatus.Filled:
      text = `Filled ${formatQuantity(cumQty)} @ ${formatPrice(avgPx, priceFormat(instrument))}`;
      break;
    case OrdStatus.PartiallyFilled:
      text = `Partially filled ${formatQuantity(cumQty)} / ${formatQuantity(quantity)} @ ${formatPrice(avgPx, priceFormat(instrument))}`;
      break;
    case OrdStatus.PendingNew:
      text = "Pending acknowledgement";
      break;
    case OrdStatus.New:
      text = "Accepted";
      break;
    case OrdStatus.Rejected:
      text = `Rejected: ${order?.rejectReason ?? ""} ${order?.text ?? ""}`;
      break;
    default:
      text = `${status}${cumQty ? `, ${formatQuantity(cumQty)} filled` : ""}`;
  }
  return (
    <div
      className={cx(`${classBase}-status`, {
        [`${classBase}-status-rejected`]: status === OrdStatus.Rejected,
      })}
      data-status={status}
      role={status === OrdStatus.Rejected ? "alert" : "status"}
    >
      {text}{" "}
      <span className={`${classBase}-orderId`}>{submission.orderId}</span>
    </div>
  );
};

const QuoteStrip = ({ ticket }: { ticket: OrderTicketState }) => {
  const { instrument, setPriceFrom, draft } = ticket;
  const format = priceFormat(instrument);
  const priced = isPricedOrdType(draft.ordType);
  const change = instrument?.change;
  const direction =
    typeof change === "number" && change !== 0
      ? change > 0
        ? "up"
        : "down"
      : undefined;
  return (
    <div className={`${classBase}-quote`} data-direction={direction}>
      <Button
        appearance="transparent"
        aria-label={`Bid ${formatPrice(instrument?.bid, format)}, use as price`}
        className={`${classBase}-touch`}
        disabled={!priced || !instrument?.bid}
        onClick={() => setPriceFrom(instrument?.bid)}
        sentiment="neutral"
      >
        <span className={`${classBase}-quoteLabel`}>Bid</span>
        <span className={`${classBase}-quoteValue`}>
          {formatPrice(instrument?.bid, format) || "–"}
        </span>
      </Button>
      <Button
        appearance="transparent"
        aria-label={`Ask ${formatPrice(instrument?.ask, format)}, use as price`}
        className={`${classBase}-touch`}
        disabled={!priced || !instrument?.ask}
        onClick={() => setPriceFrom(instrument?.ask)}
        sentiment="neutral"
      >
        <span className={`${classBase}-quoteLabel`}>Ask</span>
        <span className={`${classBase}-quoteValue`}>
          {formatPrice(instrument?.ask, format) || "–"}
        </span>
      </Button>
      <span className={`${classBase}-quoteItem`}>
        <span className={`${classBase}-quoteLabel`}>Last</span>
        <span className={`${classBase}-quoteValue`} data-field="last">
          {formatPrice(instrument?.last, format) || "–"}
        </span>
      </span>
      <span className={`${classBase}-quoteItem`}>
        <span className={`${classBase}-quoteLabel`}>Chg</span>
        <span
          className={cx(`${classBase}-quoteValue`, `${classBase}-change`)}
          data-field="change"
        >
          {direction ? (direction === "up" ? "▲ " : "▼ ") : ""}
          {formatPrice(change, format) || "–"}{" "}
          {instrument?.changePct !== undefined
            ? `(${formatPercent(instrument.changePct)})`
            : ""}
        </span>
      </span>
      {instrument?.phase && instrument.phase !== "CONTINUOUS" ? (
        <span className={`${classBase}-phase`} data-phase={instrument.phase}>
          {instrument.phase.replaceAll("_", " ")}
        </span>
      ) : null}
      <StaleIndicator />
    </div>
  );
};

const RiskPreviewView = ({ ticket }: { ticket: OrderTicketState }) => {
  const { risk } = ticket;
  return (
    <div className={`${classBase}-preview`}>
      <span className={`${classBase}-notional`}>
        <span className={`${classBase}-quoteLabel`}>Notional</span>{" "}
        <span data-field="notional">
          {risk.notional !== undefined
            ? formatNotional(risk.notional, { currency: risk.currency })
            : "–"}
        </span>
        {risk.notionalUsd !== undefined && risk.currency !== "USD" ? (
          <span className={`${classBase}-usd`} data-field="notionalUsd">
            {" "}
            ≈ {formatNotional(risk.notionalUsd, { currency: "USD" })}
          </span>
        ) : null}
      </span>
      {risk.warnings.length > 0 ? (
        <ul className={`${classBase}-warnings`} aria-label="Risk warnings">
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

/**
 * Order entry: instrument, side, quantity (lot validated), order type,
 * limit price (tick validated, band-aware nudges), TIF and account, with a
 * live quote, notional / risk preview and the order's status once sent.
 * Keyboard: B / S side, F9 or Ctrl+Enter submit, Esc reset then close,
 * ArrowUp / ArrowDown in price (ticks) or quantity (lots), Shift ×10.
 */
export const OrderTicket = forwardRef<HTMLDivElement, OrderTicketProps>(
  function OrderTicket(
    {
      actions,
      className,
      clOrdIdPrefix,
      collarPct,
      followSelection,
      notify,
      onClose,
      onOrderEvent,
      prefill,
      publishSelection,
      rememberAccount,
      showInstrumentPicker = true,
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
    const ticket = useOrderTicket({
      clOrdIdPrefix,
      collarPct,
      followSelection,
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
      draft,
      errors,
      handleKeyDown,
      instrument,
      nudge,
      reset,
      selectInstrument,
      submission,
      submit,
      update,
    } = ticket;
    const priced = isPricedOrdType(draft.ordType);
    const pending = submission.state === "pending";
    const compact = variant === "compact";
    const lotSize = instrument?.lotSize;

    const sideChange = (e: SyntheticEvent<HTMLButtonElement>) =>
      update({ side: e.currentTarget.value as Side });
    const ordTypeChange = (e: SyntheticEvent<HTMLButtonElement>) =>
      update({ ordType: e.currentTarget.value as OrdType });

    const submitLabel = `${sideLabel(draft.side)}${
      draft.quantity ? ` ${draft.quantity}` : ""
    }${draft.ric ? ` ${draft.ric}` : ""}`;

    return (
      // biome-ignore lint/a11y/useSemanticElements: no native submit; F9 / Ctrl+Enter handled explicitly
      <div
        {...htmlAttributes}
        aria-label={htmlAttributes["aria-label"] ?? "Order ticket"}
        className={cx(classBase, className, `${classBase}-${variant}`)}
        data-side={draft.side}
        data-submission={submission.state}
        onKeyDown={handleKeyDown}
        ref={ref}
        role="form"
      >
        {showInstrumentPicker ? (
          <FormField
            className={`${classBase}-instrument`}
            validationStatus={errors.ric ? "error" : undefined}
          >
            <FormFieldLabel>Instrument</FormFieldLabel>
            <InstrumentPicker onSelect={selectInstrument} value={draft.ric} />
            {errors.ric ? (
              <FormFieldHelperText>{errors.ric}</FormFieldHelperText>
            ) : null}
          </FormField>
        ) : (
          <span className={`${classBase}-ric`} data-field="ric">
            {draft.ric}
          </span>
        )}
        {!compact || !showInstrumentPicker ? (
          <QuoteStrip ticket={ticket} />
        ) : null}

        <div className={`${classBase}-row`}>
          <ToggleButtonGroup
            aria-label="Side"
            className={`${classBase}-side`}
            onChange={sideChange}
            value={draft.side}
          >
            <ToggleButton data-side={Side.Buy} value={Side.Buy}>
              Buy
            </ToggleButton>
            <ToggleButton data-side={Side.Sell} value={Side.Sell}>
              Sell
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            aria-label="Order type"
            className={`${classBase}-ordType`}
            onChange={ordTypeChange}
            value={draft.ordType}
          >
            {ORDER_TICKET_ORD_TYPES.map((ordType) => (
              <ToggleButton key={ordType} value={ordType}>
                {ORD_TYPE_LABEL[ordType] ?? ordType}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </div>

        <div className={`${classBase}-row`}>
          <FormField
            className={`${classBase}-quantity`}
            validationStatus={errors.quantity ? "error" : undefined}
          >
            <FormFieldLabel>Quantity</FormFieldLabel>
            <div className={`${classBase}-stepper`}>
              <Button
                aria-label="Decrease quantity by one lot"
                appearance="bordered"
                onClick={() => nudge("quantity", -1)}
                sentiment="neutral"
                tabIndex={-1}
              >
                −
              </Button>
              <Input
                inputProps={fieldInputProps("quantity")}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  update({ quantity: e.target.value })
                }
                placeholder={
                  lotSize ? `Lot ${formatQuantity(lotSize)}` : undefined
                }
                textAlign="right"
                value={draft.quantity}
              />
              <Button
                aria-label="Increase quantity by one lot"
                appearance="bordered"
                onClick={() => nudge("quantity", 1)}
                sentiment="neutral"
                tabIndex={-1}
              >
                +
              </Button>
            </div>
            {errors.quantity ? (
              <FormFieldHelperText>{errors.quantity}</FormFieldHelperText>
            ) : null}
          </FormField>

          <FormField
            className={`${classBase}-price`}
            disabled={!priced}
            validationStatus={errors.price ? "error" : undefined}
          >
            <FormFieldLabel>{priced ? "Limit price" : "Price"}</FormFieldLabel>
            <div className={`${classBase}-stepper`}>
              <Button
                aria-label="Decrease price by one tick"
                appearance="bordered"
                disabled={!priced}
                onClick={() => nudge("price", -1)}
                sentiment="neutral"
                tabIndex={-1}
              >
                ▼
              </Button>
              <Input
                disabled={!priced}
                inputProps={fieldInputProps("price")}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  update({ price: e.target.value })
                }
                placeholder={priced ? undefined : "Market"}
                textAlign="right"
                value={priced ? draft.price : ""}
              />
              <Button
                aria-label="Increase price by one tick"
                appearance="bordered"
                disabled={!priced}
                onClick={() => nudge("price", 1)}
                sentiment="neutral"
                tabIndex={-1}
              >
                ▲
              </Button>
            </div>
            {errors.price ? (
              <FormFieldHelperText>{errors.price}</FormFieldHelperText>
            ) : null}
          </FormField>
        </div>

        <div className={`${classBase}-row`}>
          <FormField
            className={`${classBase}-tif`}
            validationStatus={errors.timeInForce ? "error" : undefined}
          >
            <FormFieldLabel>Time in force</FormFieldLabel>
            <Dropdown<string>
              onSelectionChange={(_, [tif]) =>
                tif && update({ timeInForce: tif as TimeInForce })
              }
              selected={[draft.timeInForce]}
              value={TIF_LABEL[draft.timeInForce] ?? draft.timeInForce}
            >
              {ORDER_TICKET_TIFS.map((tif) => (
                <Option
                  disabled={!isTimeInForceAllowed(draft.ordType, tif)}
                  key={tif}
                  value={tif}
                >
                  {TIF_LABEL[tif] ?? tif}
                </Option>
              ))}
            </Dropdown>
            {errors.timeInForce ? (
              <FormFieldHelperText>{errors.timeInForce}</FormFieldHelperText>
            ) : null}
          </FormField>
          <FormField
            className={`${classBase}-account`}
            validationStatus={errors.account ? "error" : undefined}
          >
            <FormFieldLabel>Account</FormFieldLabel>
            <Dropdown<string>
              onSelectionChange={(_, [account]) =>
                account && update({ account })
              }
              placeholder="Select account"
              selected={draft.account ? [draft.account] : []}
              value={draft.account ?? ""}
            >
              {accounts.map((a) => (
                <Option key={a.account} value={a.account}>
                  {a.account}
                  {a.name ? ` – ${a.name}` : ""}
                </Option>
              ))}
            </Dropdown>
            {errors.account ? (
              <FormFieldHelperText>{errors.account}</FormFieldHelperText>
            ) : null}
          </FormField>
        </div>

        <RiskPreviewView ticket={ticket} />

        {errors.form ? (
          <div className={`${classBase}-formError`} role="alert">
            {errors.form}
          </div>
        ) : null}
        <SubmissionStatus ticket={ticket} />

        <div className={`${classBase}-actions`}>
          {actions}
          <Button
            appearance="bordered"
            onClick={reset}
            sentiment="neutral"
            type="button"
          >
            Reset
          </Button>
          <Button
            appearance="solid"
            aria-keyshortcuts="F9 Control+Enter"
            className={`${classBase}-submit`}
            data-side={draft.side}
            loading={pending}
            onClick={() => void submit()}
            sentiment={draft.side === Side.Buy ? "positive" : "negative"}
            type="button"
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    );
  },
);
