import {
  BreachStatus,
  LimitRequestStatus,
  LimitState,
  type RpcName,
  type RpcRequestParams,
} from "@heswell/trading-schemas";
import { Button, Input, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { Table } from "@vuu-ui/vuu-table";
import type {
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useTradingRows } from "../../data/useTradingRows";
import { andFilters, filterString } from "../../utils/filters";
import { formatTime } from "../../utils/time";
import { useStaleData } from "../StaleIndicator/useStaleData";
import { IncreaseRequestDialog } from "./IncreaseRequestDialog";
import { KillSwitchDialog } from "./KillSwitchDialog";
import { LimitStateBadge } from "./LimitStateBadge";
import {
  LimitRenderer,
  limitRenderer,
  registerLimitRenderers,
} from "./LimitRenderers";
import {
  formatLimitAmount,
  formatUtilisation,
  limitLabel,
} from "./limitFormat";

import { useLimitsCss } from "./useLimitsCss";

registerLimitRenderers();

const classBase = "tradingLimits";

export type BreachStatusFilter = "open" | "acknowledged" | "closed" | "all";
export type BreachSeverityFilter = "all" | "hard" | "soft" | "warning";

const STATUS_FILTER: Record<BreachStatusFilter, string> = {
  open: `status = "${BreachStatus.Open}"`,
  acknowledged: `status = "${BreachStatus.Acknowledged}"`,
  closed: `status = "${BreachStatus.Closed}"`,
  all: "",
};
const SEVERITY_FILTER: Record<BreachSeverityFilter, string> = {
  all: "",
  hard: `severity = "${LimitState.HardBreach}"`,
  soft: `severity = "${LimitState.SoftBreach}"`,
  warning: `severity = "${LimitState.Warning}"`,
};

const COLUMNS = [
  "breachId",
  "limitKey",
  "entityId",
  "entityType",
  "parentId",
  "metric",
  "ric",
  "worst",
  "severity",
  "state",
  "status",
  "openedAt",
  "atBreach",
  "peak",
  "peakAt",
  "used",
  "warning",
  "soft",
  "hard",
  "utilisation",
  "peakUtilisation",
  "owner",
  "acknowledgedBy",
  "escalatedTo",
  "closedAt",
];

const amount = {
  name: "number" as const,
  formatting: { decimals: 0, useLocaleString: true },
};

export const limitBreachesTableConfig: TableConfig = {
  columnDefaultWidth: 100,
  rowSeparators: true,
  columns: [
    {
      name: "openedAt",
      label: "Time",
      width: 80,
      type: limitRenderer(LimitRenderer.Time),
    },
    {
      name: "severity",
      label: "Severity",
      width: 80,
      type: limitRenderer(LimitRenderer.State),
    },
    { name: "entityId", label: "Entity", width: 100 },
    {
      name: "metric",
      label: "Limit",
      width: 180,
      type: limitRenderer(LimitRenderer.Metric),
    },
    { name: "atBreach", label: "At breach", align: "right", type: amount },
    { name: "peak", label: "Peak", align: "right", type: amount },
    { name: "used", label: "Now", align: "right", type: amount },
    { name: "status", label: "State", width: 110 },
    { name: "escalatedTo", label: "Escalated", width: 80 },
  ],
};

interface Breach {
  breachId: string;
  limitKey: string;
  entityId: string;
  entityType: string;
  parentId: string;
  metric: string;
  ric: string;
  worst: string;
  severity: string;
  state: string;
  status: string;
  openedAt: number;
  peak: number;
  peakAt: number;
  used: number;
  soft: number;
  hard: number;
  utilisation: number;
  peakUtilisation: number;
  owner: string;
  escalatedTo: string;
}

export interface LimitBreachesProps extends HTMLAttributes<HTMLDivElement> {
  defaultStatus?: BreachStatusFilter;
  defaultSeverity?: BreachSeverityFilter;
  /** The breach shown in the detail pane at first (e.g. from a notification). */
  defaultBreachId?: string;
  /** Who supervises (the default approver), shown on Request increase. */
  supervisor?: string;
}

/**
 * The breaches blotter (the Breaches board): today's breaches by status
 * and severity, and for the selected one its timeline with Comment,
 * Acknowledge, Request increase, Escalate and Kill switch. Pending
 * increase requests are listed for a supervisor to approve or reject.
 */
export const LimitBreaches = forwardRef<HTMLDivElement, LimitBreachesProps>(
  function LimitBreaches(
    {
      className,
      defaultBreachId,
      defaultSeverity = "all",
      defaultStatus = "open",
      supervisor,
      ...htmlAttributes
    },
    ref,
  ) {
    useLimitsCss();
    const { connectionState, staleProps } = useStaleData();
    const [status, setStatus] = useState<BreachStatusFilter>(defaultStatus);
    const [severity, setSeverity] =
      useState<BreachSeverityFilter>(defaultSeverity);
    const [config, setConfig] = useState(limitBreachesTableConfig);
    const [selectedId, setSelectedId] = useState<string | undefined>(
      defaultBreachId,
    );
    const filter = andFilters(STATUS_FILTER[status], SEVERITY_FILTER[severity]);

    const dataSource = useTradingDataSource("limitBreaches", {
      columns: COLUMNS,
      filterSpec: { filter },
      sort: { sortDefs: [{ column: "openedAt", sortType: "D" }] },
    });
    useEffect(() => {
      dataSource.filter = { filter };
    }, [dataSource, filter]);

    // All of today's breaches, for the counts and the selected one's detail.
    const all = useTradingRows("limitBreaches", {
      columns: COLUMNS,
      rowCount: 5_000,
    });
    const byStatus = useMemo(() => {
      const n = new Map<string, number>();
      for (const row of all.rows) {
        n.set(String(row.status), (n.get(String(row.status)) ?? 0) + 1);
      }
      return n;
    }, [all.rows]);
    const selected = useMemo(() => {
      const row = all.rows.find((r) => r.breachId === selectedId);
      return row ? (row as unknown as Breach) : undefined;
    }, [all.rows, selectedId]);

    const handleSelect = useCallback<TableRowSelectHandler>((row) => {
      setSelectedId(row ? String(row.breachId) : undefined);
    }, []);

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-limit-breaches"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          <ToggleButtonGroup
            aria-label="Status"
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setStatus(e.currentTarget.value as BreachStatusFilter)
            }
            value={status}
          >
            <ToggleButton value="open">
              Open {byStatus.get(BreachStatus.Open) ?? 0}
            </ToggleButton>
            <ToggleButton value="acknowledged">
              Acknowledged {byStatus.get(BreachStatus.Acknowledged) ?? 0}
            </ToggleButton>
            <ToggleButton value="closed">
              Closed {byStatus.get(BreachStatus.Closed) ?? 0}
            </ToggleButton>
            <ToggleButton value="all">All today</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            aria-label="Severity"
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setSeverity(e.currentTarget.value as BreachSeverityFilter)
            }
            value={severity}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="hard">Hard</ToggleButton>
            <ToggleButton value="soft">Soft</ToggleButton>
            <ToggleButton value="warning">Warning</ToggleButton>
          </ToggleButtonGroup>
        </div>
        <PendingRequests connectionState={connectionState} />
        <div className={`${classBase}-split`}>
          <div
            {...staleProps}
            className={cx(`${classBase}-table`, staleProps.className)}
          >
            <Table
              config={config}
              dataSource={dataSource}
              onConfigChange={setConfig}
              onSelect={handleSelect}
              renderBufferSize={20}
              selectionModel="single"
            />
          </div>
          <BreachDetail
            breach={selected}
            connectionState={connectionState}
            dataSource={dataSource}
            supervisor={supervisor}
          />
        </div>
        <div className={`${classBase}-footer`}>
          {all.rows.length} breach{all.rows.length === 1 ? "" : "es"} today · A
          breach closes when the value is back under the level it opened at and
          it has been acknowledged
        </div>
      </div>
    );
  },
);

