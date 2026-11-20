import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { type HTMLAttributes, useEffect, useState } from "react";
import type {
  LinkGroupDefinition,
  LinkGroupId,
} from "../../instrument-context/linkGroups";
import type { ChannelRics } from "../ChannelRowMarkers/useChannelRics";
import linkedFooterCss from "./LinkedInstrumentsFooter.css";

const classBase = "tradingLinkedFooter";

/** A linked instrument: the ric and the channel holding it. */
export interface LinkedInstrument {
  ric: string;
  channel: LinkGroupDefinition;
}

/** The instruments on a channel, in channel order. */
export const linkedInstruments = ({
  channels,
  selections,
  byRic,
}: Pick<ChannelRics, "byRic" | "channels" | "selections">) =>
  channels.flatMap<LinkedInstrument>((channel) => {
    const ric = selections.get(channel.id)?.ric;
    // one chip per ric: the channel that holds it (the first wins)
    return ric && byRic.get(ric)?.id === channel.id ? [{ ric, channel }] : [];
  });

/**
 * A blotter's chip filter: the ric of the pressed chip, cleared when that
 * ric leaves the channels.
 */
export const useLinkedRicFilter = (linkedRics: readonly string[]) => {
  const [filterRic, setFilterRic] = useState<string>();
  useEffect(() => {
    if (filterRic && !linkedRics.includes(filterRic)) setFilterRic(undefined);
  }, [filterRic, linkedRics]);
  return [filterRic, setFilterRic] as const;
};

export interface LinkedInstrumentsFooterProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  activeChannel: LinkGroupId;
  /** The ric the rows are filtered to, if a chip is pressed. */
  filterRic?: string;
  instruments: readonly LinkedInstrument[];
  onFilterRic: (ric: string | undefined) => void;
  /** Shown at the end, e.g. "7 orders". */
  summary?: string;
}

/**
 * The instruments on the workspace channels, as chips under a blotter
 * ("Linked"). A chip filters the rows to its instrument; pressed again,
 * all rows. The active channel's chip has a ring. Display only: the chips
 * never change a channel.
 */
export const LinkedInstrumentsFooter = ({
  activeChannel,
  className,
  filterRic,
  instruments,
  onFilterRic,
  summary,
  ...htmlAttributes
}: LinkedInstrumentsFooterProps) => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-linked-footer",
    css: linkedFooterCss,
    window: targetWindow,
  });
  return (
    <div
      {...htmlAttributes}
      className={cx(classBase, className)}
      role="toolbar"
      aria-label="Linked instruments"
    >
      <span className={`${classBase}-label`}>Linked</span>
      {instruments.length === 0 ? (
        <span className={`${classBase}-empty`}>No instrument on a channel</span>
      ) : (
        instruments.map(({ ric, channel }) => {
          const pressed = ric === filterRic;
          const active = channel.id === activeChannel;
          return (
            <button
              aria-pressed={pressed}
              className={`${classBase}-chip`}
              data-active={active || undefined}
              key={ric}
              onClick={() => onFilterRic(pressed ? undefined : ric)}
              style={{ "--tradingLinkedFooter-color": channel.color } as never}
              title={
                pressed
                  ? `Showing only ${ric} (${channel.label}). Click again to show all`
                  : `${channel.label}${active ? " (active channel)" : ""}: show only ${ric}`
              }
              type="button"
            >
              <span aria-hidden="true" className={`${classBase}-dot`} />
              {ric}
              {pressed ? (
                <svg
                  aria-hidden="true"
                  className={`${classBase}-clear`}
                  fill="none"
                  height={9}
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 10 10"
                  width={9}
                >
                  <path d="M2 2l6 6M8 2L2 8" />
                </svg>
              ) : null}
            </button>
          );
        })
      )}
      <span className={`${classBase}-spacer`} />
      {summary ? (
        <span aria-live="polite" className={`${classBase}-summary`}>
          {summary}
        </span>
      ) : null}
    </div>
  );
};
