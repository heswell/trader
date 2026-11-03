import { TradingPhase } from "@heswell/trading-schemas";
import type { LinkGroupDefinition } from "../../instrument-context/linkGroups";
import { directionColour } from "../../utils/colours";
import { formatPercent, formatPrice } from "../../utils/formatting";
import type { DataRow, RowProps } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  type CSSProperties,
  createContext,
  memo,
  type MouseEvent,
  useContext,
} from "react";
import { usePriceFlash } from "./usePriceFlash";

const classBase = "tradingInstrumentSearchRow";

export interface InstrumentSearchRowContextValue {
  /** Channels that show each ric (for the dots). */
  channelsByRic: ReadonlyMap<string, readonly LinkGroupDefinition[]>;
  /** Ric of the channel being searched for, and its colour. */
  currentRic: string | undefined;
  /** 0-based index of the keyboard / mouse highlighted row. */
  highlightedIndex: number;
  /** Id prefix of rows, for aria-activedescendant. */
  idPrefix: string;
  /** Index of the Table's first row in the whole result list. */
  indexOffset: number;
  onHighlight: (index: number) => void;
  /** `viaKeyboard`: picked with Enter (a scripted click), not the mouse. */
  onPick: (dataRow: DataRow, viaKeyboard: boolean) => void;
  /** The search text, to mark the match. */
  query: string;
}

export const InstrumentSearchRowContext =
  createContext<InstrumentSearchRowContextValue>({
    channelsByRic: new Map(),
    currentRic: undefined,
    highlightedIndex: -1,
    idPrefix: "",
    indexOffset: 0,
    onHighlight: () => undefined,
    onPick: () => undefined,
    query: "",
  });

/** Row id for aria-activedescendant. */
export const searchRowId = (idPrefix: string, index: number) =>
  `${idPrefix}-row-${index}`;

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const NO_VALUE = "—";

const PHASE_LABEL: Record<string, string> = {
  [TradingPhase.Closed]: "Closed",
  [TradingPhase.PreOpen]: "Pre-open",
  [TradingPhase.OpeningAuction]: "Auction",
  [TradingPhase.ClosingAuction]: "Auction",
  [TradingPhase.PostClose]: "Post-close",
  [TradingPhase.Halted]: "Halted",
};

/** The text around the first case-insensitive match of `query`. */
const Marked = ({ text, query }: { text: string; query: string }) => {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className={`${classBase}-match`}>
        {text.slice(at, at + query.length)}
      </mark>
      {text.slice(at + query.length)}
    </>
  );
};

/**
 * A vuu Table Row for the instrument search: no cells, one composed line
 * per instrument (channels, ric + name, day range, bid / ask, last +
 * change). Reads the `instrumentPrices` columns by name.
 */
