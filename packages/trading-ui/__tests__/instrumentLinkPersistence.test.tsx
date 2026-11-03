import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import {
  createPortalPersistenceService,
  InMemoryPersistenceBackend,
  type PortalPersistenceService,
  PortalPersistenceProvider,
} from "@vuu-ui/core/portal";
import type { ReactNode } from "react";
import {
  ACTIVE_CHANNEL_STATE_KEY,
  type BroadcastChannelLike,
  bindInstrumentLinkStore,
  connectBroadcastChannel,
  createInstrumentLinkBus,
  ensureInstrumentLinkPersistence,
  getInstrumentLinkBus,
  getInstrumentLinkStore,
  INSTRUMENT_LINK_BUS_VERSION,
  INSTRUMENT_LINK_STATE_KEY,
  INSTRUMENT_LINK_STATE_VERSION,
  InstrumentLinkPersistence,
  LINK_SELECTIONS_KEY,
  readSavedSelections,
  resetInstrumentLinkPersistence,
  useWorkspaceChannel,
  WorkspaceChannelProvider,
} from "../src";

const services: PortalPersistenceService[] = [];
/** A portal persistence service on `backend` (a new one = a reload). */
const newService = (backend: InMemoryPersistenceBackend) => {
  const service = createPortalPersistenceService({
    backend,
    user: "trader",
    debounceMs: 0,
    window: null,
  });
  services.push(service);
  return service;
};

/** Forget the window-wide bus, as a reload does (the next one has a new id). */
const dropWindowBus = () => {
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[
    Symbol.for(
      `@heswell/trading-ui/instrument-link-bus/v${INSTRUMENT_LINK_BUS_VERSION}`,
    )
  ];
};

const flush = async (service: PortalPersistenceService) => {
  await service.flushAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  cleanup();
  resetInstrumentLinkPersistence();
  dropWindowBus();
  for (const service of services.splice(0)) service.dispose();
});

