import type {
  ApplicationStateStore,
  JsonValue,
  PortalPersistenceService,
} from "@vuu-ui/core/portal";
import {
  getInstrumentLinkBus,
  type InstrumentLinkBus,
  type InstrumentLinkSelection,
} from "./instrumentLinkBus";
import { isUnlinkedGroup, type LinkGroupId } from "./linkGroups";
import { sanitizeSelectedInstrument } from "./selectedInstrument";

/**
 * The portal saved-state document that holds the instrument channels: the
 * instrument selected on each shared link group and the workspace's active
 * channel. It is listed as "Instrument channels" in the Saved state dialog.
 */
export const INSTRUMENT_LINK_STATE_KEY = "trading.instrument-link";
export const INSTRUMENT_LINK_STATE_VERSION = 1;
export const INSTRUMENT_LINK_STATE_TITLE = "Instrument channels";
/** Key of the per-group selections in that document. */
export const LINK_SELECTIONS_KEY = "selections";
/** Key of the workspace's active channel in that document. */
export const ACTIVE_CHANNEL_STATE_KEY = "activeChannel";

/** The part of ApplicationStateStore the binding uses (lets tests fake it). */
export type InstrumentLinkStateStore = Pick<
  ApplicationStateStore,
  "ready" | "get" | "set" | "subscribe"
>;

/** The document that holds the instrument channels in `service`. */
export const getInstrumentLinkStore = (
  service: PortalPersistenceService,
): ApplicationStateStore =>
  service.getStore(INSTRUMENT_LINK_STATE_KEY, INSTRUMENT_LINK_STATE_VERSION, {
    title: INSTRUMENT_LINK_STATE_TITLE,
  });

type SavedSelection = { instrument: JsonValue; seq: number; origin: string };

const serialize = (
  snapshot: [LinkGroupId, InstrumentLinkSelection][],
): Record<string, SavedSelection> => {
  const saved: Record<string, SavedSelection> = {};
  for (const [group, { instrument, seq, origin }] of snapshot) {
    if (!instrument || isUnlinkedGroup(group)) continue;
    saved[group] = {
      instrument: { ...instrument } as JsonValue,
      seq,
      origin,
    };
  }
  return saved;
};

/** The saved selections, dropping anything malformed. */
export const readSavedSelections = (
  value: unknown,
): [LinkGroupId, InstrumentLinkSelection][] => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [];
  const result: [LinkGroupId, InstrumentLinkSelection][] = [];
  for (const [group, entry] of Object.entries(value)) {
    if (!group || isUnlinkedGroup(group)) continue;
    if (entry === null || typeof entry !== "object") continue;
    const { instrument, seq, origin } = entry as Record<string, unknown>;
    const selected = sanitizeSelectedInstrument(instrument);
    if (!selected) continue;
    result.push([
      group,
      {
        instrument: selected,
        source: undefined,
        seq: typeof seq === "number" && Number.isFinite(seq) ? seq : 0,
        origin: typeof origin === "string" ? origin : "",
      },
    ]);
  }
  return result;
};

/**
 * Keep the selections of the bus's shared link groups in `store`, so they
 * survive a reload. Once the store is loaded, saved selections fill the
 * groups that have none yet (a popout that already synced over
 * BroadcastChannel keeps what it got). Every later change is saved; changes
 * saved by another window are applied last-writer-wins (by seq), like
 * BroadcastChannel messages. Clearing the document in the Saved state
 * dialog clears the selections. Returns unbind.
 */
export const bindInstrumentLinkStore = (
  bus: InstrumentLinkBus,
  store: InstrumentLinkStateStore,
): (() => void) => {
  let ready = false;
  let bound = true;
  let clearing = false;

  const restore = (onlyEmpty: boolean) => {
    for (const [group, selection] of readSavedSelections(
      store.get(LINK_SELECTIONS_KEY),
    )) {
      if (onlyEmpty && bus.getSelection(group)?.instrument) continue;
      bus.receive(group, selection);
    }
  };

  const save = () => {
    if (!ready || !bound || clearing) return;
    const next = serialize(bus.snapshot());
    const current = store.get(LINK_SELECTIONS_KEY);
    if (JSON.stringify(current ?? {}) === JSON.stringify(next)) return;
    try {
      store.set(LINK_SELECTIONS_KEY, next);
    } catch (err) {
      // a disposed service (sign-out): selections are no longer saved
      console.warn("[instrument-link] unable to save selections", err);
    }
  };

  const unsubscribeBus = bus.subscribeAll(save);
  const unsubscribeStore = store.subscribe(({ keys, reason }) => {
    if (!ready || !keys.includes(LINK_SELECTIONS_KEY)) return;
    if (reason === "external") {
      restore(false);
    } else if (reason === "clear" || reason === "remove") {
      clearing = true;
      try {
        for (const [group] of bus.snapshot()) bus.publish(group, undefined);
      } finally {
        clearing = false;
      }
    }
  });

  store.ready.then(
    () => {
      if (!bound) return;
      restore(true);
      ready = true;
      save();
    },
    () => undefined,
  );

  return () => {
    bound = false;
    unsubscribeBus();
    unsubscribeStore();
  };
};

const PERSISTENCE_KEY = Symbol.for(
  "@heswell/trading-ui/instrument-link-persistence",
);

type PersistenceBinding = {
  service: PortalPersistenceService;
  unbind: () => void;
};

/**
 * Save the window's link bus in the portal's persistence service, once per
 * window however many features call it (as ensureLinkBusBroadcast does for
 * BroadcastChannel). A new service (another user) replaces the binding.
 */
export const ensureInstrumentLinkPersistence = (
  service: PortalPersistenceService,
  bus: InstrumentLinkBus = getInstrumentLinkBus(),
) => {
  const g = globalThis as unknown as Record<
    symbol,
    PersistenceBinding | undefined
  >;
  const current = g[PERSISTENCE_KEY];
  if (current?.service === service) return;
  current?.unbind();
  g[PERSISTENCE_KEY] = undefined;
  if (service.isDisposed()) return;
  const release = service.markOpen(
    INSTRUMENT_LINK_STATE_KEY,
    INSTRUMENT_LINK_STATE_VERSION,
  );
  const unbind = bindInstrumentLinkStore(bus, getInstrumentLinkStore(service));
  g[PERSISTENCE_KEY] = {
    service,
    unbind: () => {
      unbind();
      release();
    },
  };
};

/** Remove the window's binding (tests). */
export const resetInstrumentLinkPersistence = () => {
  const g = globalThis as unknown as Record<
    symbol,
    PersistenceBinding | undefined
  >;
  g[PERSISTENCE_KEY]?.unbind();
  g[PERSISTENCE_KEY] = undefined;
};
