/**
 * Errors and warnings of an orderEntry row, carried in its vuuMsg column as
 * a JSON array (an empty string when there are none):
 *
 *   [{"l":"E","f":"price","c":"INVALID_TICK_SIZE","t":"Price must be on a 0.5 tick"}]
 *
 * - l: level. E = error (blocks sendOrder), R = needs review (sendOrder
 *   needs confirmed), I = information.
 * - f: the draft field it is about (an orderEntry column, e.g. price or
 *   durationMins), or "form" for the order as a whole.
 * - c: a RejectReason, or a risk code (EntryRiskCode).
 * - t: the text to show.
 *
 * vuuMsg is also used by vuu-server for its own plain-text messages
 * (`stale:<key>:<cols>`); anything that is not a JSON array decodes as a
 * single form-level error.
 */

export const EntryMessageLevel = Object.freeze({
  Error: "E",
  Review: "R",
  Info: "I",
} as const);
export type EntryMessageLevel =
  (typeof EntryMessageLevel)[keyof typeof EntryMessageLevel];

/** Codes of the pre-trade risk warnings (the other codes are RejectReasons). */
export const EntryRiskCode = Object.freeze({
  MaxOrderQty: "maxOrderQty",
  MaxOrderNotional: "maxOrderNotional",
  MaxPositionNotional: "maxPositionNotional",
  Collar: "collar",
  NoPrice: "noPrice",
} as const);
export type EntryRiskCode = (typeof EntryRiskCode)[keyof typeof EntryRiskCode];

/** The field of a message about the order as a whole. */
export const FORM_FIELD = "form";

export interface EntryMessage {
  level: EntryMessageLevel;
  field: string;
  code: string;
  text: string;
}

interface WireMessage {
  l: string;
  f: string;
  c: string;
  t: string;
}

const LEVELS = new Set<string>(Object.values(EntryMessageLevel));

/** vuuMsg text for a list of messages ('' when there are none). */
export const encodeEntryMessages = (
  messages: readonly EntryMessage[],
): string =>
  messages.length === 0
    ? ""
    : JSON.stringify(
        messages.map(
          ({ level, field, code, text }): WireMessage => ({
            l: level,
            f: field,
            c: code,
            t: text,
          }),
        ),
      );

/**
 * Messages in a vuuMsg value. A value that is not an encoded list (e.g. a
 * vuu-server stale message) is returned as one form-level error.
 */
export const decodeEntryMessages = (
  vuuMsg: string | null | undefined,
): EntryMessage[] => {
  if (!vuuMsg) return [];
  if (vuuMsg.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(vuuMsg);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item: Partial<WireMessage>) =>
          item &&
          typeof item.l === "string" &&
          LEVELS.has(item.l) &&
          typeof item.f === "string" &&
          typeof item.c === "string" &&
          typeof item.t === "string"
            ? [
                {
                  level: item.l as EntryMessageLevel,
                  field: item.f,
                  code: item.c,
                  text: item.t,
                },
              ]
            : [],
        );
      }
    } catch {
      // not JSON: fall through
    }
  }
  return [
    {
      level: EntryMessageLevel.Error,
      field: FORM_FIELD,
      code: "INTERNAL_ERROR",
      text: vuuMsg,
    },
  ];
};

/** true if any message blocks sending. */
export const hasEntryErrors = (messages: readonly EntryMessage[]) =>
  messages.some(({ level }) => level === EntryMessageLevel.Error);

/** The messages that send the order through Review first. */
export const entryReviewMessages = (messages: readonly EntryMessage[]) =>
  messages.filter(({ level }) => level === EntryMessageLevel.Review);

const FIELD_FOR_REASON: Readonly<Record<string, string>> = Object.freeze({
  INVALID_QUANTITY: "quantity",
  INVALID_LOT_SIZE: "quantity",
  EXCEEDS_MAX_QUANTITY: "quantity",
  EXCEEDS_MAX_NOTIONAL: "quantity",
  MISSING_PRICE: "price",
  INVALID_PRICE: "price",
  INVALID_TICK_SIZE: "price",
  PRICE_OUTSIDE_COLLAR: "price",
  MISSING_STOP_PRICE: "stopPrice",
  INVALID_STOP_PRICE: "stopPrice",
  UNSUPPORTED_TIF: "timeInForce",
  UNSUPPORTED_ORD_TYPE: "ordType",
  UNKNOWN_INSTRUMENT: "ric",
  RESTRICTED_INSTRUMENT: "ric",
  INSTRUMENT_HALTED: "ric",
  MARKET_CLOSED: "ric",
  UNKNOWN_ACCOUNT: "account",
  ACCOUNT_DISABLED: "account",
  [EntryRiskCode.MaxOrderQty]: "quantity",
  [EntryRiskCode.MaxOrderNotional]: "quantity",
  [EntryRiskCode.MaxPositionNotional]: "quantity",
  [EntryRiskCode.Collar]: "price",
});

/** The draft field a reject reason or risk code is about ("form" if none). */
export const entryFieldForCode = (code: string): string =>
  FIELD_FOR_REASON[code] ?? FORM_FIELD;
