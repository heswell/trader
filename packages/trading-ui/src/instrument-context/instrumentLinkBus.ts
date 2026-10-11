import { isUnlinkedGroup, type LinkGroupId, UNLINKED } from "./linkGroups";
import {
  type SelectedInstrument,
  sameInstrument,
  sanitizeSelectedInstrument,
} from "./selectedInstrument";

/** The current selection of one link group. */
export interface InstrumentLinkSelection {
  readonly instrument: SelectedInstrument | undefined;
  /**
   * Id of the component that made the selection, so a component can ignore
   * its own echoes (source tagging).
   */
  readonly source: string | undefined;
  /** Logical (Lamport) clock: orders selections across buses / windows. */
  readonly seq: number;
  /** Id of the bus (window / MF copy) where the selection was made. */
  readonly origin: string;
}

export type InstrumentLinkListener = (
  selection: InstrumentLinkSelection,
  group: LinkGroupId,
) => void;

/** Sends a local selection to other buses (see connectBroadcastChannel). */
export type InstrumentLinkTransport = (
  group: LinkGroupId,
  selection: InstrumentLinkSelection,
) => void;

/**
 * A framework-free pub/sub of the selected instrument per link group.
 * One instance is shared by everything in a window (getInstrumentLinkBus),
 * so separately mounted MF features that do not share a React tree still
 * link; transports (BroadcastChannel) extend it to other windows.
 */
export interface InstrumentLinkBus {
  /** Unique per bus instance; the `origin` of its own selections. */
  readonly id: string;
  /** Protocol version of this bus (see INSTRUMENT_LINK_BUS_VERSION). */
  readonly version: number;
  getSelection(group: LinkGroupId): InstrumentLinkSelection | undefined;
  /**
   * Select `instrument` (or clear with undefined) in `group`. The value is
   * reduced to plain SelectedInstrument fields. Returns false (and notifies
   * nobody) when nothing changes: the same ric with no new static data, a
   * missing / blank ric, or the bare `unlinked` group.
   */
  publish(
    group: LinkGroupId,
    instrument: SelectedInstrument | undefined,
    source?: string,
  ): boolean;
  /** Listen to one group. Returns unsubscribe. */
  subscribe(group: LinkGroupId, listener: InstrumentLinkListener): () => void;
  /** Listen to every group (bridges, logging). Returns unsubscribe. */
  subscribeAll(listener: InstrumentLinkListener): () => void;
  /**
   * Apply a selection made on another bus. Ignored if it is our own, older
   * than the current one (last writer wins by seq, then origin) or private.
   */
  receive(group: LinkGroupId, selection: InstrumentLinkSelection): boolean;
  /** Current selections of the shared (not private) groups. */
  snapshot(): [LinkGroupId, InstrumentLinkSelection][];
  /** Forward local selections of shared groups. Returns remove. */
  addTransport(transport: InstrumentLinkTransport): () => void;
  /** Forget all selections (no notification). For tests / sign-out. */
  clear(): void;
}

/** Bumped on any incompatible change of InstrumentLinkBus / messages. */
export const INSTRUMENT_LINK_BUS_VERSION = 1;

const randomId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const isNewer = (
  next: InstrumentLinkSelection,
  current: InstrumentLinkSelection | undefined,
) =>
  !current ||
  next.seq > current.seq ||
  (next.seq === current.seq && next.origin > current.origin);

const report = (err: unknown) =>
  queueMicrotask(() => {
    throw err;
  });

export interface CreateInstrumentLinkBusOptions {
  id?: string;
}

/**
 * A new, independent bus. Most code wants the shared one
 * (getInstrumentLinkBus); separate buses are for tests and for an isolated
 * InstrumentContextProvider.
 */
