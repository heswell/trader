/**
 * Window-global "who streams order notifications" lease. Several MF features
 * in one portal window each mount a TradingFeatureRoot without knowing about
 * each other (separate bundles, possibly separate React roots). Only the
 * lease holder subscribes to parentOrders / fills, so each order event is
 * toasted once. When the holder unmounts, the lease passes to the oldest
 * waiting root. The state lives on globalThis under a Symbol.for key, so it
 * is shared even by bundles that do not share @heswell/trading-ui.
 */
type Listener = () => void;

interface LeaseState {
  holder?: symbol;
  queue: symbol[];
  listeners: Set<Listener>;
}

const KEY = Symbol.for("@heswell/trading-ui/notification-lease");

const state = (): LeaseState => {
  const g = globalThis as unknown as Record<symbol, LeaseState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { queue: [], listeners: new Set() };
    g[KEY] = s;
  }
  return s;
};

const emit = (s: LeaseState) => {
  for (const listener of [...s.listeners]) listener();
};

export const notificationLease = {
  /** Ask for the lease (queued if held). Returns release. */
  acquire(token: symbol): () => void {
    const s = state();
    if (s.holder === undefined) s.holder = token;
    else if (s.holder !== token && !s.queue.includes(token))
      s.queue.push(token);
    emit(s);
    return () => {
      const current = state();
      if (current.holder === token) current.holder = current.queue.shift();
      else current.queue = current.queue.filter((t) => t !== token);
      emit(current);
    };
  },
  holder: (): symbol | undefined => state().holder,
  subscribe(listener: Listener): () => void {
    const s = state();
    s.listeners.add(listener);
    return () => {
      s.listeners.delete(listener);
    };
  },
};
