const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export interface TimeFormat {
  /** Include milliseconds (default true): 14:03:07.042 */
  milliseconds?: boolean;
  /** Format in UTC instead of the browser's time zone. */
  utc?: boolean;
}

/** Epoch milliseconds -> `HH:mm:ss.SSS`. Returns "" for non-numbers. */
export const formatTime = (
  timestamp: unknown,
  { milliseconds = true, utc = false }: TimeFormat = {},
) => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const h = utc ? date.getUTCHours() : date.getHours();
  const m = utc ? date.getUTCMinutes() : date.getMinutes();
  const s = utc ? date.getUTCSeconds() : date.getSeconds();
  const ms = utc ? date.getUTCMilliseconds() : date.getMilliseconds();
  const text = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return milliseconds ? `${text}.${pad(ms, 3)}` : text;
};
