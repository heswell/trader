import { Menu, MenuGroup, MenuItem, MenuPanel } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type {
  ColumnDescriptor,
  TableCellRendererProps,
} from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import cx from "clsx";
import {
  createContext,
  type CSSProperties,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearChannel,
  linkInstrument,
} from "../../instrument-context/channelLinks";
import { useInstrumentLinkBus } from "../../instrument-context/InstrumentContext";
import {
  DEFAULT_LINK_GROUP,
  DEFAULT_LINK_GROUPS,
  type LinkGroupDefinition,
  type LinkGroupId,
} from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import { useOptionalWorkspaceChannel } from "../../instrument-context/workspaceChannel";
import { useChannelSelections } from "../ChannelPicker/useChannelSelections";
import { type InstrumentRow, toInstrument } from "./instrumentRow";
import linkCss from "./linkColumn.css";

const classBase = "tradingLinkCell";

/** Name of the grid's client-side link column. */
export const LINK_COLUMN = "link";
const LINK_RENDERER = "trading.instrument-link";

/** Selection source of the grid's link publishes. */
export const INSTRUMENT_GRID_LINK_SOURCE = "InstrumentGrid";

/** The link column: always first, not in column sets or the column picker. */
export const linkColumnDescriptor: ColumnDescriptor = {
  name: LINK_COLUMN,
  label: "",
  allowColumnHeaderMenu: false,
  resizeable: false,
  sortable: false,
  source: "client",
  width: 36,
  type: { name: "string", renderer: { name: LINK_RENDERER } },
};

export interface GridChannelLinks {
  /** The workspace channels, in picker order. */
  channels: readonly LinkGroupDefinition[];
  /** The channel Enter / double-click link to. */
  activeChannel: LinkGroupId;
  /** The channel holding `ric`, if any (at most one). */
  channelOf: (ric: string) => LinkGroupDefinition | undefined;
  /** The instrument `channel` holds now. */
  instrumentOf: (channel: LinkGroupId) => SelectedInstrument | undefined;
  /** Link to `channel`, moving the instrument off any other channel. */
  link: (instrument: SelectedInstrument, channel: LinkGroupId) => void;
  /** Link a ric shown in the grid (with the row's static data when known). */
  linkRic: (ric: string, channel: LinkGroupId) => void;
  clear: (channel: LinkGroupId) => void;
  /** Ric whose link menu is open. */
  menuRic: string | undefined;
  setMenuRic: (ric: string | undefined) => void;
  /** Keep a rendered row's instrument, for linkRic from the keyboard. */
  remember: (instrument: SelectedInstrument) => void;
}

const GridChannelLinksContext = createContext<GridChannelLinks | undefined>(
  undefined,
);
export const GridChannelLinksProvider = GridChannelLinksContext.Provider;

/**
 * Channel links for the grid: which channel holds each ric, and actions
 * that link with one channel per instrument. Uses the workspace channels
 * (WorkspaceChannelProvider), else the default channels with red active.
 */
export const useGridChannelLinks = (): GridChannelLinks => {
  const workspace = useOptionalWorkspaceChannel();
  const channels = workspace?.channels ?? DEFAULT_LINK_GROUPS;
  const activeChannel = workspace?.activeChannel ?? DEFAULT_LINK_GROUP;
  const bus = useInstrumentLinkBus();
  const selections = useChannelSelections(channels);
  const [menuRic, setMenuRic] = useState<string>();
  const instruments = useRef(new Map<string, SelectedInstrument>());

  const byRic = useMemo(() => {
    const map = new Map<string, LinkGroupDefinition>();
    for (const channel of channels) {
      const ric = selections.get(channel.id)?.ric;
      if (ric && !map.has(ric)) map.set(ric, channel);
    }
    return map;
  }, [channels, selections]);

  const link = useCallback(
    (instrument: SelectedInstrument, channel: LinkGroupId) => {
      linkInstrument(
        bus,
        channels,
        channel,
        instrument,
        INSTRUMENT_GRID_LINK_SOURCE,
      );
    },
    [bus, channels],
  );
  const linkRic = useCallback(
    (ric: string, channel: LinkGroupId) =>
      link(instruments.current.get(ric) ?? { ric }, channel),
    [link],
  );
  const clear = useCallback(
    (channel: LinkGroupId) => {
      clearChannel(bus, channel, INSTRUMENT_GRID_LINK_SOURCE);
    },
    [bus],
  );
  const remember = useCallback((instrument: SelectedInstrument) => {
    instruments.current.set(instrument.ric, instrument);
  }, []);

  return useMemo(
    () => ({
      activeChannel,
      channelOf: (ric: string) => byRic.get(ric),
      channels,
      clear,
      instrumentOf: (channel: LinkGroupId) => selections.get(channel),
      link,
      linkRic,
      menuRic,
      remember,
      setMenuRic,
    }),
    [
      activeChannel,
      byRic,
      channels,
      clear,
      link,
      linkRic,
      menuRic,
      remember,
      selections,
    ],
  );
};

