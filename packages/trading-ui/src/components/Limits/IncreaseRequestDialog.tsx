import {
  FormField,
  FormFieldHelperText,
  FormFieldLabel,
  Input,
  MultilineInput,
  ToggleButton,
  ToggleButtonGroup,
} from "@salt-ds/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { Prompt } from "@vuu-ui/vuu-ui-controls";
import { useLimitsCss } from "./useLimitsCss";
import { type SyntheticEvent, useMemo, useState } from "react";
import type { TradingConnectionState } from "../../connection/useTradingConnectionStatus";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import {
  formatLimitAmount,
  formatUtilisation,
  limitLabel,
} from "./limitFormat";

/** The limit an increase is asked for (a limitUtilisation or limitBreaches row). */
export interface IncreaseTarget {
  limitKey: string;
  entityId: string;
  metric: string;
  ric: string;
  used: number;
  soft: number;
  hard: number;
  breachId?: string;
}

export interface IncreaseRequestDialogProps {
  target: IncreaseTarget;
  /** Any OMS data source, subscribed, to send the RPC through. */
  dataSource: DataSource;
  connectionState?: TradingConnectionState;
  /** Shown as who will be asked. */
  approver?: string;
  onClose: () => void;
  /** Clock, for the expiry choices (tests). */
  now?: () => Date;
}

type Expiry = "day" | "week" | "date";

/** End of day (22:00 local), end of the week (Friday 22:00), or a date's 22:00. */
export const expiryTime = (expiry: Expiry, now: Date, date = "") => {
  const at = new Date(now);
  if (expiry === "date" && date) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d, 22).getTime();
  }
  if (expiry === "week") {
    at.setDate(at.getDate() + ((5 - at.getDay() + 7) % 7));
  }
  at.setHours(22, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
};

const parseAmount = (text: string) => {
  const m = /^\s*([0-9.,]+)\s*([kmb]?)\s*$/i.exec(text);
  if (!m) return Number.NaN;
  const n = Number(m[1].replace(/,/g, ""));
  const unit = m[2].toLowerCase();
  return n * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1);
};

/**
 * Request a temporary increase (the IncreaseRequest board): a new limit
 * keeping the limit's hard margin, an expiry, a reason and detail, sent to
 * a supervisor for approval.
 */
export const IncreaseRequestDialog = ({
  approver,
  connectionState,
  dataSource,
  now = () => new Date(),
  onClose,
  target,
}: IncreaseRequestDialogProps) => {
  useLimitsCss();
  const [amount, setAmount] = useState(String(Math.round(target.soft * 1.25)));
  const [expiry, setExpiry] = useState<Expiry>("day");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const soft = parseAmount(amount);
  const margin = target.soft > 0 ? target.hard / target.soft : 1;
  const expiresAt = useMemo(
    () => expiryTime(expiry, now(), date),
    [expiry, date, now],
  );
  const amountError =
    amount && !(soft > target.soft)
      ? `Must be above ${formatLimitAmount(target.soft)}`
      : "";
  const valid =
    soft > target.soft &&
    reason.trim() !== "" &&
    (expiry !== "date" || date !== "");

  const confirm = (): false => {
    if (!valid || sending) return false;
    setSending(true);
    sendTradingRpc(
      dataSource,
      "requestLimitIncrease",
      {
        limitKey: target.limitKey,
        soft,
        expiresAt,
        reason: reason.trim(),
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        ...(target.breachId ? { breachId: target.breachId } : {}),
      },
      { connectionState },
    )
      .then(() => onClose())
      .catch((err: unknown) => {
        setSending(false);
        setError(
          err instanceof TradingRpcError
            ? err.text || err.message
            : String(err),
        );
      });
    return false;
  };

  return (
    <Prompt
      className="tradingLimitsDialog"
      confirmButtonProps={{
        disabled: !valid || sending,
        label: approver ? `Send to ${approver}` : "Send",
      }}
      onClose={onClose}
      onConfirm={confirm}
      open
      title="Request temporary increase"
    >
      <p className="tradingLimits-muted">
        {limitLabel(target.metric, target.ric)} · {target.entityId}
      </p>
      <dl className="tradingLimits-facts">
        <dt>Now</dt>
        <dd>
          {formatUtilisation(target.soft > 0 ? target.used / target.soft : 0)}{" "}
          of {formatLimitAmount(target.soft)}
        </dd>
        <dt>After</dt>
        <dd>
          {soft > 0
            ? `${formatUtilisation(target.used / soft)} of ${formatLimitAmount(soft)}`
            : ""}
        </dd>
      </dl>
      <div className="tradingLimitsDialog-row">
        <FormField validationStatus={amountError ? "error" : undefined}>
          <FormFieldLabel>New limit (USD)</FormFieldLabel>
          <Input
            bordered
            inputProps={{
              "aria-label": "New limit",
              onChange: (e) => setAmount(e.target.value),
            }}
            value={amount}
          />
          <FormFieldHelperText>
            {amountError ||
              (soft > 0
                ? `+${Math.round((soft / target.soft - 1) * 100)}%`
                : "")}
          </FormFieldHelperText>
        </FormField>
        <FormField readOnly>
          <FormFieldLabel>Hard limit</FormFieldLabel>
          <Input
            bordered
            readOnly
            value={soft > 0 ? Math.round(soft * margin).toLocaleString() : ""}
          />
          <FormFieldHelperText>
            Keeps the limit's {Math.round(margin * 100)}% hard margin
          </FormFieldHelperText>
        </FormField>
      </div>
      <FormField>
        <FormFieldLabel>Expires</FormFieldLabel>
        <ToggleButtonGroup
          aria-label="Expires"
          onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
            setExpiry(e.currentTarget.value as Expiry)
          }
          value={expiry}
        >
          <ToggleButton value="day">End of day</ToggleButton>
          <ToggleButton value="week">End of week</ToggleButton>
          <ToggleButton value="date">On date…</ToggleButton>
        </ToggleButtonGroup>
        {expiry === "date" ? (
          <Input
            bordered
            inputProps={{
              "aria-label": "Expiry date",
              type: "date",
              onChange: (e) => setDate(e.target.value),
            }}
            value={date}
          />
        ) : null}
        <FormFieldHelperText>
          Reverts to {formatLimitAmount(target.soft)} at{" "}
          {new Date(expiresAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </FormFieldHelperText>
      </FormField>
      <FormField>
        <FormFieldLabel>Reason</FormFieldLabel>
        <Input
          bordered
          inputProps={{
            "aria-label": "Reason",
            maxLength: 120,
            onChange: (e) => setReason(e.target.value),
          }}
          value={reason}
        />
      </FormField>
      <FormField validationStatus={error ? "error" : undefined}>
        <FormFieldLabel>Detail</FormFieldLabel>
        <MultilineInput
          bordered
          textAreaProps={{
            "aria-label": "Detail",
            maxLength: 500,
            onChange: (e) => setDetail(e.target.value),
          }}
          value={detail}
        />
        {error ? <FormFieldHelperText>{error}</FormFieldHelperText> : null}
      </FormField>
    </Prompt>
  );
};