const EVENT_COLUMNS = [
  "eventId",
  "breachId",
  "time",
  "kind",
  "user",
  "value",
  "text",
];

const BreachDetail = ({
  breach,
  connectionState,
  dataSource,
  supervisor,
}: {
  breach: Breach | undefined;
  connectionState: ReturnType<typeof useStaleData>["connectionState"];
  dataSource: ReturnType<typeof useTradingDataSource>;
  supervisor?: string;
}) => {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"kill" | "increase">();
  const events = useTradingRows("limitBreachEvents", {
    columns: EVENT_COLUMNS,
    filter: `breachId = ${filterString(breach?.breachId ?? "-")}`,
    sort: { sortDefs: [{ column: "time", sortType: "A" }] },
    rowCount: 200,
  });
  const entities = useTradingRows("limitEntities", {
    columns: ["entityId", "entityType", "name", "parentId"],
    rowCount: 2_000,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on another breach
  useEffect(() => {
    setComment("");
    setError("");
  }, [breach?.breachId]);

  if (!breach) {
    return (
      <aside className={`${classBase}-pane`}>
        <p className={`${classBase}-muted`}>
          Select a breach to see its detail.
        </p>
      </aside>
    );
  }

  const send = <N extends RpcName>(rpcName: N, params: RpcRequestParams<N>) =>
    sendTradingRpc(dataSource, rpcName, params, { connectionState })
      .then(() => {
        setComment("");
        setError("");
      })
      .catch((err: unknown) =>
        setError(
          err instanceof TradingRpcError
            ? err.text || err.message
            : String(err),
        ),
      );
  const withComment = comment.trim() ? { comment: comment.trim() } : {};
  const open = breach.status === BreachStatus.Open;
  const closed = breach.status === BreachStatus.Closed;

  const chain: { entityId: string; entityType: string; label: string }[] = [];
  let e = entities.rows.find((r) => r.entityId === breach.entityId);
  while (e && chain.length < 10) {
    const parentId = String(e.parentId ?? "");
    chain.push({
      entityId: String(e.entityId),
      entityType: String(e.entityType),
      label: String(e.name),
    });
    e = parentId
      ? entities.rows.find((r) => r.entityId === parentId)
      : undefined;
  }

  return (
    <aside
      aria-label="Breach detail"
      className={`${classBase}-pane`}
      data-testid="limit-breach-detail"
    >
      <h3>
        <LimitStateBadge state={breach.severity} />{" "}
        {limitLabel(breach.metric, breach.ric)} · {breach.entityId}
      </h3>
      <p className={`${classBase}-muted`}>
        {breach.parentId ? `${breach.parentId} · ` : ""}
        {breach.owner ? `owner of limit: ${breach.owner}` : ""}
        {breach.worst ? ` · worst ${breach.worst}` : ""}
      </p>
      <dl className={`${classBase}-facts`}>
        <dt>Now</dt>
        <dd>
          {formatUtilisation(breach.utilisation)} ·{" "}
          {formatLimitAmount(breach.used)} of {formatLimitAmount(breach.soft)}
        </dd>
        <dt>Peak</dt>
        <dd>
          {formatUtilisation(breach.peakUtilisation)} ·{" "}
          {formatLimitAmount(breach.peak)} at{" "}
          {formatTime(breach.peakAt, { milliseconds: false })}
        </dd>
        <dt>Hard at</dt>
        <dd>
          {breach.soft > 0 ? formatUtilisation(breach.hard / breach.soft) : ""}{" "}
          · {formatLimitAmount(breach.hard)}
        </dd>
        <dt>State</dt>
        <dd>
          {breach.status.toLowerCase()}
          {breach.escalatedTo ? `, escalated to ${breach.escalatedTo}` : ""}
        </dd>
      </dl>
      <ol className={`${classBase}-timeline`} data-testid="breach-timeline">
        {events.rows.map((ev) => (
          <li key={ev.$key}>
            <time>{formatTime(ev.time, { milliseconds: false })}</time>
            <span>
              {String(ev.text || ev.kind)}
              {ev.user && ev.user !== "system" ? (
                <span className={`${classBase}-muted`}>
                  {" "}
                  · {String(ev.user)}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <Input
        bordered
        inputProps={{
          "aria-label": "Comment",
          maxLength: 500,
          onChange: (ev) => setComment(ev.target.value),
          onKeyDown: (ev) => {
            if (ev.key === "Enter" && comment.trim()) {
              send("commentBreach", {
                breachId: breach.breachId,
                comment: comment.trim(),
              });
            }
          },
        }}
        placeholder="Comment"
        value={comment}
      />
      {error ? <p className="tradingLimitsDialog-error">{error}</p> : null}
      <div className={`${classBase}-actions`}>
        <Button
          disabled={!open}
          onClick={() =>
            send("acknowledgeBreach", {
              breachId: breach.breachId,
              ...withComment,
            })
          }
          sentiment="accented"
        >
          Acknowledge
        </Button>
        <Button
          disabled={closed}
          onClick={() => setDialog("increase")}
          sentiment="neutral"
        >
          Request increase…
        </Button>
        <Button
          disabled={closed}
          onClick={() =>
            send("escalateBreach", {
              breachId: breach.breachId,
              ...withComment,
            })
          }
          sentiment="neutral"
        >
          Escalate
        </Button>
        <Button
          disabled={closed || chain.length === 0}
          onClick={() => setDialog("kill")}
          sentiment="negative"
        >
          Kill switch
        </Button>
      </div>
      {dialog === "increase" ? (
        <IncreaseRequestDialog
          approver={supervisor}
          connectionState={connectionState}
          dataSource={dataSource}
          onClose={() => setDialog(undefined)}
          target={{ ...breach, breachId: breach.breachId }}
        />
      ) : null}
      {dialog === "kill" ? (
        <KillSwitchDialog
          breachId={breach.breachId}
          connectionState={connectionState}
          dataSource={dataSource}
          defaultReason={`${limitLabel(breach.metric, breach.ric)} breach (${formatLimitAmount(breach.used)} of ${formatLimitAmount(breach.soft)})`}
          entities={chain}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </aside>
  );
};

/** Pending increase requests the user can see, with Approve / Reject. */
const PendingRequests = ({
  connectionState,
}: {
  connectionState: ReturnType<typeof useStaleData>["connectionState"];
}) => {
  const requests = useTradingRows("limitRequests", {
    columns: [
      "requestId",
      "limitKey",
      "entityId",
      "metric",
      "ric",
      "currentSoft",
      "soft",
      "expiresAt",
      "reason",
      "requestedBy",
      "approver",
      "status",
    ],
    filter: `status = "${LimitRequestStatus.Pending}"`,
  });
  const [error, setError] = useState("");
  if (requests.rows.length === 0) return null;
  const act = (
    rpcName: "approveLimitRequest" | "rejectLimitRequest",
    requestId: string,
  ) =>
    sendTradingRpc(
      requests.dataSource,
      rpcName,
      { requestId },
      { connectionState },
    )
      .then(() => setError(""))
      .catch((err: unknown) =>
        setError(
          err instanceof TradingRpcError
            ? err.text || err.message
            : String(err),
        ),
      );
  return (
    <section aria-label="Increase requests" data-testid="limit-requests">
      {requests.rows.map((r) => (
        <div className={`${classBase}-banner`} key={r.$key}>
          <strong>{String(r.requestId)}</strong>
          <span>
            {limitLabel(r.metric, r.ric)} · {String(r.entityId)}:{" "}
            {formatLimitAmount(r.currentSoft)} to {formatLimitAmount(r.soft)}{" "}
            until {formatTime(r.expiresAt, { milliseconds: false })}
          </span>
          <span className={`${classBase}-muted`}>
            {String(r.reason)} · from {String(r.requestedBy)}
          </span>
          <span className={`${classBase}-spacer`} />
          <Button
            onClick={() => act("rejectLimitRequest", String(r.requestId))}
            sentiment="neutral"
          >
            Reject
          </Button>
          <Button
            onClick={() => act("approveLimitRequest", String(r.requestId))}
            sentiment="accented"
          >
            Approve
          </Button>
        </div>
      ))}
      {error ? <p className="tradingLimitsDialog-error">{error}</p> : null}
    </section>
  );
};
