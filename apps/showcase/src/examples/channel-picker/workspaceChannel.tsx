import {
  DEFAULT_LINK_GROUPS,
  type LinkGroupDefinition,
  type LinkGroupId,
} from "@heswell/trading-ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/** How many rics the search remembers for its "Recent" list. */
export const MAX_RECENT_RICS = 8;

export interface WorkspaceChannelContextValue {
  /** The channels offered by the picker, in display order. */
  channels: readonly LinkGroupDefinition[];
  /** The channel every bound component in the workspace follows. */
  activeChannel: LinkGroupId;
  setActiveChannel: (channel: LinkGroupId) => void;
  /** Rics picked recently (most recent first). */
  recentRics: readonly string[];
  addRecentRic: (ric: string) => void;
}

const WorkspaceChannelContext = createContext<
  WorkspaceChannelContextValue | undefined
>(undefined);

export interface WorkspaceChannelProviderProps {
  children: ReactNode;
  channels?: readonly LinkGroupDefinition[];
  /** Initial active channel (default: the first channel). */
  defaultActiveChannel?: LinkGroupId;
  /** Observe changes of the active channel (to persist it). */
  onActiveChannelChange?: (channel: LinkGroupId) => void;
}

/**
 * The workspace's active channel. Components bound to the workspace channel
 * follow it (`linkGroup={activeChannel}`); components pinned to a channel
 * pass that channel instead.
 */
export const WorkspaceChannelProvider = ({
  channels = DEFAULT_LINK_GROUPS,
  children,
  defaultActiveChannel,
  onActiveChannelChange,
}: WorkspaceChannelProviderProps) => {
  const [activeChannel, setActive] = useState<LinkGroupId>(
    defaultActiveChannel ?? channels[0]?.id ?? "red",
  );
  const [recentRics, setRecentRics] = useState<readonly string[]>([]);

  const setActiveChannel = useCallback(
    (channel: LinkGroupId) => {
      setActive((current) => {
        if (current !== channel) onActiveChannelChange?.(channel);
        return channel;
      });
    },
    [onActiveChannelChange],
  );

  const addRecentRic = useCallback((ric: string) => {
    setRecentRics((current) =>
      [ric, ...current.filter((r) => r !== ric)].slice(0, MAX_RECENT_RICS),
    );
  }, []);

  const value = useMemo(
    () => ({
      channels,
      activeChannel,
      setActiveChannel,
      recentRics,
      addRecentRic,
    }),
    [channels, activeChannel, setActiveChannel, recentRics, addRecentRic],
  );
  return (
    <WorkspaceChannelContext.Provider value={value}>
      {children}
    </WorkspaceChannelContext.Provider>
  );
};

/** The nearest WorkspaceChannelProvider (required). */
export const useWorkspaceChannel = (): WorkspaceChannelContextValue => {
  const value = useContext(WorkspaceChannelContext);
  if (!value) {
    throw new Error(
      "useWorkspaceChannel must be used inside a WorkspaceChannelProvider",
    );
  }
  return value;
};
