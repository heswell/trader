import { useCallback, useEffect, useRef, useState } from "react";
import {
  type UserSettingsStorage,
  useUserSettingsStorage,
} from "../../utils/userSettingsStorage";

export interface Watchlist {
  id: string;
  name: string;
  rics: string[];
}

export interface WatchlistState {
  lists: Watchlist[];
}

export const WATCHLISTS_SETTINGS_KEY = "trading.watchlists";

export const EMPTY_WATCHLISTS: WatchlistState = { lists: [] };

const newId = (name: string, existing: Watchlist[]) => {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "list";
  let id = base;
  for (let n = 2; existing.some((list) => list.id === id); n++) {
    id = `${base}-${n}`;
  }
  return id;
};

/** Defensive parse: persisted settings can come from any version / host. */
export const parseWatchlists = (json: string | null | undefined) => {
  if (!json) return EMPTY_WATCHLISTS;
  try {
    const parsed = JSON.parse(json) as Partial<WatchlistState>;
    if (!Array.isArray(parsed.lists)) return EMPTY_WATCHLISTS;
    const lists: Watchlist[] = [];
    for (const list of parsed.lists) {
      if (
        list &&
        typeof list.id === "string" &&
        typeof list.name === "string" &&
        Array.isArray(list.rics)
      ) {
        lists.push({
          id: list.id,
          name: list.name,
          rics: [...new Set(list.rics.filter((r) => typeof r === "string"))],
        });
      }
    }
    return { lists };
  } catch {
    return EMPTY_WATCHLISTS;
  }
};

/**
 * Adds a watchlist named `name` (with optional initial rics); returns the new
 * state and the new list's id.
 */
export const createWatchlist = (
  state: WatchlistState,
  name: string,
  rics: string[] = [],
): { state: WatchlistState; id: string } => {
  const id = newId(name, state.lists);
  return {
    id,
    state: {
      lists: [
        ...state.lists,
        { id, name: name.trim() || "Watchlist", rics: [...new Set(rics)] },
      ],
    },
  };
};

/** Removes a watchlist. */
export const deleteWatchlist = (
  state: WatchlistState,
  id: string,
): WatchlistState => ({ lists: state.lists.filter((l) => l.id !== id) });

/** Renames a watchlist (a blank name keeps the old one). */
export const renameWatchlist = (
  state: WatchlistState,
  id: string,
  name: string,
): WatchlistState => ({
  lists: state.lists.map((l) =>
    l.id === id ? { ...l, name: name.trim() || l.name } : l,
  ),
});

/** Adds a ric to a watchlist (no-op if already there). */
export const addToWatchlist = (
  state: WatchlistState,
  id: string,
  ric: string,
): WatchlistState => ({
  lists: state.lists.map((l) =>
    l.id === id && !l.rics.includes(ric) ? { ...l, rics: [...l.rics, ric] } : l,
  ),
});

/** Removes a ric from a watchlist. */
export const removeFromWatchlist = (
  state: WatchlistState,
  id: string,
  ric: string,
): WatchlistState => ({
  lists: state.lists.map((l) =>
    l.id === id ? { ...l, rics: l.rics.filter((r) => r !== ric) } : l,
  ),
});

export interface UseWatchlistsResult {
  lists: Watchlist[];
  /** False until the (possibly asynchronous) stored value has been read. */
  loaded: boolean;
  create: (name: string, rics?: string[]) => string;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  add: (id: string, ric: string) => void;
  removeRic: (id: string, ric: string) => void;
}

/**
 * Named client-side lists of rics, persisted through a `UserSettingsStorage`
 * (the nearest `UserSettingsProvider`, localStorage by default).
 * Pass `storage` to override per component.
 */
export const useWatchlists = (
  storage?: UserSettingsStorage,
  settingsKey = WATCHLISTS_SETTINGS_KEY,
): UseWatchlistsResult => {
  const contextStorage = useUserSettingsStorage();
  const store = storage ?? contextStorage;
  const [state, setState] = useState<WatchlistState>(EMPTY_WATCHLISTS);
  const [loaded, setLoaded] = useState(false);
  const stateRef = useRef(state);
  const changed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    changed.current = false;
    Promise.resolve(store.getItem(settingsKey))
      .catch(() => null)
      .then((json) => {
        if (cancelled || changed.current) return;
        stateRef.current = parseWatchlists(json);
        setState(stateRef.current);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store, settingsKey]);

  const update = useCallback(
    (fn: (current: WatchlistState) => WatchlistState) => {
      changed.current = true;
      const next = fn(stateRef.current);
      stateRef.current = next;
      setState(next);
      setLoaded(true);
      try {
        void Promise.resolve(
          store.setItem(settingsKey, JSON.stringify(next)),
        ).catch(() => undefined);
      } catch {
        // storage unavailable: lists stay in memory for this session
      }
    },
    [store, settingsKey],
  );

  const create = useCallback(
    (name: string, rics?: string[]) => {
      let id = "";
      update((current) => {
        const result = createWatchlist(current, name, rics);
        id = result.id;
        return result.state;
      });
      return id;
    },
    [update],
  );

  return {
    lists: state.lists,
    loaded,
    create,
    remove: useCallback(
      (id: string) => update((s) => deleteWatchlist(s, id)),
      [update],
    ),
    rename: useCallback(
      (id: string, name: string) => update((s) => renameWatchlist(s, id, name)),
      [update],
    ),
    add: useCallback(
      (id: string, ric: string) => update((s) => addToWatchlist(s, id, ric)),
      [update],
    ),
    removeRic: useCallback(
      (id: string, ric: string) =>
        update((s) => removeFromWatchlist(s, id, ric)),
      [update],
    ),
  };
};
