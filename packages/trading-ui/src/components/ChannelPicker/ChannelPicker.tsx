import { useInstrumentLinkBus } from "../../instrument-context/InstrumentContext";
import type { LinkGroupId } from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import {
  Button,
  ToggleButtonGroup,
  useFloatingComponent,
  useFloatingUI,
} from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type ChannelPickerDensity,
  ChannelSegment,
  SearchIcon,
} from "./ChannelSegment";
import { InstrumentSearch } from "./InstrumentSearch";
import { useChannelPrices } from "./useChannelPrices";
import { useChannelSelections } from "./useChannelSelections";
import { useWorkspaceChannel } from "../../instrument-context/workspaceChannel";

import channelPickerCss from "./ChannelPicker.css";

const classBase = "tradingChannelPicker";

/** Selection source id of the picker's publishes. */
export const CHANNEL_PICKER_SOURCE = "ChannelPicker";

export interface ChannelPickerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /**
   * `auto` (default): `full` when every channel fits, else `compact`, else
   * `dots`. Or force one density.
   */
  density?: ChannelPickerDensity | "auto";
}

/**
 * The densest layout that fits: compares the natural widths of hidden
 * `full` and `compact` copies with the width available to the picker.
 */
const useFittedDensity = (
  enabled: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  fullRef: RefObject<HTMLDivElement | null>,
  compactRef: RefObject<HTMLDivElement | null>,
): ChannelPickerDensity => {
  const [density, setDensity] = useState<ChannelPickerDensity>("full");
  useLayoutEffect(() => {
    const root = rootRef.current;
    const full = fullRef.current;
    const compact = compactRef.current;
    if (!enabled || !root || !full || !compact) return;
    const measure = () => {
      const available = root.clientWidth;
      setDensity(
        full.offsetWidth <= available
          ? "full"
          : compact.offsetWidth <= available
            ? "compact"
            : "dots",
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(full);
    observer.observe(compact);
    return () => observer.disconnect();
  }, [enabled, rootRef, fullRef, compactRef]);
  return density;
};

/**
 * The workspace channel picker: one segment per channel showing the
 * channel's instrument. Clicking a segment makes it the active channel
 * (bound components follow it); the active segment opens the instrument
 * search, which sets that channel's instrument.
 */
export const ChannelPicker = ({
  className,
  density: densityProp = "auto",
  ...htmlAttributes
}: ChannelPickerProps) => {
  const { channels, activeChannel, setActiveChannel, addRecentRic } =
    useWorkspaceChannel();
  useComponentCssInjection({
    testId: "trading-channel-picker",
    css: channelPickerCss,
    window: useWindow(),
  });
  const bus = useInstrumentLinkBus();
  const selections = useChannelSelections(channels);
  const prices = useChannelPrices(
    channels
      .map(({ id }) => selections.get(id)?.ric)
      .filter((ric): ric is string => ric !== undefined),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLDivElement>(null);
  const fitted = useFittedDensity(
    densityProp === "auto",
    rootRef,
    fullRef,
    compactRef,
  );
  const density = densityProp === "auto" ? fitted : densityProp;

  const [searchOpen, setSearchOpen] = useState(false);
  const searchId = useId();
  // The search floats in a portal: a title bar slot may clip its content
  // (overflow: hidden), which would hide the dropdown and let the focused
  // input scroll the strip out of view.
  const { Component: FloatingComponent } = useFloatingComponent();
  const { elements, floating, reference, strategy, x, y } = useFloatingUI({
    open: searchOpen,
    placement: "bottom",
  });
  const segmentRefs = useRef(new Map<LinkGroupId, HTMLButtonElement>());
  const activeRef = useRef(activeChannel);
  activeRef.current = activeChannel;

  const focusActiveSegment = useCallback(() => {
    requestAnimationFrame(() =>
      segmentRefs.current.get(activeRef.current)?.focus(),
    );
  }, []);

  const closeSearch = useCallback(
    (restoreFocus: boolean) => {
      setSearchOpen(false);
      if (restoreFocus) focusActiveSegment();
    },
    [focusActiveSegment],
  );

  // Close when the user clicks anywhere outside the picker.
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (evt: PointerEvent) => {
      const target = evt.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !elements.floating?.contains(target)
      ) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen, elements.floating]);

  const selectChannel = (channel: LinkGroupId) => {
    if (channel === activeChannel) {
      setSearchOpen((open) => !open);
    } else {
      setActiveChannel(channel);
      // An empty channel is no use until it has an instrument.
      if (!selections.get(channel)) setSearchOpen(true);
    }
  };

  const cycleChannel = (step: 1 | -1) => {
    const index = channels.findIndex(({ id }) => id === activeChannel);
    const next = channels[(index + step + channels.length) % channels.length];
    if (next) setActiveChannel(next.id);
  };

  // Focus goes back to the channel only after a keyboard pick: after a
  // mouse pick it would show the keyboard focus ring for no reason.
  const pickInstrument = (
    instrument: SelectedInstrument,
    viaKeyboard: boolean,
  ) => {
    bus.publish(activeChannel, instrument, CHANNEL_PICKER_SOURCE);
    addRecentRic(instrument.ric);
    closeSearch(viaKeyboard);
  };

  const active = channels.find(({ id }) => id === activeChannel);

  /**
   * The strip: a ToggleButtonGroup of channels (arrow keys move between
   * them, one tab stop) then the search button. `measure` renders a hidden
   * copy at another density, for useFittedDensity.
   */
  const renderStrip = (stripDensity: ChannelPickerDensity, measure = false) => (
    <>
      <ToggleButtonGroup
        aria-label="Workspace channel"
        // Not "solid": vuu-theme paints selected solid toggles dark.
        appearance="bordered"
        className={`${classBase}-group`}
        value={activeChannel}
      >
        {channels.map((channel) => (
          <ChannelSegment
            active={channel.id === activeChannel}
            channel={channel}
            density={stripDensity}
            instrument={selections.get(channel.id)}
            key={channel.id}
            onClick={measure ? undefined : () => selectChannel(channel.id)}
            price={prices.get(selections.get(channel.id)?.ric ?? "")}
            ref={
              measure
                ? undefined
                : (el) => {
                    if (el) segmentRefs.current.set(channel.id, el);
                    else segmentRefs.current.delete(channel.id);
                  }
            }
          />
        ))}
      </ToggleButtonGroup>
      <Button
        aria-controls={!measure && searchOpen ? searchId : undefined}
        aria-expanded={!measure && searchOpen}
        aria-haspopup="dialog"
        aria-label={`Search instruments for the ${active?.label ?? ""} channel`}
        appearance="transparent"
        className={`${classBase}-search`}
        onClick={measure ? undefined : () => setSearchOpen((open) => !open)}
        style={
          active
            ? ({ "--channel-color": active.color } as CSSProperties)
            : undefined
        }
      >
        <SearchIcon />
      </Button>
    </>
  );

  return (
    <div
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-density={density}
      ref={rootRef}
    >
      <div
        className={cx(`${classBase}-strip`, {
          [`${classBase}-searchOpen`]: searchOpen,
        })}
        ref={reference}
      >
        {renderStrip(density)}
      </div>
      {densityProp === "auto" ? (
        <div aria-hidden="true" className={`${classBase}-measure`} inert>
          <div className={`${classBase}-strip`} ref={fullRef}>
            {renderStrip("full", true)}
          </div>
          <div className={`${classBase}-strip`} ref={compactRef}>
            {renderStrip("compact", true)}
          </div>
        </div>
      ) : null}
      <FloatingComponent
        className={`${classBase}-popup`}
        left={x ?? 0}
        open={searchOpen && active !== undefined}
        position={strategy}
        ref={floating}
        top={y ?? 0}
      >
        {active ? (
          <InstrumentSearch
            channel={active}
            channels={channels}
            id={searchId}
            onClose={() => closeSearch(true)}
            onCycleChannel={cycleChannel}
            onPick={pickInstrument}
            selections={selections}
          />
        ) : null}
      </FloatingComponent>
    </div>
  );
};
