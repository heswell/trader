import { ComboBox, type ComboBoxProps, Option } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  type ChangeEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { TradingRow } from "../../data/useDataSourceRows";
import { useTradingRows } from "../../data/useTradingRows";
import { useSelectedInstrument } from "../../instrument-context/InstrumentContext";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { LinkGroupSelector } from "../LinkGroupSelector";

import instrumentPickerCss from "./InstrumentPicker.css";

const classBase = "tradingInstrumentPicker";

const INSTRUMENT_COLUMNS = [
  "ric",
  "description",
  "currency",
  "exchange",
  "tickSize",
  "tickBands",
  "lotSize",
  "priceDecimals",
];

export interface InstrumentPickerProps
  extends Omit<
      ComboBoxProps<string>,
      | "value"
      | "defaultValue"
      | "onChange"
      | "onSelect"
      | "selected"
      | "children"
    >,
    LinkGroupProps {
  /** The selected ric (controlled). */
  value?: string;
  /** Called with the instrument's static data when the user picks one. */
  onSelect?: (instrument: SelectedInstrument) => void;
  /**
   * Show and publish the selected instrument of the picker's link group.
   * Default: true when neither `value` nor `onSelect` is given.
   */
  linked?: boolean;
  /** Max matches listed (default 20). */
  maxResults?: number;
}

const sanitize = (text: string) => text.replace(/["\\]/g, "").trim();

/** Vuu filter matching ric prefix or description text. */
export const instrumentSearchFilter = (text: string) => {
  const query = sanitize(text);
  if (!query) return undefined;
  return `ric starts "${query.toUpperCase()}" or description contains "${query}"`;
};

/** SelectedInstrument from an `instruments` (or `instrumentPrices`) row. */
export const toSelectedInstrument = (row: TradingRow): SelectedInstrument => ({
  ric: String(row.ric),
  description: row.description as string | undefined,
  currency: row.currency as string | undefined,
  exchange: row.exchange as string | undefined,
  tickSize: row.tickSize as number | undefined,
  tickBands: (row.tickBands as string | undefined) || undefined,
  lotSize: row.lotSize as number | undefined,
  priceDecimals: row.priceDecimals as number | undefined,
});

/** Notification / selection source id of InstrumentPicker. */
export const INSTRUMENT_PICKER_SOURCE = "InstrumentPicker";

/**
 * Instrument search over the `instruments` table: type a ric prefix or part
 * of the description, pick from the list. Controlled by `value` (a ric).
 * A thin Salt ComboBox (vuu TablePicker has no controlled value - see
 * docs/upstream-issues.md).
 */
export const InstrumentPicker = ({
  className,
  defaultLinkGroup,
  linked: linkedProp,
  linkGroup: linkGroupProp,
  onLinkGroupChange,
  showLinkGroupSelector = false,
  value: valueProp,
  onSelect: onSelectProp,
  maxResults = 20,
  placeholder = "Search instrument",
  ...comboBoxProps
}: InstrumentPickerProps) => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-instrument-picker",
    css: instrumentPickerCss,
    window: targetWindow,
  });
  const linked = linkedProp ?? (valueProp === undefined && !onSelectProp);
  const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
    defaultLinkGroup,
    linkGroup: linkGroupProp,
    onLinkGroupChange,
    persistKey: comboBoxProps.id
      ? `${INSTRUMENT_PICKER_SOURCE}:${comboBoxProps.id}`
      : INSTRUMENT_PICKER_SOURCE,
  });
  const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument({
    linkGroup: channel,
  });
  const value = valueProp ?? (linked ? selectedInstrument?.ric : undefined);
  const onSelect = (instrument: SelectedInstrument) => {
    onSelectProp?.(instrument);
    if (linked) setSelectedInstrument(instrument, INSTRUMENT_PICKER_SOURCE);
  };
  const [text, setText] = useState(value ?? "");
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    setText(value ?? "");
    setTyping(false);
  }, [value]);

  const filter = typing ? instrumentSearchFilter(text) : undefined;
  const { rows } = useTradingRows("instruments", {
    columns: INSTRUMENT_COLUMNS,
    filter,
    rowCount: maxResults,
  });
  const byRic = useMemo(
    () => new Map(rows.map((row) => [String(row.ric), row])),
    [rows],
  );

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
    setTyping(true);
  };
  const handleSelectionChange = (_: SyntheticEvent, selected: string[]) => {
    const ric = selected[0];
    const row = ric ? byRic.get(ric) : undefined;
    setTyping(false);
    if (row) {
      setText(ric);
      onSelect(toSelectedInstrument(row));
    }
  };
  const handleBlur = () => {
    if (typing) {
      setText(value ?? "");
      setTyping(false);
    }
  };

  const comboBox = (
    <ComboBox<string>
      {...comboBoxProps}
      className={cx(classBase, className)}
      data-link-group={linked ? linkGroup : undefined}
      data-instrument-picker=""
      onBlur={handleBlur}
      onChange={handleChange}
      onSelectionChange={handleSelectionChange}
      placeholder={placeholder}
      selected={value ? [value] : []}
      value={text}
    >
      {rows.map((row) => (
        <Option key={row.$key} value={String(row.ric)}>
          <span className={`${classBase}-ric`}>{String(row.ric)}</span>
          <span className={`${classBase}-description`}>
            {String(row.description ?? "")}
          </span>
        </Option>
      ))}
    </ComboBox>
  );
  return showLinkGroupSelector ? (
    <span className={`${classBase}-linked`}>
      <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
      {comboBox}
    </span>
  ) : (
    comboBox
  );
};
