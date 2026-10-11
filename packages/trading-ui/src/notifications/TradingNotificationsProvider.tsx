import { useOptionalAuthenticatedUser } from "@vuu-ui/core";
import {
  NotificationsProvider,
  useNotifications,
} from "@vuu-ui/vuu-notifications";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHasDataProvider } from "../data/TradingDataProvider";
import { subscribeTradingRows } from "../data/useTradingRows";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { FillSound } from "./fillSound";
import {
  DEFAULT_DEDUPE_MS,
  DEFAULT_RATE_LIMIT,
  NotificationGate,
  type RateLimit,
} from "./NotificationGate";
import {
  FillEventTracker,
  ParentOrderEventTracker,
} from "./orderEventTrackers";
import {
  describeOrderEvent,
  type OrderEventToast,
  type TradingOrderEvent,
  type TradingOrderEventKind,
} from "./tradingOrderEvents";

export type TradingNotificationKinds = Record<TradingOrderEventKind, boolean>;

/**
 * Default per-kind settings: acks, rejects, fills, cancels and expiries are
 * shown; "submitted" (PENDING_NEW), "filled" (covered by the fill toast) and
 * "replace" are off.
 */
export const DEFAULT_NOTIFICATION_KINDS: Readonly<TradingNotificationKinds> =
  Object.freeze({
    submitted: false,
    ack: true,
    reject: true,
    fill: true,
    filled: false,
    cancel: true,
    replace: false,
    expire: true,
  });

export interface TradingNotificationSettings {
  kinds: TradingNotificationKinds;
  /** Beep on fills (needs `enableSound()` from a user gesture). */
  sound: boolean;
  rateLimit: RateLimit;
  dedupeMs: number;
}

/** A toast to show, for a custom `toastSink`. */
export interface TradingNotificationToast extends OrderEventToast {
  /** The event, or undefined for a rate-limit summary. */
  event?: TradingOrderEvent;
}

export interface TradingNotificationsContextValue {
  /**
   * Report an order event (e.g. from an RPC result). Duplicates of the same
   * event from the streams are dropped.
   */
  notify: (event: TradingOrderEvent) => void;
  settings: TradingNotificationSettings;
  updateSettings: (
    update: Partial<Omit<TradingNotificationSettings, "kinds">> & {
      kinds?: Partial<TradingNotificationKinds>;
    },
  ) => void;
  /**
   * Turn on the fill sound. Call from a click / key handler: browsers only
   * allow audio after a user gesture. Returns false if audio is unavailable.
   */
  enableSound: () => boolean;
  /** True inside a TradingNotificationsProvider. */
  provided: boolean;
}

export interface TradingNotificationsProviderProps {
  children: ReactNode;
  /**
   * Whose orders to follow on the parentOrders / fills streams. Defaults to
   * the authenticated user. Ignored when `scope` is "visibleAccounts".
   */
  trader?: string;
  /**
   * "trader" (default): the trader's own orders. "visibleAccounts": every
   * order on accounts the user can see (supervisors).
   */
  scope?: "trader" | "visibleAccounts";
  /**
   * Subscribe to parentOrders / fills so that events from any source
   * (resting orders filling later, other windows) are shown. Default true;
   * needs a data provider (TradingDataProvider / portal).
   */
  streams?: boolean;
  /** Initial per-kind settings (merged with the defaults). */
  kinds?: Partial<TradingNotificationKinds>;
  /** Initial sound setting (default false). */
  sound?: boolean;
  /** Max toasts per window, then a summary (default 4 per 1000ms). */
  rateLimit?: RateLimit;
  /** Drop repeats of an event within this period (default 30s). */
  dedupeMs?: number;
  /**
   * Render a vuu NotificationsProvider (toast centre) around children. Off
   * by default: the host (portal / app shell) mounts one, once.
   */
  notificationsCenter?: boolean;
  /** Show toasts somewhere else (default: vuu `showNotification`). */
  toastSink?: (toast: TradingNotificationToast) => void;
  /** Called for every event shown (after settings, dedupe, rate limit). */
  onNotification?: (event: TradingOrderEvent) => void;
}

