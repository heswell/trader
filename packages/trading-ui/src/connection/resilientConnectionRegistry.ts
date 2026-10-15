import {
  type AuthHandler,
  VuuConnectionRegistry,
  type VuuConnectionRegistryOptions,
  type VuuServerConnectionState,
  VuuTokenExchangeError,
  vuuConnectionRegistry,
} from "@vuu-ui/core";
import { ConnectionManager } from "@vuu-ui/vuu-data-remote";
import {
  connectionStateStore,
  type ReconnectState,
} from "./connectionStateStore";
import {
  type ReconnectPolicy,
  reconnectDelay,
  reconnectSchedule,
  resolveReconnectPolicy,
} from "./reconnectPolicy";

type VuuConnectionClient = NonNullable<
  VuuConnectionRegistryOptions["connectionClient"]
>;

/** Default time allowed for one websocket open + LOGIN (ms). */
export const DEFAULT_LOGIN_TIMEOUT_MS = 20_000;

export class ConnectionAttemptTimeoutError extends Error {
  constructor(
    readonly connectionId: string,
    timeoutMs: number,
  ) {
    super(
      `VUU connection ${connectionId}: no LOGIN_SUCCESS within ${timeoutMs}ms`,
    );
    this.name = "ConnectionAttemptTimeoutError";
  }
}

/**
 * Reject a connect attempt that does not settle within `timeoutMs`.
 *
 * Trader upstream issue 83: when vuu-server refuses a LOGIN with a text
 * frame vuu-ui does not recognise (e.g. "maximum sessions (5) reached for
 * user alice", "Invalid session <id>"), the worker never settles the
 * pending login, so ConnectionManager.connectWithLoginResponseTo never
 * resolves and VuuConnectionRegistry's reconnect loop stops for good.
 * With the timeout the attempt fails and the loop tries again later.
 */
