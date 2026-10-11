import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  type DialogProps,
} from "@salt-ds/core";
import type { ReactNode } from "react";
import { OrderTicket, type OrderTicketProps } from "./OrderTicket";

export interface OrderTicketDialogProps
  extends Omit<OrderTicketProps, "variant" | "title"> {
  open: boolean;
  /** Called when the dialog asks to close (close button, Esc on a clean form). */
  onClose: () => void;
  /** Dialog header (default "New order"). */
  title?: ReactNode;
  size?: DialogProps["size"];
  DialogProps?: Partial<Omit<DialogProps, "open" | "onOpenChange">>;
}

/**
 * The order ticket in a modal Salt Dialog. Esc resets a dirty form first,
 * then closes; click outside does not dismiss (avoids losing a draft).
 */
export const OrderTicketDialog = ({
  open,
  onClose,
  title = "New order",
  size = "medium",
  DialogProps,
  ...ticketProps
}: OrderTicketDialogProps) => (
  <Dialog
    {...DialogProps}
    className="tradingOrderTicketDialog"
    disableDismiss
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
    open={open}
    size={size}
  >
    <DialogHeader header={title} />
    <DialogContent>
      <OrderTicket {...ticketProps} onClose={onClose} variant="panel" />
    </DialogContent>
    <DialogCloseButton aria-label="Close order ticket" onClick={onClose} />
  </Dialog>
);