const kindLabel: Record<TradingOrderEventKind, string> = {
  submitted: "sent",
  ack: "accepted",
  reject: "rejected",
  fill: "fills",
  filled: "filled",
  cancel: "cancelled",
  replace: "amended",
  expire: "expired",
};

/** Header/text for a rate-limit summary toast. */
export const describeSuppressed = (
  suppressed: Partial<Record<TradingOrderEventKind, number>>,
): OrderEventToast => {
  const entries = Object.entries(suppressed) as [
    TradingOrderEventKind,
    number,
  ][];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return {
    header: `${total} more order update${total === 1 ? "" : "s"}`,
    content: entries.map(([kind, n]) => `${n} ${kindLabel[kind]}`).join(", "),
    status: entries.some(([kind]) => kind === "reject") ? "warning" : "info",
  };
};

const TradingNotificationsContext = createContext<
  TradingNotificationsContextValue | undefined
>(undefined);

const PARENT_ORDER_COLUMNS = [
  "orderId",
  "clOrdId",
  "trader",
  "ric",
  "side",
  "quantity",
  "price",
  "status",
  "cumQty",
  "avgPx",
  "account",
  "currency",
  "rejectReason",
  "text",
  "lastUpdate",
  "version",
];
const FILL_COLUMNS = [
  "execId",
  "orderId",
  "trader",
  "ric",
  "side",
  "quantity",
  "price",
  "account",
  "currency",
  "timestamp",
];
const STREAM_ROWS = 200;

const traderFilter = (trader: string | undefined) =>
  trader ? `trader = "${trader.replaceAll('"', '\\"')}"` : "";

const OrderEventStreams = ({
  filter,
  onEvents,
}: {
  filter: string;
  onEvents: (events: TradingOrderEvent[]) => void;
}) => {
  const parentOrders = useTradingDataSource("parentOrders", {
    columns: PARENT_ORDER_COLUMNS,
    filterSpec: { filter },
    sort: { sortDefs: [{ column: "lastUpdate", sortType: "D" }] },
  });
  const fills = useTradingDataSource("fills", {
    columns: FILL_COLUMNS,
    filterSpec: { filter },
    sort: { sortDefs: [{ column: "timestamp", sortType: "D" }] },
  });
  const onEventsRef = useRef(onEvents);
  onEventsRef.current = onEvents;

  useEffect(() => {
    const tracker = new ParentOrderEventTracker();
    return subscribeTradingRows(parentOrders, STREAM_ROWS, (rows, size) => {
      const events = tracker.update(rows, size);
      if (events.length) onEventsRef.current(events);
    });
  }, [parentOrders]);
  useEffect(() => {
    const tracker = new FillEventTracker();
    return subscribeTradingRows(fills, STREAM_ROWS, (rows, size) => {
      const events = tracker.update(rows, size);
      if (events.length) onEventsRef.current(events);
    });
  }, [fills]);
  return null;
};

/**
 * Order notifications for a host: toasts for acks, rejects, fills, cancels
 * and expiries of the user's orders, from the parentOrders / fills streams
 * and from components that call `notify` (deduplicated). Mount once, inside
 * the data provider and the vuu NotificationsProvider. See docs/ui-guide.md.
 */