export const withConnectTimeout = <T>(
  attempt: Promise<T>,
  connectionId: string,
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return attempt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    attempt,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new ConnectionAttemptTimeoutError(connectionId, timeoutMs)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

export class ConnectionAttemptClosedError extends Error {
  constructor(
    readonly connectionId: string,
    readonly status: string,
  ) {
    super(
      `VUU connection ${connectionId}: the server closed the connection during login (${status})`,
    );
    this.name = "ConnectionAttemptClosedError";
  }
}

const CLOSED_STATUSES = new Set([
  "disconnected",
  "closed",
  "failed",
  "connection-failed",
]);

/**
 * A VuuConnectionClient (ConnectionManager by default) whose connect attempt
 * fails when the socket closes after opening but before LOGIN_SUCCESS (a
 * refused login, trader upstream issue 83), or after `timeoutMs` at most.
 */
export const connectionClientWithTimeout = (
  client: VuuConnectionClient = ConnectionManager,
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
): VuuConnectionClient => ({
  connectWithLoginResponseTo: (connectionId, options, throwOnRejected) => {
    let unsubscribe: (() => void) | undefined;
    // Armed by this attempt's websocket-open, so a late status from an
    // earlier socket cannot fail it.
    const closed = new Promise<never>((_, reject) => {
      let open = false;
      unsubscribe = client.onConnectionStatus(connectionId, (status) => {
        if (status === "websocket-open") open = true;
        else if (open && CLOSED_STATUSES.has(status))
          reject(new ConnectionAttemptClosedError(connectionId, status));
      });
    });
    closed.catch(() => undefined);
    return withConnectTimeout(
      Promise.race([
        client.connectWithLoginResponseTo(
          connectionId,
          options,
          throwOnRejected,
        ),
        closed,
      ]),
      connectionId,
      timeoutMs,
    ).finally(() => unsubscribe?.());
  },
  connectedFor: (connectionId) => client.connectedFor(connectionId),
  destroyConnection: (connectionId) => client.destroyConnection(connectionId),
  onConnectionStatus: (connectionId, listener) =>
    client.onConnectionStatus(connectionId, listener),
});

export interface ResilientConnectionRegistryOptions
  extends Omit<VuuConnectionRegistryOptions, "retryIntervals"> {
  /** Backoff between reconnect attempts. Default: 1 s doubling to 30 s,
   * 50% jitter, never give up. */
  reconnect?: ReconnectPolicy;
  /** Time allowed per connect / reconnect attempt (ms); 0 disables. */
  loginTimeoutMs?: number;
}

const toReconnectState = (
  state: VuuServerConnectionState,
): ReconnectState | undefined => {
  switch (state) {
    case "authenticating":
    case "connecting":
      return "connecting";
    case "connected":
    case "reconnecting":
    case "failed":
    case "unauthorized":
      return state;
    default:
      return undefined;
  }
};

const observed = new WeakSet<VuuConnectionRegistry>();

/**
 * Publish a registry's per-connection state (reconnecting, failed, ...) to
 * connectionStateStore, where useTradingConnectionStatus reads it. Safe to
 * call more than once per registry.
 */
export const observeConnectionRegistry = (
  registry: VuuConnectionRegistry,
  /** Ids whose state is published elsewhere for now (initial retries). */
  isOverridden: (connectionId: string) => boolean = () => false,
) => {
  if (observed.has(registry)) return;
  observed.add(registry);
  registry.onStateChange((connectionId, state, error) => {
    if (isOverridden(connectionId) && state !== "connected") return;
    const next = toReconnectState(state);
    if (next === undefined) {
      if (connectionStateStore.get(connectionId)) {
        connectionStateStore.delete(connectionId);
      }
      return;
    }
    connectionStateStore.set(connectionId, {
      state: next,
      error,
      retry:
        next === "reconnecting"
          ? () => void registry.reconnectNow(connectionId)
          : undefined,
    });
  });
};

/**
 * A VuuConnectionRegistry for a portal host (AuthenticationProvider
 * `registry` prop) that reconnects with exponential backoff + jitter and,
 * by default, never gives up (vuu-ui's default schedule is 1-120 s without
 * jitter and stops after ~4 minutes, then fails the module or the whole
 * portal: trader upstream issue 84). Each connect attempt has a timeout
 * (trader upstream issue 83). Its state is observed for
 * useTradingConnectionStatus.
 */
export const createResilientConnectionRegistry = ({
  connectionClient,
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  reconnect,
  ...options
}: ResilientConnectionRegistryOptions = {}) => {
  const registry = new VuuConnectionRegistry({
    ...options,
    connectionClient: connectionClientWithTimeout(
      connectionClient,
      loginTimeoutMs,
    ),
    // VuuConnectionRegistry iterates retryIntervals with for..of, so an
    // iterable works: fresh jitter per reconnect episode, unbounded.
    retryIntervals: reconnectSchedule(reconnect) as unknown as number[],
  });
  const retrying = retryInitialConnects(registry, reconnect);
  observeConnectionRegistry(registry, (id) => retrying.has(id));
  return registry;
};

const isAuthorizationDenied = (error: unknown) =>
  error instanceof VuuTokenExchangeError &&
  error.failure === "authorization-denied";

interface InitialRetry {
  cancelled: boolean;
  /** The loop holds no registry reference while waiting. */
  waiting: boolean;
  cancel?: () => void;
}

interface InitialRetries {
  loops: Set<InitialRetry>;
  /** Failed attempts so far, shared by every acquirer of the id. */
  failures: number;
  /** The backoff wait every acquirer of the id joins. */
  wait?: { promise: Promise<void>; wake: () => void };
}

/**
 * VuuConnectionRegistry retries only connections that dropped after
 * connecting; a failed first connect (server down, login refused at the
 * session limit, a timeout) rejects acquire and the module shows its error
 * boundary (trader upstream issue 84). This retries acquire with the same
 * backoff instead, publishing "connecting" with the next attempt time and a
 * retry action. All acquirers of an id (the module, VuuServerMonitor) share
 * one backoff wait, so each retry is one login. Authorization denied is not
 * retried. A release from the caller while it waits ends its loop. Returns
 * the ids being retried.
 */
const retryInitialConnects = (
  registry: VuuConnectionRegistry,
  policy?: ReconnectPolicy,
) => {
  const { maxAttempts } = resolveReconnectPolicy(policy);
  const retries = new Map<string, InitialRetries>();
  const acquire = registry.acquire.bind(registry);
  const release = registry.release.bind(registry);

  const backoff = (
    connectionId: string,
    entry: InitialRetries,
    error: unknown,
  ) => {
    if (entry.wait) return entry.wait.promise;
    const delay = reconnectDelay(entry.failures - 1, policy);
    let wake = () => undefined as void;
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).then(() => {
      entry.wait = undefined;
    });
    entry.wait = { promise, wake };
    connectionStateStore.set(connectionId, {
      state: "connecting",
      attempt: entry.failures,
      nextAttemptAt: Date.now() + delay,
      error: error instanceof Error ? error : undefined,
      retry: wake,
    });
    return promise;
  };

  registry.release = (connectionId: string) => {
    const loop = [...(retries.get(connectionId)?.loops ?? [])].find(
      (l) => !l.cancelled,
    );
    if (loop) {
      loop.cancelled = true;
      loop.cancel?.();
      if (loop.waiting) return;
    }
    release(connectionId);
  };

  registry.acquire = async (authHandler: AuthHandler, target) => {
    const { connectionId } = target;
    const entry: InitialRetries = retries.get(connectionId) ?? {
      loops: new Set(),
      failures: 0,
    };
    retries.set(connectionId, entry);
    const loop: InitialRetry = { cancelled: false, waiting: false };
    entry.loops.add(loop);
    try {
      for (;;) {
        // join a backoff already running for this id
        if (entry.wait) await entry.wait.promise;
        // a synchronous throw (conflicting endpoints / auth handler) took no
        // reference and is not retried
        const attempt = acquire(authHandler, target);
        try {
          const session = await attempt;
          entry.failures = 0;
          return session;
        } catch (error) {
          if (loop.cancelled || isAuthorizationDenied(error)) throw error;
          // concurrent acquirers share one attempt: count it once
          if (!entry.wait) entry.failures += 1;
          if (entry.failures >= maxAttempts) throw error;
          // drop this attempt's reference: the registry destroys the
          // half-open connection, the next attempt starts clean
          loop.waiting = true;
          release(connectionId);
          await Promise.race([
            backoff(connectionId, entry, error),
            new Promise<void>((resolve) => {
              loop.cancel = resolve;
            }),
          ]);
          loop.cancel = undefined;
          loop.waiting = false;
          if (loop.cancelled) throw error;
        }
      }
    } finally {
      entry.loops.delete(loop);
      if (entry.loops.size === 0) {
        entry.wait?.wake();
        retries.delete(connectionId);
        if (
          loop.cancelled &&
          connectionStateStore.get(connectionId)?.state === "connecting" &&
          registry.getState(connectionId) === undefined
        )
          connectionStateStore.delete(connectionId);
      }
    }
  };
  return retries;
};

let defaultObserved = false;
/**
 * Observe vuu-ui's default registry (used when a host does not pass its own
 * `registry`), so status hooks still see "reconnecting".
 */
export const observeDefaultConnectionRegistry = () => {
  if (defaultObserved) return;
  defaultObserved = true;
  observeConnectionRegistry(vuuConnectionRegistry);
};
