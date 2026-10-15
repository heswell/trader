import { afterEach, describe, expect, test } from "bun:test";
import type {
  AuthHandler,
  VuuConnectionRegistry,
  VuuServerConnectionState,
  VuuSession,
} from "@vuu-ui/core";
import type {
  ConnectionStatus,
  VuuConnectionResult,
} from "@vuu-ui/vuu-data-remote";
import {
  ConnectionAttemptTimeoutError,
  combineConnectionState,
  connectionStateStore,
  createResilientConnectionRegistry,
  observeConnectionRegistry,
  ReconnectSupervisor,
  type ReconnectTimers,
  reconnectDelay,
  reconnectSchedule,
  type SupervisorSnapshot,
  toConnectionState,
  withConnectTimeout,
  worstConnectionState,
} from "../src/connection";

/** Manual timers: advance() runs due callbacks in order. */
const fakeTimers = () => {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: ReconnectTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      // let the attempt's promise chain settle
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = until;
  };
  return { timers, advance, pending, now: () => now };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("reconnectPolicy", () => {
  test("exponential backoff capped at maxDelayMs", () => {
    const noJitter = { jitter: 0 };
    expect(
      [0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelay(a, noJitter)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test("jitter randomises down to (1 - jitter) of the delay", () => {
    expect(reconnectDelay(2, { jitter: 0.5 }, () => 0)).toBe(4_000);
    expect(reconnectDelay(2, { jitter: 0.5 }, () => 1)).toBe(2_000);
    expect(reconnectDelay(2, { jitter: 0.5 }, () => 0.5)).toBe(3_000);
    // clamped to 0..1
    expect(reconnectDelay(0, { jitter: 5 }, () => 1)).toBe(0);
  });

  test("schedule is in seconds, finite only with maxAttempts, fresh per iteration", () => {
    let r = 0;
    const schedule = reconnectSchedule({ maxAttempts: 3, jitter: 0.5 }, () => {
      r += 0.25;
      return r % 1;
    });
    const first = [...schedule];
    const second = [...schedule];
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(first).not.toEqual(second);
    for (const s of [...first, ...second]) {
      expect(s).toBeGreaterThanOrEqual(0.5);
      expect(s).toBeLessThanOrEqual(4);
    }
    const unbounded = reconnectSchedule()[Symbol.iterator]();
    for (let i = 0; i < 100; i++) expect(unbounded.next().done).toBe(false);
  });
});

describe("ReconnectSupervisor", () => {
  const setup = (
    results: Array<"ok" | "fail" | "hang">,
    maxAttempts?: number,
  ) => {
    const clock = fakeTimers();
    const snapshots: SupervisorSnapshot[] = [];
    let calls = 0;
    const supervisor = new ReconnectSupervisor({
      connect: () => {
        const result = results[calls++] ?? "ok";
        if (result === "hang") return new Promise(() => undefined);
        return result === "ok"
          ? Promise.resolve()
          : Promise.reject(Error(`attempt ${calls} failed`));
      },
      onChange: (s) => snapshots.push(s),
      policy: { jitter: 0, maxAttempts },
      random: () => 0,
      timers: clock.timers,
    });
    return { clock, snapshots, supervisor, calls: () => calls };
  };

  test("reconnects with backoff until an attempt succeeds", async () => {
    const { clock, supervisor, calls, snapshots } = setup([
      "fail",
      "fail",
      "ok",
    ]);
    supervisor.connected();
    supervisor.connectionLost(Error("socket closed"));
    expect(supervisor.state).toBe("reconnecting");
    expect(supervisor.snapshot.nextAttemptAt).toBe(clock.now() + 1_000);

    await clock.advance(999);
    expect(calls()).toBe(0);
    await clock.advance(1);
    expect(calls()).toBe(1);
    expect(supervisor.snapshot.attempt).toBe(1);
    expect(supervisor.snapshot.error?.message).toBe("attempt 1 failed");

    await clock.advance(2_000);
    expect(calls()).toBe(2);
    await clock.advance(4_000);
    expect(calls()).toBe(3);
    expect(supervisor.state).toBe("connected");
    expect(supervisor.snapshot.attempt).toBe(0);
    expect(supervisor.snapshot.error).toBeUndefined();
    expect(snapshots.at(-1)?.state).toBe("connected");
  });

  test("connectionLost while reconnecting does not start more attempts", async () => {
    const { clock, supervisor, calls } = setup(["hang"]);
    supervisor.connected();
    supervisor.connectionLost();
    await clock.advance(1_000);
    expect(calls()).toBe(1);
    supervisor.connectionLost();
    supervisor.connectionLost();
    supervisor.retryNow();
    await clock.advance(60_000);
    expect(calls()).toBe(1);
    expect(clock.pending.size).toBe(0);
  });

  test("gives up after maxAttempts, retryNow starts a new episode", async () => {
    const { clock, supervisor, calls } = setup(["fail", "fail", "ok"], 2);
    supervisor.connected();
    supervisor.connectionLost();
    await clock.advance(1_000);
    await clock.advance(2_000);
    expect(calls()).toBe(2);
    expect(supervisor.state).toBe("failed");
    await clock.advance(120_000);
    expect(calls()).toBe(2);

    supervisor.retryNow();
    await flush();
    expect(calls()).toBe(3);
    expect(supervisor.state).toBe("connected");
  });

  test("retryNow skips the backoff wait", async () => {
    const { clock, supervisor, calls } = setup(["ok"]);
    supervisor.connected();
    supervisor.connectionLost();
    supervisor.retryNow();
    await flush();
    expect(calls()).toBe(1);
    expect(supervisor.state).toBe("connected");
    expect(clock.pending.size).toBe(0);
  });

  test("connected() from outside ends the episode; stop() is terminal", async () => {
    const { clock, supervisor, calls } = setup([]);
    supervisor.connected();
    supervisor.connectionLost();
    supervisor.connected();
    expect(clock.pending.size).toBe(0);
    supervisor.stop();
    supervisor.connectionLost();
    supervisor.retryNow();
    await clock.advance(60_000);
    expect(calls()).toBe(0);
    expect(supervisor.state).toBe("stopped");
  });
});

describe("withConnectTimeout", () => {
  test("rejects a connect attempt that never settles", async () => {
    const hung = new Promise<string>(() => undefined);
    const error = await withConnectTimeout(hung, "trading", 10).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionAttemptTimeoutError);
    expect(error.connectionId).toBe("trading");
  });

  test("passes results through and 0 disables", async () => {
    expect(await withConnectTimeout(Promise.resolve("ok"), "x", 1_000)).toBe(
      "ok",
    );
    const p = Promise.resolve("as-is");
    expect(withConnectTimeout(p, "x", 0)).toBe(p);
  });
});

describe("connection state", () => {
  afterEach(() => connectionStateStore.reset());

  test("combines socket status with the reconnect loop's state", () => {
    expect(toConnectionState("reconnected")).toBe("connected");
    expect(toConnectionState("closed")).toBe("disconnected");
    expect(combineConnectionState("disconnected", undefined)).toBe(
      "disconnected",
    );
    expect(
      combineConnectionState("disconnected", { state: "reconnecting" }),
    ).toBe("reconnecting");
    expect(combineConnectionState("closed", { state: "failed" })).toBe(
      "failed",
    );
    expect(combineConnectionState("closed", { state: "unauthorized" })).toBe(
      "failed",
    );
    // the socket being up wins over a stale loop state
    expect(combineConnectionState("connected", { state: "reconnecting" })).toBe(
      "connected",
    );
    expect(combineConnectionState("closed", { state: "connecting" })).toBe(
      "connecting",
    );
  });

  test("worst state of several connections", () => {
    expect(worstConnectionState([])).toBe("connected");
    expect(worstConnectionState(["connected", "reconnecting"])).toBe(
      "reconnecting",
    );
    expect(
      worstConnectionState(["reconnecting", "failed", "disconnected"]),
    ).toBe("failed");
  });

  test("store keeps `since` while the state is unchanged", () => {
    const seen: number[] = [];
    const unsubscribe = connectionStateStore.subscribe(() =>
      seen.push(connectionStateStore.getSnapshot().size),
    );
    connectionStateStore.set("a", { state: "reconnecting", since: 5 });
    connectionStateStore.set("a", { state: "reconnecting", attempt: 2 });
    expect(connectionStateStore.get("a")).toMatchObject({
      state: "reconnecting",
      since: 5,
      attempt: 2,
    });
    const before = connectionStateStore.getSnapshot();
    connectionStateStore.set("a", { state: "connected" });
    expect(connectionStateStore.getSnapshot()).not.toBe(before);
    expect(connectionStateStore.get("a")?.since).not.toBe(5);
    connectionStateStore.delete("a");
    connectionStateStore.delete("a");
    unsubscribe();
    expect(seen).toEqual([1, 1, 1, 0]);
  });

  test("observeConnectionRegistry publishes registry states", () => {
    type Listener = (
      id: string,
      state: VuuServerConnectionState,
      error?: Error,
    ) => void;
    const listeners: Listener[] = [];
    const reconnectNow: string[] = [];
    const registry = {
      onStateChange: (listener: Listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      reconnectNow: (id: string) => {
        reconnectNow.push(id);
        return Promise.resolve();
      },
    } as unknown as VuuConnectionRegistry;
    observeConnectionRegistry(registry);
    observeConnectionRegistry(registry);
    expect(listeners).toHaveLength(1);
    const emit = listeners[0];

    emit("trading", "authenticating");
    expect(connectionStateStore.get("trading")?.state).toBe("connecting");
    emit("trading", "connected");
    expect(connectionStateStore.get("trading")?.retry).toBeUndefined();
    emit("trading", "reconnecting");
    expect(connectionStateStore.get("trading")?.state).toBe("reconnecting");
    connectionStateStore.get("trading")?.retry?.();
    expect(reconnectNow).toEqual(["trading"]);
    const error = Error("denied");
    emit("trading", "unauthorized", error);
    expect(connectionStateStore.get("trading")).toMatchObject({
      state: "unauthorized",
      error,
    });
    emit("trading", "idle");
    expect(connectionStateStore.get("trading")).toBeUndefined();
  });
});

describe("createResilientConnectionRegistry", () => {
  afterEach(() => connectionStateStore.reset());

  test("reconnects after a drop, timing out a hung login, with fresh tokens", async () => {
    type StatusListener = (status: ConnectionStatus) => void;
    const statusListeners = new Set<StatusListener>();
    const logins: string[] = [];
    const behaviour: Array<"ok" | "hang" | "fail"> = [
      "ok",
      "hang",
      "fail",
      "ok",
    ];
    let tokens = 0;
    const connectionClient = {
      connectWithLoginResponseTo: (
        _id: string,
        { token }: { token: string; url: string },
      ) => {
        logins.push(token);
        const result = behaviour.shift() ?? "ok";
        if (result === "hang") return new Promise<never>(() => undefined);
        if (result === "fail") return Promise.reject(Error("refused"));
        return Promise.resolve({
          status: "connected" as const,
          loginResponse: { moduleRegistry: undefined },
        } as unknown as VuuConnectionResult);
      },
      connectedFor: () => false,
      destroyConnection: () => Promise.resolve(),
      onConnectionStatus: (_id: string, listener: StatusListener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    };
    const registry = createResilientConnectionRegistry({
      connectionClient,
      loginTimeoutMs: 30,
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, jitter: 0.5 },
      sessionResolver: {
        resolve: async () => ({
          authorizations: [],
          token: `token-${++tokens}`,
          user: { username: "alice" } as unknown as VuuSession["user"],
        }),
      },
    });
    const states: string[] = [];
    registry.onStateChange((_id, state) => states.push(state));
    const target = {
      connectionId: "trading-test",
      restUrl: "https://localhost/api",
      websocketUrl: "wss://localhost/ws",
    };
    await registry.acquire({} as unknown as AuthHandler, target);
    expect(connectionStateStore.get("trading-test")?.state).toBe("connected");

    for (const listener of statusListeners) listener("disconnected");
    expect(connectionStateStore.get("trading-test")?.state).toBe(
      "reconnecting",
    );
    expect(connectionStateStore.get("trading-test")?.retry).toBeFunction();

    await waitUntil(() => registry.getState("trading-test") === "connected");
    expect(logins).toEqual(["token-1", "token-2", "token-3", "token-4"]);
    expect(states).toEqual([
      "authenticating",
      "connecting",
      "connected",
      "reconnecting",
      "connected",
    ]);
    expect(connectionStateStore.get("trading-test")?.state).toBe("connected");
    await registry.disconnectAll();
    expect(connectionStateStore.get("trading-test")).toBeUndefined();
  });

  const fakeClient = (behaviour: Array<"ok" | "refuse" | "fail">) => {
    type StatusListener = (status: ConnectionStatus) => void;
    const statusListeners = new Set<StatusListener>();
    const destroyed: string[] = [];
    let logins = 0;
    const connectionClient = {
      connectWithLoginResponseTo: () => {
        logins += 1;
        const result = behaviour.shift() ?? "ok";
        if (result === "fail") return Promise.reject(Error("ECONNREFUSED"));
        if (result === "refuse") {
          // socket opens, server answers LOGIN with an unrecognised text
          // frame and closes: the vuu-ui login promise never settles
          setTimeout(() => {
            for (const l of statusListeners) l("websocket-open");
            for (const l of statusListeners) l("disconnected");
          }, 1);
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve({
          status: "connected" as const,
          loginResponse: { moduleRegistry: undefined },
        } as unknown as VuuConnectionResult);
      },
      connectedFor: () => false,
      destroyConnection: (id: string) => {
        destroyed.push(id);
        return Promise.resolve();
      },
      onConnectionStatus: (_id: string, listener: StatusListener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    };
    const registry = createResilientConnectionRegistry({
      connectionClient,
      loginTimeoutMs: 5_000,
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, jitter: 0.5 },
      sessionResolver: {
        resolve: async () => ({
          authorizations: [],
          token: "token",
          user: { username: "alice" } as unknown as VuuSession["user"],
        }),
      },
    });
    return { registry, destroyed, logins: () => logins };
  };
  const target = {
    connectionId: "trading-initial",
    restUrl: "https://localhost/api",
    websocketUrl: "wss://localhost/ws",
  };

  test("retries a failed or refused first connect instead of rejecting", async () => {
    const { registry, destroyed, logins } = fakeClient([
      "fail",
      "refuse",
      "ok",
    ]);
    const seen = new Set<string | undefined>();
    const unsubscribe = connectionStateStore.subscribe(() =>
      seen.add(connectionStateStore.get("trading-initial")?.state),
    );
    const session = await registry.acquire(
      {} as unknown as AuthHandler,
      target,
    );
    unsubscribe();
    expect(session).toBeDefined();
    expect(logins()).toBe(3);
    expect(seen.has("connecting")).toBe(true);
    expect(seen.has("failed")).toBe(false);
    expect(destroyed.length).toBe(2);
    expect(registry.getState("trading-initial")).toBe("connected");
    expect(connectionStateStore.get("trading-initial")?.state).toBe(
      "connected",
    );
    await registry.disconnectAll();
  });

  test("concurrent acquirers of one id share each retry (one login)", async () => {
    const { registry, logins } = fakeClient(["fail", "fail", "ok"]);
    const authHandler = {} as unknown as AuthHandler;
    const [a, b] = await Promise.all([
      registry.acquire(authHandler, target),
      registry.acquire(authHandler, target),
    ]);
    expect(a).toBe(b);
    expect(logins()).toBe(3);
    expect(registry.getRefCount("trading-initial")).toBe(2);
    await registry.disconnectAll();
  });

  test("release while waiting to retry ends the loop", async () => {
    const { registry, logins } = fakeClient(["fail", "fail", "fail", "fail"]);
    const pending = registry.acquire({} as unknown as AuthHandler, target);
    await waitUntil(
      () => connectionStateStore.get("trading-initial")?.state === "connecting",
    );
    registry.release("trading-initial");
    await expect(pending).rejects.toThrow("ECONNREFUSED");
    const attempts = logins();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logins()).toBe(attempts);
    expect(connectionStateStore.get("trading-initial")).toBeUndefined();
    expect(registry.getState("trading-initial")).toBeUndefined();
  });
});

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
