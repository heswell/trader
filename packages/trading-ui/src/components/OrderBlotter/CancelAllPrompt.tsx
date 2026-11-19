import { Button } from "@salt-ds/core";
import { Prompt } from "@vuu-ui/vuu-ui-controls";
import { useEffect, useRef } from "react";
import type { WorkingOrderSummary } from "./useWorkingOrderSummary";

const classBase = "tradingCancelAllPrompt";

export interface CancelAllPromptProps {
  onCancel: () => void;
  onConfirm: () => void;
  summary: WorkingOrderSummary;
}

const ordersLabel = (n: number) => `${n} ${n === 1 ? "order" : "orders"}`;

/**
 * "Are you sure" before Cancel all. Says how many of the user's working
 * orders it covers (every instrument, not only the blotter's rows) and
 * lists them per RIC. Focus starts on the safe button, Keep orders; Esc and
 * the close button keep the orders too.
 */
export const CancelAllPrompt = ({
  onCancel,
  onConfirm,
  summary: { byRic, count },
}: CancelAllPromptProps) => {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // after the Dialog has moved focus into itself
    const timer = setTimeout(() => keepRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Prompt
      className={classBase}
      customAction={
        <>
          <Button
            appearance="bordered"
            onClick={onCancel}
            ref={keepRef}
            sentiment="neutral"
          >
            Keep orders
          </Button>
          <Button appearance="solid" onClick={onConfirm} sentiment="negative">
            Cancel {ordersLabel(count)}
          </Button>
        </>
      }
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      showCancelButton={false}
      showConfirmButton={false}
      status="error"
      title="Cancel all orders?"
    >
      <p className={`${classBase}-text`}>
        This sends a cancel for{" "}
        <strong>
          {count === 1
            ? "your 1 working order"
            : `all ${count} of your working orders`}
        </strong>
        , in every instrument, not only the rows in this view. Algo orders stop
        slicing.
      </p>
      {byRic.length > 0 ? (
        <ul
          aria-label="Working orders by instrument"
          className={`${classBase}-rics`}
        >
          {byRic.map(({ ric, count: n }) => (
            <li className={`${classBase}-ric`} key={ric}>
              {n > 1 ? `${ric} ×${n}` : ric}
            </li>
          ))}
        </ul>
      ) : null}
    </Prompt>
  );
};
