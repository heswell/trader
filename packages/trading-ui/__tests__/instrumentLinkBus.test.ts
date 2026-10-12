import { describe, expect, test } from "bun:test";
import {
  type BroadcastChannelLike,
  connectBroadcastChannel,
  createInstrumentLinkBus,
  getInstrumentLinkBus,
  type InstrumentLinkSelection,
} from "../src";

describe("instrument link bus", () => {
  test("groups are isolated", () => {
    const bus = createInstrumentLinkBus();
    const red: string[] = [];
    const green: string[] = [];
    bus.subscribe("red", (s) => red.push(s.instrument?.ric ?? "-"));
    bus.subscribe("green", (s) => green.push(s.instrument?.ric ?? "-"));
    bus.publish("red", { ric: "VOD.L" }, "grid");
    bus.publish("green", { ric: "AAPL.OQ" }, "grid");
    bus.publish("red", undefined, "grid");
    expect(red).toEqual(["VOD.L", "-"]);
    expect(green).toEqual(["AAPL.OQ"]);
    expect(bus.getSelection("green")?.instrument?.ric).toBe("AAPL.OQ");
  });

  test("tags the source and ignores repeats of the same instrument", () => {
    const bus = createInstrumentLinkBus();
    const seen: InstrumentLinkSelection[] = [];
    bus.subscribe("red", (s) => seen.push(s));
    expect(bus.publish("red", { ric: "VOD.L" }, "grid")).toBe(true);
    // an echo from a follower changes nothing
    expect(bus.publish("red", { ric: "VOD.L" }, "ticket")).toBe(false);
    // new static data for the same ric is merged and published
    expect(bus.publish("red", { ric: "VOD.L", tickSize: 0.5 }, "picker")).toBe(
      true,
    );
    expect(seen.map((s) => s.source)).toEqual(["grid", "picker"]);
    expect(seen[1].instrument).toEqual({ ric: "VOD.L", tickSize: 0.5 });
  });

  test("rejects blank rics, the bare unlinked group and strips extra fields", () => {
    const bus = createInstrumentLinkBus();
    expect(bus.publish("red", { ric: "  " })).toBe(false);
    expect(bus.publish("unlinked", { ric: "VOD.L" })).toBe(false);
    bus.publish("red", {
      ric: "VOD.L",
      bid: 1,
      $key: "x",
    } as unknown as { ric: string });
    expect(bus.getSelection("red")?.instrument).toEqual({ ric: "VOD.L" });
  });

  test("private (unlinked:<id>) groups are not sent or snapshotted and die with their last listener", () => {
    const bus = createInstrumentLinkBus();
    const sent: string[] = [];
    bus.addTransport((group) => sent.push(group));
    const off = bus.subscribe("unlinked:a", () => undefined);
    bus.publish("unlinked:a", { ric: "VOD.L" });
    bus.publish("blue", { ric: "BP.L" });
    expect(sent).toEqual(["blue"]);
    expect(bus.snapshot().map(([g]) => g)).toEqual(["blue"]);
    off();
    expect(bus.getSelection("unlinked:a")).toBeUndefined();
  });

  test("receive is last-writer-wins and ignores its own origin", () => {
    const bus = createInstrumentLinkBus({ id: "b" });
    bus.publish("red", { ric: "VOD.L" }); // seq 1
    const stale = {
      instrument: { ric: "BP.L" },
      source: "x",
      seq: 0,
      origin: "a",
    };
    expect(bus.receive("red", stale)).toBe(false);
    expect(
      bus.receive("red", { ...stale, seq: 1, origin: "a" }), // tie, a < b
    ).toBe(false);
    expect(bus.receive("red", { ...stale, seq: 1, origin: "c" })).toBe(true);
    expect(bus.getSelection("red")?.instrument?.ric).toBe("BP.L");
    expect(bus.receive("red", { ...stale, seq: 9, origin: "b" })).toBe(false);
    // the clock moved on, so the next local publish wins elsewhere
    bus.publish("red", { ric: "VOD.L" });
    expect(bus.getSelection("red")?.seq).toBe(2);
  });

  test("a throwing listener does not stop the others; the error is rethrown async", () => {
    const bus = createInstrumentLinkBus();
    const seen: string[] = [];
    const queued: (() => void)[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb) => queued.push(cb);
    try {
      bus.subscribe("red", () => {
        throw new Error("boom");
      });
      bus.subscribe("red", (s) => seen.push(s.instrument?.ric ?? ""));
      bus.publish("red", { ric: "VOD.L" });
    } finally {
      globalThis.queueMicrotask = original;
    }
    expect(seen).toEqual(["VOD.L"]);
    expect(queued).toHaveLength(1);
    expect(() => queued[0]()).toThrow("boom");
  });

  test("getInstrumentLinkBus is one instance per realm, shared via globalThis", () => {
    const bus = getInstrumentLinkBus();
    expect(getInstrumentLinkBus()).toBe(bus);
    const key = Symbol.for("@heswell/trading-ui/instrument-link-bus/v1");
    // a second copy of the module (an MF feature that bundled trading-ui)
    // finds the same bus
    expect((globalThis as Record<symbol, unknown>)[key]).toBe(bus);
  });
});

