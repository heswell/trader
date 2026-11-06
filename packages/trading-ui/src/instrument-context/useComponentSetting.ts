import { usePersistedState } from "@vuu-ui/core/portal";
import { useViewContext } from "@vuu-ui/vuu-layout";
import { useCallback, useRef, useState } from "react";
import { useWorkspaceItemState } from "./workspaceItemState";

/** Prefix of the key in portal persisted state (`trading.<key>.<persistKey>`). */
const settingKey = (key: string, persistKey: string) =>
  `trading.${key}.${persistKey}`;

const parse = <T>(saved: unknown, defaultValue: T): T => {
  let value = saved;
  if (typeof saved === "string" && typeof defaultValue !== "string") {
    try {
      value = JSON.parse(saved);
    } catch {
      return defaultValue;
    }
  }
  return typeof value === typeof defaultValue ? (value as T) : defaultValue;
};

/**
 * A small per-component UI setting (e.g. a toggle) saved with the layout,
 * in the same places as the link group (see useComponentLinkGroup): the
 * portal workspace item, the enclosing vuu-layout View, or the portal's
 * persisted state when `persistKey` is given. Not saved otherwise.
 */
export const useComponentSetting = <T extends string | number | boolean>(
  key: string,
  defaultValue: T,
  { persistKey }: { persistKey?: string } = {},
): [T, (value: T) => void] => {
  const view = useViewContext();
  const persisted = usePersistedState();
  const workspaceItem = useWorkspaceItemState();
  const inView =
    typeof view?.save === "function" && typeof view?.load === "function";
  const portalKey = persistKey ? settingKey(key, persistKey) : undefined;
  const inWorkspace = workspaceItem !== undefined && portalKey !== undefined;

  const [value, setValue] = useState<T>(() => {
    try {
      const saved = inWorkspace
        ? workspaceItem?.load(portalKey as string)
        : inView
          ? view.load?.(key)
          : portalKey
            ? persisted.load(portalKey)
            : undefined;
      return saved === undefined || saved === null
        ? defaultValue
        : parse(saved, defaultValue);
    } catch {
      return defaultValue;
    }
  });

  const stores = useRef({
    inView,
    inWorkspace,
    view,
    persisted,
    portalKey,
    workspaceItem,
  });
  stores.current = {
    inView,
    inWorkspace,
    view,
    persisted,
    portalKey,
    workspaceItem,
  };

  const save = useCallback(
    (next: T) => {
      setValue(next);
      const { inView, inWorkspace, view, persisted, portalKey, workspaceItem } =
        stores.current;
      if (inWorkspace && portalKey) {
        workspaceItem?.save(portalKey, JSON.stringify(next));
      } else if (inView) view.save?.(next, key);
      else if (portalKey) persisted.save(next, portalKey);
    },
    [key],
  );
  return [value, save];
};