export const TradingNotificationsProvider = ({
  children,
  trader: traderProp,
  scope = "trader",
  streams = true,
  kinds,
  sound = false,
  rateLimit = DEFAULT_RATE_LIMIT,
  dedupeMs = DEFAULT_DEDUPE_MS,
  notificationsCenter = false,
  toastSink,
  onNotification,
}: TradingNotificationsProviderProps) => {
  const user = useOptionalAuthenticatedUser();
  const trader = traderProp ?? user?.userName;
  const hasDataProvider = useHasDataProvider();
  const { showNotification } = useNotifications();
  const [settings, setSettings] = useState<TradingNotificationSettings>(() => ({
    kinds: { ...DEFAULT_NOTIFICATION_KINDS, ...kinds },
    sound,
    rateLimit,
    dedupeMs,
  }));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sinkRef = useRef(toastSink);
  sinkRef.current = toastSink;
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;
  const showRef = useRef(showNotification);
  showRef.current = showNotification;

  const fillSound = useMemo(() => new FillSound(), []);
  useEffect(() => () => fillSound.dispose(), [fillSound]);

  const showToast = useCallback((toast: TradingNotificationToast) => {
    if (sinkRef.current) {
      sinkRef.current(toast);
      return;
    }
    showRef.current({
      type: "toast",
      header: toast.header,
      content: toast.content,
      status: toast.status,
      showCloseButton: toast.status === "error",
      className: toast.event
        ? `tradingNotification tradingNotification-${toast.event.kind}`
        : "tradingNotification",
    });
  }, []);

  const gate = useMemo(
    () =>
      new NotificationGate({
        dedupeMs: settingsRef.current.dedupeMs,
        rateLimit: settingsRef.current.rateLimit,
        emit: (event) => {
          showToast({ ...describeOrderEvent(event), event });
          if (
            (event.kind === "fill" || event.kind === "filled") &&
            settingsRef.current.sound
          ) {
            fillSound.beep();
          }
          onNotificationRef.current?.(event);
        },
        emitSummary: (suppressed) => showToast(describeSuppressed(suppressed)),
      }),
    [fillSound, showToast],
  );
  useEffect(() => () => gate.dispose(), [gate]);
  useEffect(() => {
    gate.dedupeMs = settings.dedupeMs;
    gate.rateLimit = settings.rateLimit;
  }, [gate, settings.dedupeMs, settings.rateLimit]);

  const notify = useCallback(
    (event: TradingOrderEvent) => {
      if (settingsRef.current.kinds[event.kind]) gate.offer(event);
    },
    [gate],
  );
  const notifyAll = useCallback(
    (events: TradingOrderEvent[]) => {
      for (const event of events) notify(event);
    },
    [notify],
  );

  const updateSettings = useCallback<
    TradingNotificationsContextValue["updateSettings"]
  >(({ kinds: kindsUpdate, ...update }) => {
    setSettings((current) => ({
      ...current,
      ...update,
      kinds: { ...current.kinds, ...kindsUpdate },
    }));
  }, []);

  const enableSound = useCallback(() => {
    const ok = fillSound.arm();
    if (ok) updateSettings({ sound: true });
    return ok;
  }, [fillSound, updateSettings]);

  const value = useMemo<TradingNotificationsContextValue>(
    () => ({ notify, settings, updateSettings, enableSound, provided: true }),
    [notify, settings, updateSettings, enableSound],
  );

  const filter = scope === "trader" ? traderFilter(trader) : "";
  const streaming =
    streams && hasDataProvider && (scope === "visibleAccounts" || !!trader);

  const content = (
    <TradingNotificationsContext.Provider value={value}>
      {streaming ? (
        <OrderEventStreams filter={filter} key={filter} onEvents={notifyAll} />
      ) : null}
      {children}
    </TradingNotificationsContext.Provider>
  );
  return notificationsCenter ? (
    <NotificationsProvider>{content as ReactElement}</NotificationsProvider>
  ) : (
    content
  );
};

/**
 * Report order events and read / change notification settings. Outside a
 * TradingNotificationsProvider, `notify` shows a vuu toast directly (no
 * stream, dedupe or rate limiting) and settings are the defaults.
 */
export const useTradingNotifications = (): TradingNotificationsContextValue => {
  const context = useContext(TradingNotificationsContext);
  const { showNotification } = useNotifications();
  const fallback = useMemo<TradingNotificationsContextValue>(
    () => ({
      notify: (event) => {
        if (!DEFAULT_NOTIFICATION_KINDS[event.kind]) return;
        const toast = describeOrderEvent(event);
        showNotification({ type: "toast", ...toast });
      },
      settings: {
        kinds: { ...DEFAULT_NOTIFICATION_KINDS },
        sound: false,
        rateLimit: DEFAULT_RATE_LIMIT,
        dedupeMs: DEFAULT_DEDUPE_MS,
      },
      updateSettings: () => undefined,
      enableSound: () => false,
      provided: false,
    }),
    [showNotification],
  );
  return context ?? fallback;
};
