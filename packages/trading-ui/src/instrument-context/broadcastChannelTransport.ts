import type {
  InstrumentLinkBus,
  InstrumentLinkSelection,
} from "./instrumentLinkBus";
import { INSTRUMENT_LINK_BUS_VERSION } from "./instrumentLinkBus";

export const DEFAULT_LINK_CHANNEL_NAME = "heswell-trading-instrument-link";

type LinkMessage =
  | {
      protocol: number;
      type: "select";
      group: string;
      selection: InstrumentLinkSelection;
    }
  | { protocol: number; type: "sync"; origin: string };

/** The part of BroadcastChannel we use (lets tests inject a fake). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export interface ConnectBroadcastChannelOptions {
  /** Channel name (default "heswell-trading-instrument-link"). */
  name?: string;
  /** Use this channel instead of `new BroadcastChannel(name)`. */
  channel?: BroadcastChannelLike;
}

const isLinkMessage = (data: unknown): data is LinkMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as LinkMessage).protocol === INSTRUMENT_LINK_BUS_VERSION &&
  ((data as LinkMessage).type === "select" ||
    (data as LinkMessage).type === "sync");

/**
 * Link the bus with the same-named bus of other windows / tabs of the same
 * origin (popouts, multi-monitor). Local selections of shared groups are
 * posted; received ones are applied last-writer-wins and never re-posted,
 * so there are no loops. A new window asks for the current selections.
 * Returns disconnect. A no-op where BroadcastChannel is unavailable.
 */
export const connectBroadcastChannel = (
  bus: InstrumentLinkBus,
  {
    name = DEFAULT_LINK_CHANNEL_NAME,
    channel,
  }: ConnectBroadcastChannelOptions = {},
): (() => void) => {
  const port: BroadcastChannelLike | undefined =
    channel ??
    (typeof BroadcastChannel === "function"
      ? new BroadcastChannel(name)
      : undefined);
  if (!port) return () => undefined;

  const post = (message: LinkMessage) => {
    try {
      port.postMessage(message);
    } catch {
      // closed channel / uncloneable: drop
    }
  };
  const sendSelection = (group: string, selection: InstrumentLinkSelection) =>
    post({
      protocol: INSTRUMENT_LINK_BUS_VERSION,
      type: "select",
      group,
      selection,
    });

  const onMessage = ({ data }: MessageEvent) => {
    if (!isLinkMessage(data)) return;
    if (data.type === "select") {
      bus.receive(data.group, data.selection);
    } else if (data.origin !== bus.id) {
      for (const [group, selection] of bus.snapshot()) {
        sendSelection(group, selection);
      }
    }
  };

  port.addEventListener("message", onMessage);
  const removeTransport = bus.addTransport(sendSelection);
  post({ protocol: INSTRUMENT_LINK_BUS_VERSION, type: "sync", origin: bus.id });

  return () => {
    removeTransport();
    port.removeEventListener("message", onMessage);
    if (!channel) port.close();
  };
};