describe("instrument link persistence", () => {
  test("selections survive a reload; unlinked groups are not saved", async () => {
    const backend = new InMemoryPersistenceBackend();
    const service = newService(backend);
    const bus = createInstrumentLinkBus();
    const store = getInstrumentLinkStore(service);
    bindInstrumentLinkStore(bus, store);
    await store.ready;

    bus.publish("red", { ric: "BARC.L", currency: "GBP" }, "grid");
    bus.publish("green", { ric: "VOD.L" }, "grid");
    bus.publish("unlinked:abc", { ric: "AAPL.OQ" }, "grid");
    await flush(service);
    const saved = store.get(LINK_SELECTIONS_KEY) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["green", "red"]);

    // reload: a new service and bus on the same backend
    const reloaded = newService(backend);
    const nextBus = createInstrumentLinkBus();
    const nextStore = getInstrumentLinkStore(reloaded);
    bindInstrumentLinkStore(nextBus, nextStore);
    await nextStore.ready;
    await Promise.resolve();
    expect(nextBus.getSelection("red")?.instrument).toEqual({
      ric: "BARC.L",
      currency: "GBP",
    });
    expect(nextBus.getSelection("green")?.instrument?.ric).toBe("VOD.L");
    // a later local selection wins over the restored one in other windows
    expect(nextBus.publish("red", { ric: "HSBA.L" })).toBe(true);
    expect(nextBus.getSelection("red")?.seq).toBeGreaterThan(
      bus.getSelection("red")?.seq ?? Infinity,
    );
  });

  test("clearing a channel removes it from the saved state", async () => {
    const service = newService(new InMemoryPersistenceBackend());
    const bus = createInstrumentLinkBus();
    const store = getInstrumentLinkStore(service);
    bindInstrumentLinkStore(bus, store);
    await store.ready;
    bus.publish("red", { ric: "BARC.L" });
    bus.publish("red", undefined);
    expect(store.get(LINK_SELECTIONS_KEY)).toEqual({});
  });

  test("restore does not overwrite a selection the bus already has", async () => {
    const backend = new InMemoryPersistenceBackend();
    const first = newService(backend);
    const firstStore = getInstrumentLinkStore(first);
    await firstStore.ready;
    firstStore.set(LINK_SELECTIONS_KEY, {
      red: { instrument: { ric: "BARC.L" }, seq: 3, origin: "old" },
      blue: { instrument: { ric: "VOD.L" }, seq: 4, origin: "old" },
    });
    await flush(first);

    // a popout that already synced red over BroadcastChannel
    const bus = createInstrumentLinkBus();
    bus.receive("red", {
      instrument: { ric: "HSBA.L" },
      source: undefined,
      seq: 1,
      origin: "main-window",
    });
    const store = getInstrumentLinkStore(newService(backend));
    bindInstrumentLinkStore(bus, store);
    await store.ready;
    await Promise.resolve();
    expect(bus.getSelection("red")?.instrument?.ric).toBe("HSBA.L");
    expect(bus.getSelection("blue")?.instrument?.ric).toBe("VOD.L");
  });

  test("clearing the saved state clears the channels", async () => {
    const service = newService(new InMemoryPersistenceBackend());
    const bus = createInstrumentLinkBus();
    const store = getInstrumentLinkStore(service);
    bindInstrumentLinkStore(bus, store);
    await store.ready;
    bus.publish("red", { ric: "BARC.L" });
    await flush(service);
    await service.clear([
      {
        applicationKey: INSTRUMENT_LINK_STATE_KEY,
        applicationVersion: INSTRUMENT_LINK_STATE_VERSION,
      },
    ]);
    expect(bus.getSelection("red")?.instrument).toBeUndefined();
    expect(store.get(LINK_SELECTIONS_KEY)).toBeUndefined();
  });

  test("malformed saved entries are dropped", () => {
    expect(
      readSavedSelections({
        red: { instrument: { ric: "BARC.L", junk: 1 }, seq: 2, origin: "x" },
        green: { instrument: { ric: " " }, seq: 1, origin: "x" },
        blue: "nope",
        "unlinked:1": { instrument: { ric: "VOD.L" }, seq: 1, origin: "x" },
      }),
    ).toEqual([
      [
        "red",
        {
          instrument: { ric: "BARC.L" },
          source: undefined,
          seq: 2,
          origin: "x",
        },
      ],
    ]);
    expect(readSavedSelections(undefined)).toEqual([]);
  });

  test("binds the window bus once per service", async () => {
    const service = newService(new InMemoryPersistenceBackend());
    ensureInstrumentLinkPersistence(service);
    ensureInstrumentLinkPersistence(service);
    const store = getInstrumentLinkStore(service);
    await store.ready;
    await Promise.resolve();
    let sets = 0;
    const unsubscribe = store.subscribe(({ reason }) => {
      if (reason === "set") sets++;
    });
    getInstrumentLinkBus().publish("red", { ric: "BARC.L" });
    unsubscribe();
    expect(sets).toBe(1);
  });
});

/** BroadcastChannel between "windows", delivering synchronously. */
const createHub = () => {
  const ports = new Set<BroadcastChannelLike & { emit(data: unknown): void }>();
  return () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    const port = {
      emit: (data: unknown) => {
        for (const l of listeners) l({ data } as MessageEvent);
      },
      postMessage(message: unknown) {
        const data = structuredClone(message);
        for (const other of ports) if (other !== port) other.emit(data);
      },
      addEventListener: (_: "message", l: (e: MessageEvent) => void) =>
        listeners.add(l),
      removeEventListener: (_: "message", l: (e: MessageEvent) => void) =>
        listeners.delete(l),
      close: () => ports.delete(port),
    };
    ports.add(port);
    return port;
  };
};

