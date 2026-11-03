import { useOptionalPortalPersistence } from "@vuu-ui/core/portal";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVE_CHANNEL_STATE_KEY,
  ensureInstrumentLinkPersistence,
  getInstrumentLinkStore,
} from "./instrumentLinkPersistence";
import { useOptionalWorkspaceChannel } from "./workspaceChannel";

/**
 * Save the window's instrument link bus (the instrument on each channel) in
 * the enclosing portal's persistence service. A no-op outside a portal.
 * TradingFeatureRoot calls it, so every feature (and popout) is covered.
 */
export const useInstrumentLinkPersistence = () => {
  const service = useOptionalPortalPersistence();
  useEffect(() => {
    if (service) ensureInstrumentLinkPersistence(service);
  }, [service]);
};

/**
 * Save the enclosing WorkspaceChannelProvider's active channel in the
 * portal's persistence service, and restore it once the saved state is
 * loaded. Must be rendered inside the portal shell (where the service is)
 * and inside the WorkspaceChannelProvider. A no-op without either.
 */
export const useActiveChannelPersistence = () => {
  const service = useOptionalPortalPersistence();
  const workspace = useOptionalWorkspaceChannel();
  const store = useMemo(
    () =>
      service && !service.isDisposed()
        ? getInstrumentLinkStore(service)
        : undefined,
    [service],
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!store) return;
    let live = true;
    store.ready.then(
      () => {
        if (!live) return;
        const saved = store.get(ACTIVE_CHANNEL_STATE_KEY);
        const current = workspaceRef.current;
        if (
          typeof saved === "string" &&
          current?.channels.some(({ id }) => id === saved)
        ) {
          current.setActiveChannel(saved);
        }
        setRestored(true);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [store]);

  const activeChannel = workspace?.activeChannel;
  useEffect(() => {
    if (!restored || !store || !activeChannel) return;
    if (store.get(ACTIVE_CHANNEL_STATE_KEY) === activeChannel) return;
    try {
      store.set(ACTIVE_CHANNEL_STATE_KEY, activeChannel);
    } catch (err) {
      console.warn("[instrument-link] unable to save active channel", err);
    }
  }, [activeChannel, restored, store]);
};

/**
 * Keeps the instrument channels (each channel's instrument and the active
 * channel) in the portal's saved state. Render it once inside the portal
 * shell, within the WorkspaceChannelProvider; it renders nothing.
 */
export const InstrumentLinkPersistence = () => {
  useInstrumentLinkPersistence();
  useActiveChannelPersistence();
  return null;
};
