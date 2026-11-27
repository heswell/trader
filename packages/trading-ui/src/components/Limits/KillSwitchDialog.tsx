import {
  Checkbox,
  FormField,
  FormFieldHelperText,
  FormFieldLabel,
  Input,
  ToggleButton,
  ToggleButtonGroup,
} from "@salt-ds/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { Prompt } from "@vuu-ui/vuu-ui-controls";
import { type SyntheticEvent, useState } from "react";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import type { TradingConnectionState } from "../../connection/useTradingConnectionStatus";

/** The entity a kill switch can be turned on for, and those above it. */
export interface KillSwitchScope {
  /** The account, its desk and the Firm (any that apply), nearest first. */
  entities: { entityId: string; entityType: string; label: string }[];
  /** Working orders of each entity, to say how many would be cancelled. */
  workingOrders?: (entityId: string) => number;
}

export interface KillSwitchDialogProps extends KillSwitchScope {
  /** Any OMS data source, subscribed, to send the RPC through. */
  dataSource: DataSource;
  connectionState?: TradingConnectionState;
  /** A breach this kill switch answers, recorded on its timeline. */
  breachId?: string;
  defaultReason?: string;
  onClose: () => void;
  /** After the kill switch is on. */
  onDone?: (entityId: string) => void;
}

const TYPE_LABEL: Record<string, string> = {
  ACCOUNT: "Account",
  DESK: "Desk",
  FIRM: "Firm",
};

/**
 * Stop trading (the KillSwitch board): pick the account, its desk or the
 * Firm, whether to cancel working orders, and a reason. Positions stay
 * open; only a supervisor can turn trading back on.
 */
export const KillSwitchDialog = ({
  breachId,
  connectionState,
  dataSource,
  defaultReason = "",
  entities,
  onClose,
  onDone,
  workingOrders,
}: KillSwitchDialogProps) => {
  const [entityId, setEntityId] = useState(entities[0]?.entityId ?? "");
  const [cancelWorking, setCancelWorking] = useState(true);
  const [reason, setReason] = useState(defaultReason);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const entity = entities.find((e) => e.entityId === entityId);
  const working = workingOrders?.(entityId);

  const confirm = (): false => {
    if (!reason.trim() || sending) return false;
    setSending(true);
    sendTradingRpc(
      dataSource,
      "killSwitch",
      {
        entityId,
        reason: reason.trim(),
        cancelWorking,
        ...(breachId ? { breachId } : {}),
      },
      { connectionState },
    )
      .then(() => {
        onDone?.(entityId);
        onClose();
      })
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
        disabled: !reason.trim() || sending,
        label: "Stop trading",
      }}
      onClose={onClose}
      onConfirm={confirm}
      open
      status="error"
      title="Stop trading"
    >
      <FormField>
        <FormFieldLabel>Scope</FormFieldLabel>
        <ToggleButtonGroup
          aria-label="Scope"
          onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
            setEntityId(e.currentTarget.value)
          }
          value={entityId}
        >
          {entities.map((e) => (
            <ToggleButton key={e.entityId} value={e.entityId}>
              {TYPE_LABEL[e.entityType] ?? e.entityType}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <FormFieldHelperText>{entity?.label}</FormFieldHelperText>
      </FormField>
      <p className="tradingLimits-muted">
        The OMS rejects new orders and amends below {entityId} with KILL_SWITCH,
        and algo orders stop slicing.
      </p>
      <Checkbox
        checked={cancelWorking}
        label={
          working === undefined
            ? "Cancel working orders"
            : `Cancel ${working} working order${working === 1 ? "" : "s"}`
        }
        onChange={(e) => setCancelWorking(e.target.checked)}
      />
      <FormField validationStatus={error ? "error" : undefined}>
        <FormFieldLabel>Reason</FormFieldLabel>
        <Input
          bordered
          inputProps={{
            "aria-label": "Reason",
            maxLength: 200,
            onChange: (e) => setReason(e.target.value),
          }}
          value={reason}
        />
        {error ? <FormFieldHelperText>{error}</FormFieldHelperText> : null}
      </FormField>
      <p className="tradingLimits-muted">
        Positions stay open. Only a supervisor can turn trading back on.
      </p>
    </Prompt>
  );
};
