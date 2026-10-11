import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { orderStatusCategory } from "../../utils/colours";
import { orderStatusIcon, orderStatusLabel } from "../../utils/orderStatus";
import orderStatusBadgeCss from "./OrderStatusBadge.css";

const classBase = "tradingOrderStatusBadge";

export interface OrderStatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** FIX OrdStatus, e.g. PARTIALLY_FILLED. */
  status: string | undefined;
  /** parentOrders.rejectReason: shown in the tooltip for rejected orders. */
  rejectReason?: string;
  /** parentOrders.text: shown in the tooltip. */
  text?: string;
}

/**
 * Order status as icon + text, coloured by `orderStatusColour`. Never colour
 * only. Rejected orders get a tooltip with the reject reason and text.
 * `data-status` / `data-category` are available for CSS and tests.
 */
export const OrderStatusBadge = forwardRef<
  HTMLSpanElement,
  OrderStatusBadgeProps
>(function OrderStatusBadge(
  { className, rejectReason, status, text, title, ...htmlAttributes },
  ref,
) {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-order-status-badge",
    css: orderStatusBadgeCss,
    window: targetWindow,
  });
  const category = orderStatusCategory(status);
  const detail = [rejectReason, text].filter(Boolean).join(": ");
  return (
    <span
      {...htmlAttributes}
      className={cx(classBase, `${classBase}-${category}`, className)}
      data-category={category}
      data-status={status}
      ref={ref}
      title={title ?? (detail || undefined)}
    >
      <span aria-hidden="true" className={`${classBase}-icon`}>
        {orderStatusIcon(status)}
      </span>
      <span className={`${classBase}-label`}>{orderStatusLabel(status)}</span>
    </span>
  );
});