describe("instrument link persistence across windows", () => {
  test("a reloaded main window agrees with an open popout", async () => {
    const backend = new InMemoryPersistenceBackend();
    const channel = createHub();
    /** A window: its own bus and service, linked over BroadcastChannel. */
    const openWindow = async () => {
      const bus = createInstrumentLinkBus();
      const port = channel();
      connectBroadcastChannel(bus, { channel: port });
      const service = newService(backend);
      const store = getInstrumentLinkStore(service);
      const unbind = bindInstrumentLinkStore(bus, store);
      await store.ready;
      await Promise.resolve();
      return {
        bus,
        service,
        close: () => {
          unbind();
          port.close();
        },
      };
    };

    const main = await openWindow();
    const popout = await openWindow();
    main.bus.publish("red", { ric: "BARC.L" }, "grid");
    popout.bus.publish("red", { ric: "VOD.L" }, "ladder");
    expect(main.bus.getSelection("red")?.instrument?.ric).toBe("VOD.L");
    await flush(main.service);
    await flush(popout.service);

    // reload the main window while the popout stays open
    main.close();
    const reloaded = await openWindow();
    expect(reloaded.bus.getSelection("red")?.instrument?.ric).toBe("VOD.L");
    // and the reloaded window's next selection reaches the popout
    reloaded.bus.publish("red", { ric: "HSBA.L" }, "grid");
    expect(popout.bus.getSelection("red")?.instrument?.ric).toBe("HSBA.L");
    await flush(reloaded.service);
    expect(
      readSavedSelections(
        getInstrumentLinkStore(reloaded.service).get(LINK_SELECTIONS_KEY),
      ).map(([group, { instrument }]) => [group, instrument?.ric]),
    ).toEqual([["red", "HSBA.L"]]);
  });
});

describe("InstrumentLinkPersistence", () => {
  const ActiveChannel = () => {
    const { activeChannel, setActiveChannel } = useWorkspaceChannel();
    return (
      <button
        data-testid="active"
        onClick={() => setActiveChannel("blue")}
        type="button"
      >
        {activeChannel}
      </button>
    );
  };

  const Portal = ({
    children,
    service,
  }: {
    children: ReactNode;
    service: PortalPersistenceService;
  }) => (
    <WorkspaceChannelProvider>
      <PortalPersistenceProvider service={service}>
        <InstrumentLinkPersistence />
        {children}
      </PortalPersistenceProvider>
    </WorkspaceChannelProvider>
  );

  test("restores the active channel and the window bus after a reload", async () => {
    const backend = new InMemoryPersistenceBackend();
    const service = newService(backend);
    const first = render(
      <Portal service={service}>
        <ActiveChannel />
      </Portal>,
    );
    await act(() => getInstrumentLinkStore(service).ready);
    expect(first.getByTestId("active").textContent).toBe("red");
    act(() => first.getByTestId("active").click());
    act(() => {
      getInstrumentLinkBus().publish("blue", { ric: "BARC.L" }, "grid");
    });
    await flush(service);
    expect(getInstrumentLinkStore(service).get(ACTIVE_CHANNEL_STATE_KEY)).toBe(
      "blue",
    );
    first.unmount();

    // reload: a new window bus (new id) and service on the same backend
    resetInstrumentLinkPersistence();
    dropWindowBus();
    const reloaded = newService(backend);
    const second = render(
      <Portal service={reloaded}>
        <ActiveChannel />
      </Portal>,
    );
    await act(async () => {
      await getInstrumentLinkStore(reloaded).ready;
      await Promise.resolve();
    });
    expect(second.getByTestId("active").textContent).toBe("blue");
    expect(getInstrumentLinkBus().getSelection("blue")?.instrument?.ric).toBe(
      "BARC.L",
    );
  });

  test("does nothing outside a portal", () => {
    const { getByTestId } = render(
      <WorkspaceChannelProvider>
        <InstrumentLinkPersistence />
        <ActiveChannel />
      </WorkspaceChannelProvider>,
    );
    expect(getByTestId("active").textContent).toBe("red");
  });
});
