/**
 * Instrument link groups ("channels"): components in the same group follow
 * each other's instrument selection, like the coloured link groups of
 * Bloomberg / Eikon. `unlinked` components keep a private selection.
 */
export type LinkGroupId = string;

export interface LinkGroupDefinition {
  id: LinkGroupId;
  /** Accessible name, shown next to the colour swatch. */
  label: string;
  /** Swatch colour (any CSS colour). */
  color: string;
}

/** A component in this group does not publish or follow selections. */
export const UNLINKED: LinkGroupId = "unlinked";

/** The groups offered by LinkGroupSelector (in this order, after unlinked). */
export const DEFAULT_LINK_GROUPS: readonly LinkGroupDefinition[] =
  Object.freeze([
    {
      id: "red",
      label: "Red",
      color: "var(--salt-categorical-6-background, #d6493d)",
    },
    {
      id: "green",
      label: "Green",
      color: "var(--salt-categorical-3-background, #3a9c56)",
    },
    {
      id: "blue",
      label: "Blue",
      color: "var(--salt-categorical-1-background, #2670c8)",
    },
    {
      id: "yellow",
      label: "Yellow",
      color: "var(--salt-categorical-5-background, #d9a400)",
    },
  ]);

export const UNLINKED_GROUP: LinkGroupDefinition = Object.freeze({
  id: UNLINKED,
  label: "Unlinked",
  color: "transparent",
});

/**
 * Group of a component with no `linkGroup` prop (and no enclosing
 * LinkGroupProvider / InstrumentContextProvider group). Everything is linked
 * by default, as with the single selection of earlier versions.
 */
export const DEFAULT_LINK_GROUP: LinkGroupId = "red";

/** Private (per component instance) groups are `unlinked:<id>`. */
export const isUnlinkedGroup = (group: LinkGroupId | undefined) =>
  group === UNLINKED || (group?.startsWith(`${UNLINKED}:`) ?? false);

export const linkGroupDefinition = (
  group: LinkGroupId,
  groups: readonly LinkGroupDefinition[] = DEFAULT_LINK_GROUPS,
): LinkGroupDefinition =>
  isUnlinkedGroup(group)
    ? UNLINKED_GROUP
    : (groups.find((g) => g.id === group) ?? {
        id: group,
        label: group,
        color: "var(--salt-separable-primary-borderColor)",
      });
