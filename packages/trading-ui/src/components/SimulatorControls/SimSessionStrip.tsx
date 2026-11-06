import { RpcName, TradingPhase } from "@heswell/trading-schemas";
import { Button, Dropdown, Option } from "@salt-ds/core";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useState } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { formatTime } from "../../utils/time";
import { controlsClass, plain, useControlsCss } from "./useControlsCss";
import { useSimRpc } from "./useSimRpc";

export type SimSessionStripProps = HTMLAttributes<HTMLDivElement>;

const PHASES = [
  { phase: TradingPhase.PreOpen, label: "Pre-open" },
  { phase: TradingPhase.Continuous, label: "Open" },
  { phase: TradingPhase.Closed, label: "Close" },
] as const;

/**
 * The simulated session (`simSession`, sim-admin only): phase, next change
 * and session clock, with controls to force a phase, pause or resume every
 * bot and start a scenario (`scenarios`) on its default instruments.
 */
export const SimSessionStrip = forwardRef<HTMLDivElement, SimSessionStripProps>(
  function SimSessionStrip({ className, ...htmlAttributes }, ref) {
    useControlsCss();
    const { rows, dataSource } = useTradingRows("simSession", { rowCount: 1 });
    const { rows: scenarios } = useTradingRows("scenarios", { rowCount: 100 });
    const { send, message, pending } = useSimRpc(dataSource);
    const [scenario, setScenario] = useState<string>();
    const session = rows[0];
    const selected = scenarios.find((row) => row.name === scenario);

    return (
      <div
        {...htmlAttributes}
        className={cx(controlsClass, className)}
        data-testid="trading-sim-session-strip"
        ref={ref}
      >
        <div className={`${controlsClass}-row`}>
          <span
            className={`${controlsClass}-phase`}
            data-testid="trading-sim-phase"
          >
            {plain(session?.phase)}
          </span>
          {session?.forced ? (
            <span className={`${controlsClass}-label`}>(forced)</span>
          ) : null}
          {session?.timeOfDay ? (
            <span className={`${controlsClass}-value`} title="Session clock">
              {String(session.timeOfDay)}
            </span>
          ) : null}
          {session?.nextPhase ? (
            <span className={`${controlsClass}-label`}>
              {String(session.nextPhase)} at{" "}
              {formatTime(session.nextChangeAt, { milliseconds: false })}
            </span>
          ) : null}
          <span className={`${controlsClass}-label`}>
            {Number(session?.pausedBots ?? 0)} paused bots,{" "}
            {Number(session?.runningScenarios ?? 0)} running scenarios
          </span>
        </div>
        <div className={`${controlsClass}-row`}>
          {PHASES.map(({ phase, label }) => (
            <Button
              disabled={pending || session?.phase === phase}
              key={phase}
              onClick={() =>
                send(
                  RpcName.SetMarketPhase,
                  { phase },
                  `Market ${label.toLowerCase()}`,
                )
              }
              sentiment="neutral"
            >
              {label}
            </Button>
          ))}
          <Button
            disabled={pending}
            onClick={() => send(RpcName.PauseBots, {}, "All bots paused")}
            sentiment="neutral"
          >
            Pause all bots
          </Button>
          <Button
            disabled={pending}
            onClick={() => send(RpcName.ResumeBots, {}, "All bots resumed")}
            sentiment="neutral"
          >
            Resume all bots
          </Button>
          <Dropdown
            aria-label="Scenario"
            onSelectionChange={(_, [name]) => setScenario(name)}
            placeholder="Scenario"
            selected={scenario ? [scenario] : []}
            style={{ width: 180 }}
            value={scenario ?? ""}
          >
            {scenarios.map((row) => (
              <Option key={String(row.name)} value={String(row.name)} />
            ))}
          </Dropdown>
          <Button
            disabled={pending || !scenario}
            onClick={() =>
              scenario &&
              send(
                RpcName.RunScenario,
                { name: scenario },
                ({ runId, rics }) =>
                  `${scenario} started (${runId}) on ${rics.length} instruments`,
              )
            }
            sentiment="accented"
          >
            Run scenario
          </Button>
        </div>
        {selected ? (
          <div className={`${controlsClass}-label`}>
            {String(selected.description)} Targets: {String(selected.targets)}.
          </div>
        ) : null}
        {message ? (
          <output
            className={`${controlsClass}-message`}
            data-error={message.error}
          >
            {message.text}
          </output>
        ) : null}
      </div>
    );
  },
);
