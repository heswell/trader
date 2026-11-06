import { RpcName, ScenarioStatus } from "@heswell/trading-schemas";
import { Button } from "@salt-ds/core";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { formatTime } from "../../utils/time";
import { controlsClass, useControlsCss } from "./useControlsCss";
import { useSimRpc } from "./useSimRpc";

export type ScenarioRunsProps = HTMLAttributes<HTMLDivElement>;

/**
 * Scenario runs (`scenarioRuns`, sim-admin only), newest first: progress
 * and status, with Stop (keep the changes) and Stop and revert.
 */
export const ScenarioRuns = forwardRef<HTMLDivElement, ScenarioRunsProps>(
  function ScenarioRuns({ className, ...htmlAttributes }, ref) {
    useControlsCss();
    const { rows, dataSource } = useTradingRows("scenarioRuns", {
      rowCount: 50,
      sort: { sortDefs: [{ column: "startedAt", sortType: "D" }] },
    });
    const { send, message, pending } = useSimRpc(dataSource);
    return (
      <div
        {...htmlAttributes}
        className={cx(controlsClass, className)}
        data-testid="trading-scenario-runs"
        ref={ref}
      >
        {rows.length === 0 ? (
          <span className={`${controlsClass}-label`}>No scenario runs yet</span>
        ) : (
          <ul className={`${controlsClass}-list`}>
            {rows.map((run) => {
              const runId = String(run.runId);
              const live = run.status === ScenarioStatus.Running;
              return (
                <li data-status={String(run.status)} key={runId}>
                  <strong>{runId}</strong>
                  <span>{String(run.name)}</span>
                  <span className={`${controlsClass}-phase`}>
                    {String(run.status)}
                  </span>
                  <span className={`${controlsClass}-value`}>
                    step {Number(run.step)}/{Number(run.steps)}
                  </span>
                  <span className={`${controlsClass}-label`}>
                    {formatTime(run.startedAt, { milliseconds: false })}
                    {run.user ? ` by ${String(run.user)}` : ""} ·{" "}
                    {String(run.targets)}
                    {run.reverted ? " · reverted" : ""}
                    {run.error ? ` · ${String(run.error)}` : ""}
                  </span>
                  {live ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        send(
                          RpcName.StopScenario,
                          { runId },
                          `${runId} stopped`,
                        )
                      }
                      sentiment="neutral"
                    >
                      Stop
                    </Button>
                  ) : null}
                  {!run.reverted ? (
                    <Button
                      disabled={pending}
                      onClick={() =>
                        send(
                          RpcName.StopScenario,
                          { runId, revert: true },
                          `${runId} reverted`,
                        )
                      }
                      sentiment="neutral"
                    >
                      {live ? "Stop and revert" : "Revert"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
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
