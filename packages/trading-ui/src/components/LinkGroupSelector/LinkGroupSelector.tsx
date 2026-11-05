import {
  Button,
  Dropdown,
  Menu,
  MenuItem,
  MenuPanel,
  MenuTrigger,
  Option,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import {
  GridLayoutHeaderContribution,
  useGridLayoutItem,
} from "@vuu-ui/grid-layout";
import cx from "clsx";
import { type CSSProperties, memo, type SyntheticEvent } from "react";
import {
  ACTIVE_GROUP,
  ACTIVE_LINK_GROUP,
  DEFAULT_LINK_GROUPS,
  isUnlinkedGroup,
  type LinkGroupDefinition,
  type LinkGroupId,
  linkGroupDefinition,
  UNLINKED_GROUP,
} from "../../instrument-context/linkGroups";
import { useOptionalWorkspaceChannel } from "../../instrument-context/workspaceChannel";
import linkGroupSelectorCss from "./LinkGroupSelector.css";

const classBase = "tradingLinkGroupSelector";

export interface LinkGroupSelectorProps {
  /** The current group. */
  value: LinkGroupId;
  onChange: (linkGroup: LinkGroupId) => void;
  /**
   * Groups to offer (default DEFAULT_LINK_GROUPS); `unlinked` is added, and
   * `active` first inside a WorkspaceChannelProvider.
   */
  groups?: readonly LinkGroupDefinition[];
  /** Offer `unlinked` (default true). */
  allowUnlinked?: boolean;
  className?: string;
  /** Accessible name (default "Link group"). */
  "aria-label"?: string;
  disabled?: boolean;
}

const useLinkGroupCss = () => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-link-group-selector",
    css: linkGroupSelectorCss,
    window: targetWindow,
  });
};

/**
 * The colour dot of a link group (striped for unlinked; for `active`, the
 * colour of the workspace's active channel, ringed).
 */
export const LinkGroupSwatch = ({
  group,
  groups,
}: {
  group: LinkGroupId;
  groups?: readonly LinkGroupDefinition[];
}) => {
  useLinkGroupCss();
  const workspace = useOptionalWorkspaceChannel();
  const { id, color } = linkGroupDefinition(group, groups);
  const swatchColor =
    id === ACTIVE_LINK_GROUP && workspace
      ? linkGroupDefinition(workspace.activeChannel, workspace.channels).color
      : color;
  return (
    <span
      aria-hidden
      className={`${classBase}-swatch`}
      data-link-group={isUnlinkedGroup(id) ? "unlinked" : id}
      style={
        { "--tradingLinkGroupSelector-color": swatchColor } as CSSProperties
      }
    />
  );
};

/**
 * The groups a selector offers for `value` and the current one's definition.
 * "Active channel" only where a workspace has one (or it is already set).
 */
const useLinkGroupOptions = (
  value: LinkGroupId,
  groups: readonly LinkGroupDefinition[],
  allowUnlinked: boolean,
) => {
  const offerActive =
    useOptionalWorkspaceChannel() !== undefined || value === ACTIVE_LINK_GROUP;
  const options = [
    ...(offerActive ? [ACTIVE_GROUP] : []),
    ...groups,
    ...(allowUnlinked ? [UNLINKED_GROUP] : []),
  ];
  return { current: linkGroupDefinition(value, groups), options };
};

/**
 * A compact dropdown to pick a component's instrument link group (colour
 * swatch + name, so it does not rely on colour alone). For component
 * headers / toolbars; linkable components render one when
 * `showLinkGroupSelector` is set. Memoized: it sits in the headers of
 * components that re-render on every tick, and a Salt Dropdown is costly.
 */
export const LinkGroupSelector = memo(function LinkGroupSelector({
  allowUnlinked = true,
  "aria-label": ariaLabel = "Link group",
  className,
  disabled,
  groups = DEFAULT_LINK_GROUPS,
  onChange,
  value,
}: LinkGroupSelectorProps) {
  useLinkGroupCss();
  const { current, options } = useLinkGroupOptions(
    value,
    groups,
    allowUnlinked,
  );
  return (
    <Dropdown<LinkGroupId>
      aria-label={ariaLabel}
      bordered
      className={cx(classBase, className)}
      data-link-group={current.id}
      disabled={disabled}
      onSelectionChange={(_e: SyntheticEvent, [selected]: LinkGroupId[]) => {
        if (selected) onChange(selected);
      }}
      selected={[current.id]}
      startAdornment={<LinkGroupSwatch group={current.id} groups={groups} />}
      title={`${ariaLabel}: ${current.label}`}
      value={current.label}
      variant="secondary"
    >
      {options.map((group) => (
        <Option key={group.id} value={group.id}>
          <span className={`${classBase}-option`}>
            <LinkGroupSwatch group={group.id} groups={groups} />
            {group.label}
          </span>
        </Option>
      ))}
    </Dropdown>
  );
});

/**
 * An icon-only LinkGroupSelector: a small button showing the group's swatch,
 * opening a menu of the groups. Its accessible name and tooltip carry the
 * group name (and, for `active`, the channel it follows), as the swatch
 * colour alone does not identify it. For panel title bars.
 */
export const LinkGroupMenuButton = memo(function LinkGroupMenuButton({
  allowUnlinked = true,
  "aria-label": ariaLabel = "Link group",
  className,
  disabled,
  groups = DEFAULT_LINK_GROUPS,
  onChange,
  value,
}: LinkGroupSelectorProps) {
  useLinkGroupCss();
  const workspace = useOptionalWorkspaceChannel();
  const { current, options } = useLinkGroupOptions(
    value,
    groups,
    allowUnlinked,
  );
  const name =
    current.id === ACTIVE_LINK_GROUP && workspace
      ? `${current.label} (${
          linkGroupDefinition(workspace.activeChannel, workspace.channels).label
        })`
      : current.label;
  return (
    <Menu>
      <MenuTrigger>
        <Button
          appearance="transparent"
          aria-label={`${ariaLabel}: ${name}`}
          className={cx(`${classBase}-menuButton`, className)}
          data-link-group={current.id}
          disabled={disabled}
          sentiment="neutral"
          title={`${ariaLabel}: ${name}`}
        >
          <LinkGroupSwatch group={current.id} groups={groups} />
        </Button>
      </MenuTrigger>
      <MenuPanel>
        {options.map((group) => (
          <MenuItem
            aria-current={group.id === current.id || undefined}
            className={`${classBase}-menuItem`}
            key={group.id}
            onClick={() => onChange(group.id)}
          >
            <span className={`${classBase}-option`}>
              <LinkGroupSwatch group={group.id} groups={groups} />
              {group.label}
            </span>
          </MenuItem>
        ))}
      </MenuPanel>
    </Menu>
  );
});

/**
 * The link group selector of a panel component. Hosted in a grid-layout
 * item (a portal workspace panel), it is a LinkGroupMenuButton in the
 * item's header, at the start (in a stack, the tab bar's start, while the
 * panel's tab is selected). Elsewhere it is an inline LinkGroupSelector.
 */
export const PanelLinkGroupSelector = (props: LinkGroupSelectorProps) =>
  useGridLayoutItem() ? (
    <GridLayoutHeaderContribution
      className={`${classBase}-headerContribution`}
      location="start"
    >
      <LinkGroupMenuButton {...props} />
    </GridLayoutHeaderContribution>
  ) : (
    <LinkGroupSelector {...props} />
  );