/** The ric of the grid row containing `target` (from its link cell). */
export const rowRicOf = (target: EventTarget | null): string | undefined => {
  const row = (target as Element | null)?.closest?.(".vuuTableRow");
  return (
    row?.querySelector<HTMLElement>(`.${classBase}-button[data-ric]`)?.dataset
      .ric ?? undefined
  );
};

/** Whether `target` is inside a link cell. */
export const isInLinkCell = (target: EventTarget | null) =>
  Boolean((target as Element | null)?.closest?.(`.${classBase}`));

const LinkGlyph = () => (
  <svg
    aria-hidden="true"
    className={`${classBase}-glyph`}
    fill="none"
    height="12"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="12"
  >
    <path d="M6.5 9.5l3-3" />
    <path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" />
    <path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
  </svg>
);

const stopPropagation = (e: SyntheticEvent) => e.stopPropagation();
// Keys from the menu, except Escape: it must reach the menu's document
// listener, which closes it. Keys on the cell itself go on to the table.
const stopMenuKeyPropagation = (e: KeyboardEvent<HTMLElement>) => {
  if (e.key !== "Escape" && !e.currentTarget.contains(e.target as Node)) {
    e.stopPropagation();
  }
};

const channelStyle = (channel: LinkGroupDefinition) =>
  ({ "--channel-color": channel.color }) as CSSProperties;

/**
 * `trading.instrument-link`: the channel dot of a row whose instrument is
 * on a channel (ringed for the active channel), a link glyph on hover or
 * focus otherwise. Click opens the link menu.
 */
export const LinkCell = ({ dataRow }: TableCellRendererProps) => {
  useComponentCssInjection({
    testId: "trading-instrument-link-cell",
    css: linkCss,
    window: useWindow(),
  });
  const links = useContext(GridChannelLinksContext);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const row = dataRow as unknown as InstrumentRow;
  if (!links || row.isLeaf === false || row.ric == null) {
    return <div className={classBase} />;
  }
  const instrument = toInstrument(row);
  const { ric } = instrument;
  links.remember(instrument);
  const channel = links.channelOf(ric);
  const active = channel !== undefined && channel.id === links.activeChannel;
  const open = links.menuRic === ric;

  return (
    // Clicks in the link cell are not the table's: they would select the
    // row and move its cell focus away from the opening menu. Neither are
    // clicks and keys in the menu, a portal whose events bubble here.
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops propagation
    <div
      className={classBase}
      onClick={stopPropagation}
      onKeyDown={stopMenuKeyPropagation}
      onMouseDown={stopPropagation}
    >
      {/* No MenuTrigger: on a trigger the arrow keys open the menu, and
          they should move between rows. The grid opens it with L. */}
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          channel
            ? `${ric} is on the ${channel.label} channel${active ? " (active)" : ""}`
            : `Link ${ric} to a channel`
        }
        className={cx(`${classBase}-button`, {
          [`${classBase}-linked`]: channel,
          [`${classBase}-active`]: active,
        })}
        data-ric={ric}
        onClick={() => links.setMenuRic(open ? undefined : ric)}
        ref={buttonRef}
        style={channel ? channelStyle(channel) : undefined}
        tabIndex={-1}
        title={channel ? `${channel.label} channel` : "Link to a channel"}
        type="button"
      >
        {channel ? (
          <span aria-hidden className={`${classBase}-dot`} />
        ) : (
          <LinkGlyph />
        )}
      </button>
      <Menu
        getVirtualElement={() => buttonRef.current}
        onOpenChange={(next) => links.setMenuRic(next ? ric : undefined)}
        open={open}
        placement="bottom-start"
      >
        <MenuPanel className={`${classBase}-menu`}>
          <MenuGroup
            label={
              channel
                ? `Move ${ric} from ${channel.label} to`
                : `Link ${ric} to channel`
            }
          >
            {links.channels.map((c, index) => {
              const held = links.instrumentOf(c.id);
              const isOwn = c.id === channel?.id;
              const note = isOwn
                ? "Linked · click to clear"
                : held
                  ? `replaces ${held.ric}`
                  : "empty";
              return (
                <MenuItem
                  className={`${classBase}-item`}
                  key={c.id}
                  onClick={() =>
                    isOwn ? links.clear(c.id) : links.link(instrument, c.id)
                  }
                  style={channelStyle(c)}
                >
                  <span
                    aria-hidden
                    className={cx(`${classBase}-dot`, {
                      [`${classBase}-active`]: c.id === links.activeChannel,
                    })}
                  />
                  <span className={`${classBase}-itemLabel`}>{c.label}</span>
                  <span className={`${classBase}-itemNote`}>{note}</span>
                  <kbd aria-hidden className={`${classBase}-key`}>
                    {index + 1}
                  </kbd>
                </MenuItem>
              );
            })}
          </MenuGroup>
        </MenuPanel>
      </Menu>
    </div>
  );
};

let registered = false;

/** Register the link cell renderer with vuu (idempotent). */
export const registerLinkCellRenderer = () => {
  if (registered) return;
  registered = true;
  // a literal, for the docs coverage check (scripts/docs/api-reference.ts)
  registerComponent("trading.instrument-link", LinkCell, "cell-renderer", {
    description: "Workspace channel of the row's instrument",
    label: "Instrument link",
    serverDataType: ["string"],
  });
};
