import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";

/**
 * Where components persist per-user settings (watchlists, layouts, ...).
 *
 * The shape is deliberately a subset of the Web Storage API, so
 * `window.localStorage` is a valid implementation, but values may also be
 * returned asynchronously. A host with a real user-settings backend (for
 * example vuu-portal's user settings service) supplies its own implementation:
 *
 * ```ts
 * const portalSettings: UserSettingsStorage = {
 *   getItem: (key) => settingsApi.get(`trading/${key}`),   // Promise<string | null>
 *   setItem: (key, value) => settingsApi.put(`trading/${key}`, value),
 *   removeItem: (key) => settingsApi.delete(`trading/${key}`),
 * };
 * <UserSettingsProvider storage={portalSettings}>...</UserSettingsProvider>
 * ```
 *
 * Values are JSON strings; keys are namespaced by the component, e.g.
 * `trading.watchlists`.
 */
export interface UserSettingsStorage {
  getItem(
    key: string,
  ): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

/** Non-persistent storage, for tests and as the fallback when there is no localStorage. */
export const createMemorySettingsStorage = (
  initial: Record<string, string> = {},
): UserSettingsStorage => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

/** `window.localStorage` (wrapped so a blocked / absent store never throws), else memory. */
export const createLocalSettingsStorage = (): UserSettingsStorage => {
  const fallback = createMemorySettingsStorage();
  const store = (): Storage | undefined => {
    try {
      return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    getItem: (key) => {
      try {
        return store() ? store()?.getItem(key) : fallback.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        if (store()) store()?.setItem(key, value);
        else fallback.setItem(key, value);
      } catch {
        // quota / privacy mode: settings simply are not persisted
      }
    },
    removeItem: (key) => {
      try {
        if (store()) store()?.removeItem(key);
        else fallback.removeItem?.(key);
      } catch {
        // ignore
      }
    },
  };
};

const UserSettingsContext = createContext<UserSettingsStorage | undefined>(
  undefined,
);

export interface UserSettingsProviderProps {
  storage: UserSettingsStorage;
  children?: ReactNode;
}

/** Overrides the default (localStorage) settings storage for descendants. */
export const UserSettingsProvider = ({
  storage,
  children,
}: UserSettingsProviderProps) =>
  createElement(UserSettingsContext.Provider, { value: storage }, children);

let defaultStorage: UserSettingsStorage | undefined;

/** Nearest `UserSettingsProvider` storage, else localStorage. */
export const useUserSettingsStorage = (): UserSettingsStorage => {
  const provided = useContext(UserSettingsContext);
  return useMemo(() => {
    defaultStorage ??= createLocalSettingsStorage();
    return provided ?? defaultStorage;
  }, [provided]);
};
