import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { TradingOrderEvent } from "../../notifications/tradingOrderEvents";
import { OrderTicket, type OrderTicketProps } from "./OrderTicket";
import {
  OrderTicketDialog,
  type OrderTicketDialogProps,
} from "./OrderTicketDialog";
import type { OrderTicketPrefill } from "./useOrderTicket";

export type OrderTicketTarget = (prefill: OrderTicketPrefill) => void;

export interface OrderTicketLauncher {
  /**
   * Open a ticket with these values: a docked OrderTicketPanel if one is
   * mounted anywhere in the window (the most recently mounted), otherwise a
   * dialog.
   */
  openOrderTicket: (prefill?: OrderTicketPrefill) => void;
  closeOrderTicket: () => void;
  /** False outside an OrderTicketLauncherProvider (openOrderTicket is a no-op). */
  available: boolean;
}

interface LauncherContextValue extends OrderTicketLauncher {
  registerTarget: (target: OrderTicketTarget) => () => void;
}

const NO_LAUNCHER: LauncherContextValue = {
  available: false,
  openOrderTicket: () => undefined,
  closeOrderTicket: () => undefined,
  registerTarget: () => () => undefined,
};

const OrderTicketLauncherContext =
  createContext<LauncherContextValue>(NO_LAUNCHER);

const TARGETS_KEY = Symbol.for("@heswell/trading-ui/order-ticket-targets");

/**
 * The window's docked tickets, most recently mounted last. Window-wide, not
 * per provider: each item of a portal workspace is its own feature root, and
 * Buy / Sell in one item must reach the ticket docked in another.
 */
const dockedTargets = () => {
  const g = globalThis as unknown as Record<
    symbol,
    { current: OrderTicketTarget[] } | undefined
  >;
  g[TARGETS_KEY] ??= { current: [] };
  return g[TARGETS_KEY];
};

export interface OrderTicketLauncherProviderProps {
  children: ReactNode;
  /** Props for the fallback dialog (onOrderEvent, collarPct, ...). */
  dialogProps?: Partial<
    Omit<OrderTicketDialogProps, "open" | "onClose" | "prefill">
  >;
  /** Order events from tickets opened by the launcher. */
  onOrderEvent?: (event: TradingOrderEvent) => void;
}

/**
 * Lets any component open the order ticket with a prefill
 * (`useOrderTicketLauncher().openOrderTicket({ ric, side, price, quantity })`)
 * - grid Buy / Sell actions, ladder clicks, position rows. Mount once in the
 * host, inside the data and instrument providers.
 */
export const OrderTicketLauncherProvider = ({
  children,
  dialogProps,
  onOrderEvent,
}: OrderTicketLauncherProviderProps) => {
  const [dialog, setDialog] = useState<{
    open: boolean;
    prefill?: OrderTicketPrefill;
  }>({
    open: false,
  });

  const openOrderTicket = useCallback((prefill: OrderTicketPrefill = {}) => {
    const target = dockedTargets().current.at(-1);
    if (target) target({ ...prefill });
    else setDialog({ open: true, prefill: { ...prefill } });
  }, []);
  const closeOrderTicket = useCallback(
    () => setDialog((d) => (d.open ? { ...d, open: false } : d)),
    [],
  );
  const registerTarget = useCallback((target: OrderTicketTarget) => {
    const targets = dockedTargets();
    targets.current = targets.current.concat(target);
    return () => {
      targets.current = targets.current.filter((t) => t !== target);
    };
  }, []);

  const value = useMemo(
    () => ({
      available: true,
      openOrderTicket,
      closeOrderTicket,
      registerTarget,
    }),
    [openOrderTicket, closeOrderTicket, registerTarget],
  );

  return (
    <OrderTicketLauncherContext.Provider value={value}>
      {children}
      {dialog.open ? (
        <OrderTicketDialog
          onOrderEvent={onOrderEvent}
          {...dialogProps}
          onClose={closeOrderTicket}
          open
          prefill={dialog.prefill}
        />
      ) : null}
    </OrderTicketLauncherContext.Provider>
  );
};

/** Open the order ticket from anywhere (see OrderTicketLauncherProvider). */
export const useOrderTicketLauncher = (): OrderTicketLauncher => {
  const { available, openOrderTicket, closeOrderTicket } = useContext(
    OrderTicketLauncherContext,
  );
  return useMemo(
    () => ({ available, openOrderTicket, closeOrderTicket }),
    [available, openOrderTicket, closeOrderTicket],
  );
};

/**
 * Receive launcher prefills in a custom docked ticket; returns the latest
 * prefill (a new object per openOrderTicket call).
 */
export const useOrderTicketTarget = (enabled = true) => {
  const { registerTarget } = useContext(OrderTicketLauncherContext);
  const [prefill, setPrefill] = useState<OrderTicketPrefill>();
  useEffect(
    () => (enabled ? registerTarget(setPrefill) : undefined),
    [enabled, registerTarget],
  );
  return prefill;
};

export interface OrderTicketPanelProps extends OrderTicketProps {
  /** Receive openOrderTicket prefills (default true). */
  launcherTarget?: boolean;
}

/**
 * The docked order ticket: a panel-variant OrderTicket that also receives
 * `openOrderTicket` prefills while mounted (instead of a dialog opening).
 * A `prefill` prop applies until the launcher sends one.
 */
export const OrderTicketPanel = ({
  launcherTarget = true,
  prefill: prefillProp,
  ...props
}: OrderTicketPanelProps) => {
  const launched = useOrderTicketTarget(launcherTarget);
  return (
    <OrderTicket
      {...props}
      prefill={launched ?? prefillProp}
      variant={props.variant ?? "panel"}
    />
  );
};