export const createInstrumentLinkBus = ({
  id = randomId(),
}: CreateInstrumentLinkBusOptions = {}): InstrumentLinkBus => {
  const selections = new Map<LinkGroupId, InstrumentLinkSelection>();
  const listeners = new Map<LinkGroupId, Set<InstrumentLinkListener>>();
  const allListeners = new Set<InstrumentLinkListener>();
  const transports = new Set<InstrumentLinkTransport>();
  let clock = 0;

  const notify = (group: LinkGroupId, selection: InstrumentLinkSelection) => {
    for (const listener of [...(listeners.get(group) ?? []), ...allListeners]) {
      try {
        listener(selection, group);
      } catch (err) {
        report(err);
      }
    }
  };

  const bus: InstrumentLinkBus = {
    id,
    version: INSTRUMENT_LINK_BUS_VERSION,
    getSelection: (group) => selections.get(group),

    publish(group, instrument, source) {
      if (!group || group === UNLINKED) return false;
      let next = sanitizeSelectedInstrument(instrument);
      if (instrument !== undefined && !next) return false;
      const current = selections.get(group)?.instrument;
      if (next && current?.ric === next.ric) {
        next = { ...current, ...next };
        if (sameInstrument(next, current)) return false;
      } else if (!next && !current) {
        return false;
      }
      const selection: InstrumentLinkSelection = {
        instrument: next,
        source,
        seq: ++clock,
        origin: id,
      };
      selections.set(group, selection);
      notify(group, selection);
      if (!isUnlinkedGroup(group)) {
        for (const transport of transports) {
          try {
            transport(group, selection);
          } catch (err) {
            report(err);
          }
        }
      }
      return true;
    },

    receive(group, selection) {
      if (!group || isUnlinkedGroup(group) || selection.origin === id)
        return false;
      clock = Math.max(clock, selection.seq);
      const current = selections.get(group);
      if (!isNewer(selection, current)) return false;
      const instrument = sanitizeSelectedInstrument(selection.instrument);
      if (selection.instrument !== undefined && !instrument) return false;
      const next: InstrumentLinkSelection = {
        instrument,
        source:
          typeof selection.source === "string" ? selection.source : undefined,
        seq: selection.seq,
        origin: String(selection.origin),
      };
      selections.set(group, next);
      if (!sameInstrument(instrument, current?.instrument)) notify(group, next);
      return true;
    },

    subscribe(group, listener) {
      let set = listeners.get(group);
      if (!set) {
        set = new Set();
        listeners.set(group, set);
      }
      set.add(listener);
      return () => {
        const groupListeners = listeners.get(group);
        groupListeners?.delete(listener);
        if (groupListeners?.size === 0) {
          listeners.delete(group);
          // Private groups live as long as their component.
          if (isUnlinkedGroup(group)) selections.delete(group);
        }
      };
    },

    subscribeAll(listener) {
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
      };
    },

    snapshot: () =>
      [...selections].filter(([group]) => !isUnlinkedGroup(group)),

    addTransport(transport) {
      transports.add(transport);
      return () => {
        transports.delete(transport);
      };
    },

    clear() {
      selections.clear();
    },
  };
  return bus;
};

const GLOBAL_KEY = Symbol.for(
  `@heswell/trading-ui/instrument-link-bus/v${INSTRUMENT_LINK_BUS_VERSION}`,
);

type GlobalWithBus = typeof globalThis & {
  [GLOBAL_KEY]?: InstrumentLinkBus;
};

/**
 * The bus shared by every component in this window (JS realm). It is kept
 * on `globalThis` under a versioned `Symbol.for` key, so all copies of
 * trading-ui loaded in the page (e.g. MF features that did not share the
 * package) use the same instance.
 */
export const getInstrumentLinkBus = (): InstrumentLinkBus => {
  const g = globalThis as GlobalWithBus;
  let bus = g[GLOBAL_KEY];
  if (!bus) {
    bus = createInstrumentLinkBus();
    g[GLOBAL_KEY] = bus;
  }
  return bus;
};