export const InstrumentSearchRow = memo(function InstrumentSearchRow({
  "aria-rowindex": ariaRowIndex,
  dataRow,
  offset,
  style,
}: RowProps & { "aria-rowindex"?: number }) {
  const {
    channelsByRic,
    currentRic,
    highlightedIndex,
    idPrefix,
    indexOffset,
    onHighlight,
    onPick,
    query,
  } = useContext(InstrumentSearchRowContext);

  const ric = String(dataRow.ric ?? "");
  const description = String(dataRow.description ?? "");
  const format = {
    priceDecimals: num(dataRow.priceDecimals),
    tickSize: num(dataRow.tickSize),
    tickBands: (dataRow.tickBands as string | undefined) || undefined,
  };
  const last = num(dataRow.last);
  const close = num(dataRow.close);
  const low = num(dataRow.low);
  const high = num(dataRow.high);
  const changePct = num(dataRow.changePct);
  const phase = typeof dataRow.phase === "string" ? dataRow.phase : undefined;
  const halted = phase === TradingPhase.Halted;
  const phaseLabel = phase ? PHASE_LABEL[phase] : undefined;
  const flash = usePriceFlash(ric, last);
  const price = (value: unknown) => formatPrice(value, format) || NO_VALUE;

  const span = low !== undefined && high !== undefined ? high - low : 0;
  const position = (value: number | undefined) =>
    value === undefined || low === undefined || span <= 0
      ? undefined
      : `${Math.min(100, Math.max(0, ((value - low) / span) * 100))}%`;

  const index = indexOffset + dataRow.index;
  const highlighted = index === highlightedIndex;
  const current = ric === currentRic;
  const ricMatches =
    query !== "" && ric.toLowerCase().startsWith(query.toLowerCase());

  const handleClick = (evt: MouseEvent) => {
    evt.preventDefault();
    // Enter clicks the row from script: such a click has no click count.
    onPick(dataRow, evt.detail === 0);
  };

  // Rows are not focusable: keyboard users stay in the search input, which
  // moves the highlight (aria-activedescendant) and picks with Enter.
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: see above
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    // biome-ignore lint/a11y/useSemanticElements: rows of a vuu Table (div grid)
    <div
      aria-rowindex={ariaRowIndex}
      aria-selected={current}
      className={cx(classBase, "vuuTableRow", {
        [`${classBase}-highlighted`]: highlighted,
        [`${classBase}-current`]: current,
        [`${classBase}-halted`]: halted,
      })}
      id={searchRowId(idPrefix, index)}
      onClick={handleClick}
      onMouseMove={highlighted ? undefined : () => onHighlight(index)}
      role="row"
      style={{ ...style, top: offset }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: rows of a vuu Table (div grid) */}
      <div className={`${classBase}-content`} role="cell">
        <span aria-hidden="true" className={`${classBase}-channels`}>
          {(channelsByRic.get(ric) ?? []).map((channel) => (
            <span
              className={`${classBase}-channelDot`}
              key={channel.id}
              style={{ "--channel-color": channel.color } as CSSProperties}
              title={channel.label}
            />
          ))}
        </span>

        <span className={`${classBase}-identity`}>
          <span className={`${classBase}-ricLine`}>
            <span className={`${classBase}-ric`}>
              {ricMatches ? <Marked text={ric} query={query} /> : ric}
            </span>
            {phaseLabel ? (
              <span
                className={cx(`${classBase}-phase`, {
                  [`${classBase}-phase-halted`]: halted,
                })}
              >
                {phaseLabel}
              </span>
            ) : null}
          </span>
          <span className={`${classBase}-description`}>
            {ricMatches ? (
              description
            ) : (
              <Marked text={description} query={query} />
            )}
            {dataRow.exchange ? ` · ${dataRow.exchange}` : ""}
            {dataRow.currency ? ` · ${dataRow.currency}` : ""}
          </span>
        </span>

        <span
          aria-label={
            low !== undefined && high !== undefined
              ? `Day range ${formatPrice(low, format)} to ${formatPrice(high, format)}`
              : "No day range"
          }
          className={`${classBase}-range`}
          role="img"
        >
          <span className={`${classBase}-rangeTrack`}>
            {position(close) ? (
              <span
                className={`${classBase}-rangeClose`}
                style={{ left: position(close) }}
              />
            ) : null}
            {position(last) ? (
              <span
                className={`${classBase}-rangeLast`}
                style={{ left: position(last) }}
              />
            ) : null}
          </span>
          <span className={`${classBase}-rangeLabels`}>
            <span>{price(low)}</span>
            <span>{price(high)}</span>
          </span>
        </span>

        <span className={`${classBase}-touch`}>
          <span>
            <span className={`${classBase}-touchLabel`}>B </span>
            {halted ? NO_VALUE : price(dataRow.bid)}
          </span>
          <span>
            <span className={`${classBase}-touchLabel`}>A </span>
            {halted ? NO_VALUE : price(dataRow.ask)}
          </span>
        </span>

        <span className={`${classBase}-price`}>
          <span
            className={cx(
              `${classBase}-last`,
              flash && `${classBase}-flash-${flash.direction}`,
            )}
            key={flash?.seq ?? 0}
          >
            {price(last)}
          </span>
          <span
            className={`${classBase}-change`}
            style={{ color: directionColour(changePct) }}
          >
            {changePct !== undefined && changePct !== 0 ? (
              <span aria-hidden="true">{changePct > 0 ? "▲" : "▼"}</span>
            ) : null}
            {formatPercent(changePct)}
          </span>
        </span>
      </div>
    </div>
  );
});
