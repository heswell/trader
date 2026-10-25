import { usePersistedState } from "@vuu-ui/core/portal";
import { useViewContext } from "@vuu-ui/vuu-layout";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useInheritedLinkGroup } from "./InstrumentContext";
import { type LinkGroupId, UNLINKED } from "./linkGroups";
import { useWorkspaceItemState } from "./workspaceItemState";

/** Props every linkable component accepts. */
export interface LinkGroupProps {
  /**
   * Link group (channel) to join: e.g. "red", "green", or "unlinked".
   * The initial group when the user can change it (`showLinkGroupSelector`);
   * a later change of the prop is applied too. Default: the saved group,
   * then `defaultLinkGroup`, then the inherited group.
   */
  linkGroup?: LinkGroupId;
  /** Group used when there is no `linkGroup` prop and nothing saved. */
  defaultLinkGroup?: LinkGroupId;
  /** The user picked another group in the selector. */
  onLinkGroupChange?: (linkGroup: LinkGroupId) => void;
  /** Show a LinkGroupSelector in the component header / toolbar. */
  showLinkGroupSelector?: boolean;
}

/** Key the group is saved under in the vuu-layout View state. */
export const LINK_GROUP_STATE_KEY = "linkGroup";
/** Prefix of the key in portal persisted state (`trading.linkGroup.<key>`). */
export const LINK_GROUP_PERSIST_PREFIX = "trading.linkGroup.";

export interface ComponentLinkGroup {
  /** The group (`unlinked` for a private one). */
  linkGroup: LinkGroupId;
  /**
   * The bus channel to read / publish (a per-instance `unlinked:<id>` for
   * unlinked). Pass to useSelectedInstrument({ linkGroup: channel }).
   */
  channel: LinkGroupId;
  setLinkGroup: (linkGroup: LinkGroupId) => void;
}

export interface UseComponentLinkGroupOptions
  extends Pick<
    LinkGroupProps,
    "linkGroup" | "defaultLinkGroup" | "onLinkGroupChange"
  > {
  /**
   * Key for portal persisted state (one state document per remote module,
   * so it must be unique within the feature). Default: no portal
   * persistence. Inside a vuu-layout View, the View's own state is used.
   */
  persistKey?: string;
}

/**
 * The link group of one component instance. The user's choice is saved
 * with the layout: in a portal workspace item, the item's workspace
 * component state; in the enclosing vuu-layout View's state (restored as the
 * `linkGroup` prop); or, in a vuu-portal remote module page, its persisted
 * state.
 */
export const useComponentLinkGroup = ({
  defaultLinkGroup,
  linkGroup: linkGroupProp,
  onLinkGroupChange,
  persistKey,
}: UseComponentLinkGroupOptions = {}): ComponentLinkGroup => {
  const inherited = useInheritedLinkGroup();
  const view = useViewContext();
  const persisted = usePersistedState();
  const workspaceItem = useWorkspaceItemState();
  const inView =
    typeof view?.save === "function" && typeof view?.load === "function";
  const portalKey = persistKey
    ? `${LINK_GROUP_PERSIST_PREFIX}${persistKey}`
    : undefined;
  // In a portal workspace item, the group is saved with the workspace (per
  // item), so a personal copy keeps it and Reset to default discards it.
  const inWorkspace = workspaceItem !== undefined && portalKey !== undefined;

  const [linkGroup, setState] = useState<LinkGroupId>(() => {
    if (linkGroupProp) return linkGroupProp;
    let saved: unknown;
    try {
      saved = inWorkspace
        ? workspaceItem?.load(portalKey as string)
        : inView
          ? view.load?.(LINK_GROUP_STATE_KEY)
          : portalKey
            ? persisted.load(portalKey)
            : undefined;
    } catch {
      saved = undefined;
    }
    return typeof saved === "string" && saved
      ? saved
      : (defaultLinkGroup ?? inherited);
  });

  const previousProp = useRef(linkGroupProp);
  useEffect(() => {
    if (previousProp.current === linkGroupProp) return;
    previousProp.current = linkGroupProp;
    if (linkGroupProp) setState(linkGroupProp);
  }, [linkGroupProp]);

  const callbacks = useRef({
    onLinkGroupChange,
    view,
    persisted,
    inView,
    inWorkspace,
    portalKey,
    workspaceItem,
  });
  callbacks.current = {
    onLinkGroupChange,
    view,
    persisted,
    inView,
    inWorkspace,
    portalKey,
    workspaceItem,
  };

  const groupRef = useRef(linkGroup);
  groupRef.current = linkGroup;
  const setLinkGroup = useCallback((next: LinkGroupId) => {
    if (!next || groupRef.current === next) return;
    groupRef.current = next;
    const {
      inView,
      inWorkspace,
      view,
      persisted,
      portalKey,
      onLinkGroupChange,
      workspaceItem,
    } = callbacks.current;
    setState(next);
    if (inWorkspace && portalKey) workspaceItem?.save(portalKey, next);
    else if (inView) view.save?.(next, LINK_GROUP_STATE_KEY);
    else if (portalKey) persisted.save(next, portalKey);
    onLinkGroupChange?.(next);
  }, []);

  const privateId = useId();
  const channel =
    linkGroup === UNLINKED ? `${UNLINKED}:${privateId}` : linkGroup;
  return { linkGroup, channel, setLinkGroup };
};
