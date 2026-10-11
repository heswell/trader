import type { SelectRequest } from "@vuu-ui/vuu-protocol-types";
import type { SelectionChangeHandler } from "@vuu-ui/vuu-table-types";
import { useCallback, useMemo, useState } from "react";

type WithoutVpId<T> = T extends unknown ? Omit<T, "vpId"> : never;
type SelectionChange = WithoutVpId<SelectRequest>;

/**
 * Apply a vuu Table selection request to a set of selected row keys.
 * `orderedKeys` are the keys currently in the grid in display order, used
 * to expand range selections (shift-click).
 */
export const applySelectionChange = (
  selected: ReadonlySet<string>,
  change: SelectionChange,
  orderedKeys: readonly string[],
): ReadonlySet<string> => {
  const next = new Set(selected);
  switch (change.type) {
    case "SELECT_ROW":
      if (!change.preserveExistingSelection) next.clear();
      next.add(change.rowKey);
      return next;
    case "DESELECT_ROW":
      next.delete(change.rowKey);
      return next;
    case "SELECT_ROW_RANGE": {
      if (!change.preserveExistingSelection) next.clear();
      const a = orderedKeys.indexOf(change.fromRowKey);
      const b = orderedKeys.indexOf(change.toRowKey);
      if (a === -1 || b === -1) {
        next.add(change.fromRowKey);
        next.add(change.toRowKey);
      } else {
        for (const key of orderedKeys.slice(
          Math.min(a, b),
          Math.max(a, b) + 1,
        )) {
          next.add(key);
        }
      }
      return next;
    }
    case "SELECT_ALL":
      return new Set(orderedKeys);
    case "DESELECT_ALL":
      return new Set();
    default:
      return selected;
  }
};

/**
 * Track which row keys a vuu Table has selected. The Table reports selection
 * as requests (`onSelectionChange`), not row sets; this folds them into a Set
 * of keys. Pass the Table's `onSelectionChange`. `orderedKeys` is only needed
 * for range / select-all.
 */
export const useTableSelectedKeys = (orderedKeys: readonly string[]) => {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onSelectionChange = useCallback<SelectionChangeHandler>(
    (change) =>
      setSelectedKeys((selected) =>
        applySelectionChange(selected, change as SelectionChange, orderedKeys),
      ),
    [orderedKeys],
  );
  const clear = useCallback(() => setSelectedKeys(new Set()), []);
  return useMemo(
    () => ({ selectedKeys, onSelectionChange, clear }),
    [selectedKeys, onSelectionChange, clear],
  );
};
