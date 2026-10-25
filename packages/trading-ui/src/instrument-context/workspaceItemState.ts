import {
  type ComponentPersistentStateV1,
  usePortalModuleInstanceId,
  useWorkspacePersistentStateStore,
  type WorkspacePersistentStateStore,
} from "@vuu-ui/core";
import { useMemo } from "react";

/**
 * Component type of the state a trading feature keeps for its workspace item.
 * The value is a map of keys (e.g. `trading.linkGroup.<id>`) to strings.
 */
export const WORKSPACE_ITEM_STATE_TYPE = "trading.feature-state";
export const WORKSPACE_ITEM_STATE_VERSION = 1;

export interface WorkspaceItemState {
  load: (key: string) => unknown;
  save: (key: string, value: string) => void;
}

const itemStateValue = (state: ComponentPersistentStateV1 | undefined) =>
  state?.componentType === WORKSPACE_ITEM_STATE_TYPE &&
  state.value !== null &&
  typeof state.value === "object" &&
  !Array.isArray(state.value)
    ? (state.value as Record<string, unknown>)
    : {};

// The hook reads a context on every render, and throws only outside a
// workspace: core has no optional variant (trader upstream issue 106).
const useOptionalWorkspaceStore = () => {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: called unconditionally; try only catches its missing-provider error
    return useWorkspacePersistentStateStore();
  } catch {
    // not in a portal workspace (a module page, or no portal at all)
    return undefined;
  }
};

/** Read / write one key of this item's state in a workspace store. */
export const workspaceItemState = (
  store: WorkspacePersistentStateStore,
  instanceId: string,
): WorkspaceItemState => ({
  load: (key) => itemStateValue(store.get(instanceId))[key],
  save: (key, value) =>
    store.update(instanceId, (current) => ({
      componentType: WORKSPACE_ITEM_STATE_TYPE,
      schemaVersion: WORKSPACE_ITEM_STATE_VERSION,
      value: {
        ...(itemStateValue(current) as Record<string, string>),
        [key]: value,
      },
    })),
});

/**
 * State of the portal workspace item this feature renders in: saved with the
 * workspace, so a personal copy of a system workspace keeps it, Reset to
 * default discards it, and removing the item purges it. Undefined outside a
 * workspace item (e.g. on the module's own page).
 */
export const useWorkspaceItemState = (): WorkspaceItemState | undefined => {
  const instanceId = usePortalModuleInstanceId();
  const store = useOptionalWorkspaceStore();
  return useMemo(
    () =>
      store && instanceId ? workspaceItemState(store, instanceId) : undefined,
    [instanceId, store],
  );
};
