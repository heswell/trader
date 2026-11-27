import { formatUtilisation } from "./limitFormat";
import { useLimitsCss } from "./useLimitsCss";

/** The bar runs to this multiple of the limit (room for the hard tick). */
const SCALE = 1.25;

const pct = (value: number) =>
  `${Math.min(100, Math.max(0, (value / SCALE) * 100))}%`;

export interface UtilisationBarProps {
  /** used / soft. */
  utilisation: number;
  /** warning / soft and hard / soft, for the ticks. */
  warningPct: number;
  hardPct: number;
  /** LimitState, for the colour. */
  state: string;
}

/**
 * Utilisation as a bar with ticks at warning and the limit, and a dotted
 * tick at hard; the percent is its accessible name.
 */
export const UtilisationBar = ({
  hardPct,
  state,
  utilisation,
  warningPct,
}: UtilisationBarProps) => {
  useLimitsCss();
  return (
    <div
      aria-label={`Utilisation ${formatUtilisation(utilisation)}`}
      className={`tradingUtilisationBar tradingUtilisationBar-${state}`}
      role="img"
    >
      <span className="tradingUtilisationBar-track">
        <span
          className="tradingUtilisationBar-fill"
          style={{ width: pct(utilisation) }}
        />
        {warningPct > 0 ? (
          <span
            className="tradingUtilisationBar-tick"
            style={{ left: pct(warningPct) }}
          />
        ) : null}
        <span className="tradingUtilisationBar-tick" style={{ left: pct(1) }} />
        {hardPct > 1 ? (
          <span
            className="tradingUtilisationBar-tick tradingUtilisationBar-tick-hard"
            style={{ left: pct(hardPct) }}
          />
        ) : null}
      </span>
      <span className="tradingUtilisationBar-pct">
        {formatUtilisation(utilisation)}
      </span>
    </div>
  );
};
