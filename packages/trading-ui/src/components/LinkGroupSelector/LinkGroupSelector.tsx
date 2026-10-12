import { Dropdown, Option } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import type { CSSProperties, SyntheticEvent } from "react";
import {
  DEFAULT_LINK_GROUPS,
  isUnlinkedGroup,
  type LinkGroupDefinition,
  type LinkGroupId,
  linkGroupDefinition,
  UNLINKED_GROUP,
} from "../../instrument-context/linkGroups";
import linkGroupSelectorCss from "./LinkGroupSelector.css";

const classBase = "tradingLinkGroupSelector";

export interface LinkGroupSelectorProps {
  /** The current group. */
  value: LinkGroupId;
  onChange: (linkGroup: LinkGroupId) => void;
  /** Groups to offer (default DEFAULT_LINK_GROUPS); `unlinked` is added. */
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

/** The colour dot of a link group (striped for unlinked). */
export const LinkGroupSwatch = ({
  group,
  groups,
}: {
  group: LinkGroupId;
  groups?: readonly LinkGroupDefinition[];
}) => {
  useLinkGroupCss();
  const { id, color } = linkGroupDefinition(group, groups);
  return (
    <span
      aria-hidden
      className={`${classBase}-swatch`}
      data-link-group={isUnlinkedGroup(id) ? "unlinked" : id}
      style={{ "--tradingLinkGroupSelector-color": color } as CSSProperties}
    />
  );
};

/**
 * A compact dropdown to pick a component's instrument link group (colour
 * swatch + name, so it does not rely on colour alone). For component
 * headers / toolbars; linkable components render one when
 * `showLinkGroupSelector` is set.
 */
export const LinkGroupSelector = ({
  allowUnlinked = true,
  "aria-label": ariaLabel = "Link group",
  className,
  disabled,
  groups = DEFAULT_LINK_GROUPS,
  onChange,
  value,
}: LinkGroupSelectorProps) => {
  useLinkGroupCss();
  const options = allowUnlinked ? [...groups, UNLINKED_GROUP] : groups;
  const current = linkGroupDefinition(value, groups);
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
};
