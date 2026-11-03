import type { LinkGroupDefinition } from "../../instrument-context/linkGroups";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import { directionColour } from "../../utils/colours";
import { formatPercent, formatPrice } from "../../utils/formatting";
import { ToggleButton } from "@salt-ds/core";
import cx from "clsx";
import { type CSSProperties, forwardRef } from "react";
import type { ChannelPrice } from "./useChannelPrices";
import { usePriceFlash } from "./usePriceFlash";

/**
 * How much each segment shows: `full` (variant B: dot, ric, last, change),
 * `compact` (variant A: dot, ric) or `dots` (the active channel keeps its
 * ric; the others are dots).
 */
export type ChannelPickerDensity = "full" | "compact" | "dots";

const classBase = "tradingChannelSegment";

export interface ChannelSegmentProps {
  active: boolean;
  channel: LinkGroupDefinition;
  density: ChannelPickerDensity;
  instrument: SelectedInstrument | undefined;
  onClick?: () => void;
  price: ChannelPrice | undefined;
}

/**
 * The change %, as wide whatever its sign so the strip doesn't shift as
 * it crosses zero: "-" becomes "−" (as wide as "+"), and an unsigned
 * 0.00% gets an invisible "+".
 */
const ChangeText = ({ value }: { value: number | undefined }) => {
  const text = formatPercent(value).replace(/^-/, "\u2212");
  const signed = /^[+\-\u2212]/.test(text);
  return (
    <>
      {signed || !text ? null : (
        <span aria-hidden="true" className={`${classBase}-signPad`}>
          +
        </span>
      )}
      {text}
    </>
  );
};

export const SearchIcon = () => (
  <svg
    aria-hidden="true"
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
  >
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4-4" />
  </svg>
);

/**
 * One channel of the picker: a Salt ToggleButton (a radio in the picker's
 * ToggleButtonGroup). Clicking selects the channel; clicking the selected
 * one opens the search (the picker handles both in `onClick`).
 */
export const ChannelSegment = forwardRef<
  HTMLButtonElement,
  ChannelSegmentProps
>(function ChannelSegment(
  { active, channel, density, instrument, onClick, price },
  forwardedRef,
) {
  const ric = instrument?.ric;
  const flash = usePriceFlash(ric, price?.last);
  const showRic = density !== "dots" || active;
  const showPrice = density === "full" && price?.last !== undefined;
  const name = `${channel.label} channel, ${ric ?? "no instrument"}`;
  return (
    <ToggleButton
      aria-label={name}
      className={cx(classBase, {
        [`${classBase}-active`]: active,
        [`${classBase}-empty`]: !ric,
      })}
      data-channel={channel.id}
      onClick={onClick}
      ref={forwardedRef}
      style={{ "--channel-color": channel.color } as CSSProperties}
      title={showRic ? undefined : name}
      value={channel.id}
    >
      <span aria-hidden="true" className={`${classBase}-dot`} />
      {showRic ? (
        <span className={`${classBase}-ric`}>{ric ?? "Link…"}</span>
      ) : null}
      {showPrice ? (
        <>
          <span
            className={cx(
              `${classBase}-last`,
              flash && `${classBase}-flash-${flash.direction}`,
            )}
            key={flash?.seq ?? 0}
          >
            {formatPrice(price?.last, price?.format ?? instrument)}
          </span>
          <span
            className={`${classBase}-change`}
            style={{ color: directionColour(price?.changePct) }}
          >
            <ChangeText value={price?.changePct} />
          </span>
        </>
      ) : null}
    </ToggleButton>
  );
});