class FakeHub {
  ports = new Set<FakePort>();
  create() {
    const port = new FakePort(this);
    this.ports.add(port);
    return port;
  }
}
class FakePort implements BroadcastChannelLike {
  listeners = new Set<(e: MessageEvent) => void>();
  closed = false;
  constructor(private hub: FakeHub) {}
  postMessage(message: unknown) {
    const data = structuredClone(message);
    for (const port of this.hub.ports) {
      if (port !== this && !port.closed)
        for (const l of port.listeners) l({ data } as MessageEvent);
    }
  }
  addEventListener(_: "message", l: (e: MessageEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_: "message", l: (e: MessageEvent) => void) {
    this.listeners.delete(l);
  }
  close() {
    this.closed = true;
  }
}

describe("BroadcastChannel transport", () => {
  test("links buses in other windows without loops", () => {
    const hub = new FakeHub();
    const a = createInstrumentLinkBus({ id: "a" });
    const b = createInstrumentLinkBus({ id: "b" });
    const portA = hub.create();
    const portB = hub.create();
    const posted: unknown[] = [];
    const post = portA.postMessage.bind(portA);
    portA.postMessage = (m) => {
      posted.push(m);
      post(m);
    };
    connectBroadcastChannel(a, { channel: portA });
    connectBroadcastChannel(b, { channel: portB });
    const seenB: string[] = [];
    b.subscribe("red", (s) => seenB.push(`${s.instrument?.ric}:${s.source}`));

    a.publish("red", { ric: "VOD.L" }, "grid");
    expect(seenB).toEqual(["VOD.L:grid"]);
    // b does not re-post what it received
    b.publish("red", { ric: "VOD.L" }, "ticket");
    expect(
      posted.filter((m) => (m as { type: string }).type === "select"),
    ).toHaveLength(1);

    b.publish("red", { ric: "BP.L" }, "picker");
    expect(a.getSelection("red")?.instrument?.ric).toBe("BP.L");
  });

  test("a new window is sent the current selections", () => {
    const hub = new FakeHub();
    const a = createInstrumentLinkBus({ id: "a" });
    connectBroadcastChannel(a, { channel: hub.create() });
    a.publish("green", { ric: "AAPL.OQ" });
    a.publish("unlinked:x", { ric: "MSFT.OQ" });

    const popout = createInstrumentLinkBus({ id: "p" });
    connectBroadcastChannel(popout, { channel: hub.create() });
    expect(popout.getSelection("green")?.instrument?.ric).toBe("AAPL.OQ");
    expect(popout.getSelection("unlinked:x")).toBeUndefined();
  });

  test("disconnect stops sending and receiving; garbage is ignored", () => {
    const hub = new FakeHub();
    const a = createInstrumentLinkBus({ id: "a" });
    const b = createInstrumentLinkBus({ id: "b" });
    const portA = hub.create();
    connectBroadcastChannel(a, { channel: portA });
    const disconnect = connectBroadcastChannel(b, { channel: hub.create() });
    portA.postMessage({ protocol: 99, type: "select", group: "red" });
    portA.postMessage("hello");
    expect(b.getSelection("red")).toBeUndefined();
    disconnect();
    a.publish("red", { ric: "VOD.L" });
    expect(b.getSelection("red")).toBeUndefined();
  });
});
