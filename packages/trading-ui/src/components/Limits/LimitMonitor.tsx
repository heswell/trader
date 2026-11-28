import {
  LIMIT_OVERRIDE_REASON_LABEL,
  LimitEntityType,
  type LimitOverrideReason,
  LimitScope,
  LimitState,
} from "@heswell/trading-schemas";
import { Button, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
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
import { applyGrouping } from "../../data/applyGrouping";
import { sendTradingRpc } from "../../data/tradingRpc";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { useTradingRows } from "../../data/useTradingRows";
import { andFilters, filterString } from "../../utils/filters";
import { useStaleData } from "../StaleIndicator/useStaleData";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import { KillSwitchDialog } from "./KillSwitchDialog";
import {
  IncreaseRequestDialog,
  type IncreaseTarget,
} from "./IncreaseRequestDialog";
import { LimitStateBadge } from "./LimitStateBadge";
import {
  LimitRenderer,
  limitRenderer,
  registerLimitRenderers,
} from "./LimitRenderers";
import {
  familyFilter,
  formatLimitAmount,
  LIMIT_STATE_LABEL,
  type LimitFamily,
  limitLabel,
} from "./limitFormat";

import { useLimitsCss } from "./useLimitsCss";

registerTradingCellRenderers();
registerLimitRenderers();

const classBase = "tradingLimits";

/** Rows the Show toggle keeps. */
export type LimitShow = "all" | "near" | "breached";

const SHOW_FILTER: Record<LimitShow, string> = {
  all: "",
  near: `state in ["${LimitState.Warning}","${LimitState.SoftBreach}","${LimitState.HardBreach}"]`,
  breached: `state in ["${LimitState.SoftBreach}","${LimitState.HardBreach}"]`,
};

const COLUMNS = [
  "limitKey",
  "entityId",
  "entityType",
  "parentId",
  "desk",
  "metric",
  "scope",
  "ric",
  "period",
  "warning",
  "soft",
  "hard",
  "worst",
  "used",
  "headroom",
  "utilisation",
  "state",
  "temporaryUntil",
  "lastUpdate",
];

const amount = {
  name: "number" as const,
  formatting: { decimals: 0, useLocaleString: true },
};

export const limitMonitorTableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    // the group columns (desk, then entity); the tree column is their widths
    // plus 100, so keep them narrow
    { name: "desk", label: "Desk", hidden: true, width: 50 },
    { name: "entityId", label: "Entity", hidden: true, width: 50 },
    {
      name: "metric",
      label: "Limit",
      width: 170,
      type: limitRenderer(LimitRenderer.Metric),
    },
    {
      name: "utilisation",
      label: "Utilisation",
      width: 150,
      type: limitRenderer(LimitRenderer.Utilisation),
    },
    {
      name: "state",
      label: "Status",
      width: 80,
      type: limitRenderer(LimitRenderer.State),
    },
    { name: "used", label: "Used", align: "right", type: amount },
    { name: "soft", label: "Limit", align: "right", type: amount },
    { name: "headroom", label: "Headroom", align: "right", type: amount },
    { name: "worst", label: "Worst", width: 80 },
    { name: "scope", label: "Scope", width: 90 },
    { name: "period", label: "Period", width: 80 },
    {
      name: "lastUpdate",
      label: "Updated",
      width: 90,
      type: { name: "string", renderer: { name: TradingRenderer.Time } },
    },
  ],
};

const GROUP_BY = ["desk", "entityId"];
/** Group rows show their worst utilisation and the most used. */
const AGGREGATIONS = [
  { column: "utilisation", aggType: 4 as const },
  { column: "used", aggType: 4 as const },
];

export interface LimitMonitorProps extends HTMLAttributes<HTMLDivElement> {
  defaultShow?: LimitShow;
  defaultFamily?: LimitFamily;
  /** Show the contributors pane for the selected limit. Default true. */
  showContributors?: boolean;
}

interface SelectedLimit extends IncreaseTarget {
  entityType: string;
  scope: string;
  worst: string;
  state: string;
  parentId: string;
}

const STATE_ORDER = [
  LimitState.HardBreach,
  LimitState.SoftBreach,
  LimitState.Warning,
  LimitState.Ok,
];

/**
 * The limit monitor (the Main board): every limit's live usage as a tree by
 * desk and entity, with utilisation bars, Show and family toggles, state
 * counts, active kill switches, and a contributors pane for the selected
 * limit. Kill switch stops trading for the selected entity.
 */
export const LimitMonitor = forwardRef<HTMLDivElement, LimitMonitorProps>(
  function LimitMonitor(
    {
      className,
      defaultFamily = "all",
      defaultShow = "all",
      showContributors = true,
      ...htmlAttributes
    },
    ref,
  ) {
    useLimitsCss();
    const { connectionState, staleProps } = useStaleData();
    const [show, setShow] = useState<LimitShow>(defaultShow);
    const [family, setFamily] = useState<LimitFamily>(defaultFamily);
    const [config, setConfig] = useState(limitMonitorTableConfig);
    const [selected, setSelected] = useState<SelectedLimit>();
    const [dialog, setDialog] = useState<"kill" | "increase">();
    const filter = andFilters(SHOW_FILTER[show], familyFilter(family));

    const dataSource = useTradingDataSource("limitUtilisation", {
      columns: COLUMNS,
      filterSpec: { filter },
      groupBy: GROUP_BY,
      aggregations: AGGREGATIONS,
      sort: { sortDefs: [{ column: "utilisation", sortType: "D" }] },
    });
    useEffect(() => {
      dataSource.filter = { filter };
    }, [dataSource, filter]);
    useEffect(() => {
      applyGrouping(dataSource, GROUP_BY, AGGREGATIONS);
    }, [dataSource]);

    // Counts per state (unfiltered), entities and active kill switches.
    const states = useTradingRows("limitUtilisation", {
      columns: ["limitKey", "state"],
      rowCount: 5_000,
    });
    const counts = useMemo(() => {
      const n = new Map<string, number>();
      for (const row of states.rows) {
        const state = String(row.state);
        n.set(state, (n.get(state) ?? 0) + 1);
      }
      return n;
    }, [states.rows]);
    const entities = useTradingRows("limitEntities", {
      columns: ["entityId", "entityType", "name", "parentId"],
      rowCount: 2_000,
    });
    const kills = useTradingRows("killSwitches", {
      columns: [
        "entityId",
        "entityType",
        "active",
        "reason",
        "activatedBy",
        "activatedAt",
      ],
      filter: "active = true",
    });

    const entityById = useMemo(
      () => new Map(entities.rows.map((e) => [String(e.entityId), e])),
      [entities.rows],
    );
    /** The entity and those above it, nearest first. */
    const chain = useCallback(
      (entityId: string) => {
        const out: { entityId: string; entityType: string; label: string }[] =
          [];
        let e = entityById.get(entityId);
        while (e && out.length < 10) {
          out.push({
            entityId: String(e.entityId),
            entityType: String(e.entityType),
            label:
              e.entityType === LimitEntityType.Account
                ? `${e.entityId} · ${e.name}`
                : String(e.name),
          });
          e = e.parentId ? entityById.get(String(e.parentId)) : undefined;
        }
        return out;
      },
      [entityById],
    );
    /** Accounts at or below an entity. */
    const accountsUnder = useCallback(
      (entityId: string) =>
        entities.rows
          .filter(
            (e) =>
              e.entityType === LimitEntityType.Account &&
              chain(String(e.entityId)).some((c) => c.entityId === entityId),
          )
          .map((e) => String(e.entityId)),
      [entities.rows, chain],
    );

    const handleSelect = useCallback<TableRowSelectHandler>((row) => {
      if (!row?.isLeaf) {
        setSelected(undefined);
        return;
      }
      const s = (k: string) => String(row[k] ?? "");
      const n = (k: string) => Number(row[k] ?? 0);
      setSelected({
        limitKey: s("limitKey"),
        entityId: s("entityId"),
        entityType: s("entityType"),
        parentId: s("parentId"),
        metric: s("metric"),
        ric: s("ric"),
        scope: s("scope"),
        worst: s("worst"),
        state: s("state"),
        used: n("used"),
        soft: n("soft"),
        hard: n("hard"),
      });
    }, []);

    const release = (entityId: string) =>
      sendTradingRpc(
        dataSource,
        "releaseKillSwitch",
        { entityId },
        { connectionState },
      ).catch(() => undefined);

    return (
      <div
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-testid="trading-limit-monitor"
        ref={ref}
      >
        <div className={`${classBase}-toolbar`}>
          <span className={`${classBase}-label`}>Show</span>
          <ToggleButtonGroup
            aria-label="Show"
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setShow(e.currentTarget.value as LimitShow)
            }
            value={show}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="near">Near limit</ToggleButton>
            <ToggleButton value="breached">Breached</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            aria-label="Limit family"
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              setFamily(e.currentTarget.value as LimitFamily)
            }
            value={family}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="order">Order</ToggleButton>
            <ToggleButton value="position">Position</ToggleButton>
            <ToggleButton value="risk">Risk</ToggleButton>
            <ToggleButton value="pnl">P&amp;L</ToggleButton>
          </ToggleButtonGroup>
          <span className={`${classBase}-spacer`} />
          <Button
            disabled={!selected}
            onClick={() => setDialog("increase")}
            sentiment="neutral"
          >
            Request increase…
          </Button>
          <Button
            disabled={!selected || connectionState !== "connected"}
            onClick={() => setDialog("kill")}
            sentiment="negative"
          >
            Kill switch
          </Button>
        </div>
        {kills.rows.map((k) => (
          <div
            className={`${classBase}-banner`}
            data-testid="kill-switch-banner"
            key={k.$key}
          >
            <strong>Trading stopped: {String(k.entityId)}</strong>
            <span className={`${classBase}-muted`}>
              {String(k.reason)} · by {String(k.activatedBy)}
            </span>
            <span className={`${classBase}-spacer`} />
            <Button
              appearance="bordered"
              onClick={() => release(String(k.entityId))}
              sentiment="neutral"
            >
              Turn trading back on
            </Button>
          </div>
        ))}
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
          {showContributors ? (
            <Contributors
              accounts={selected ? accountsUnder(selected.entityId) : []}
              limit={selected}
            />
          ) : null}
        </div>
        <div className={`${classBase}-footer`} data-testid="limit-state-counts">
          {STATE_ORDER.map((state) => (
            <span className={`${classBase}-chip`} key={state}>
              <LimitStateBadge state={state} />
              {counts.get(state) ?? 0}
            </span>
          ))}
          <span className={`${classBase}-spacer`} />
          <span>Ticks: warning · limit 100% · dotted = hard limit</span>
        </div>
        {dialog === "kill" && selected ? (
          <KillSwitchDialog
            connectionState={connectionState}
            dataSource={dataSource}
            entities={chain(selected.entityId)}
            onClose={() => setDialog(undefined)}
          />
        ) : null}
        {dialog === "increase" && selected ? (
          <IncreaseRequestDialog
            connectionState={connectionState}
            dataSource={dataSource}
            onClose={() => setDialog(undefined)}
            target={selected}
          />
        ) : null}
      </div>
    );
  },
);

const positionColumns: TableConfig = {
  columnDefaultWidth: 90,
  columns: [
    { name: "account", label: "Account", width: 90 },
    { name: "ric", label: "RIC", width: 80 },
    {
      name: "quantity",
      label: "Qty",
      align: "right",
      type: { name: "number", formatting: { useLocaleString: true } },
    },
    {
      name: "marketValueUsd",
      label: "Notional USD",
      align: "right",
      type: amount,
    },
    {
      name: "totalPnlUsd",
      label: "P&L USD",
      align: "right",
      type: { name: "number", renderer: { name: TradingRenderer.Pnl } },
    },
  ],
};

const orderColumns: TableConfig = {
  columnDefaultWidth: 80,
  columns: [
    { name: "orderId", label: "Order", width: 70 },
    { name: "account", label: "Account", width: 90 },
    { name: "ric", label: "RIC", width: 70 },
    {
      name: "side",
      label: "Side",
      width: 50,
      type: { name: "string", renderer: { name: TradingRenderer.Side } },
    },
    {
      name: "leavesQty",
      label: "Leaves",
      align: "right",
      type: { name: "number", formatting: { useLocaleString: true } },
    },
    { name: "price", label: "Price", align: "right" },
  ],
};

const listFilter = (column: string, values: readonly string[]) =>
  values.length === 0
    ? `${column} = "-"`
    : `${column} in [${values.map(filterString).join(",")}]`;

/** A per-RIC or per-underlying limit names the RIC it is about. */
const ricOf = (limit: SelectedLimit) =>
  limit.ric ||
  (limit.scope === LimitScope.PerRic || limit.scope === LimitScope.Underlying
    ? limit.worst
    : "");

const timeOf = (ms: unknown) =>
  typeof ms === "number" && ms > 0
    ? new Date(ms).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/**
 * Orders sent over the selected limit with a reason (limitOverrides): the
 * accounts it covers, its metric (and RIC), latest first.
 */
const Overrides = ({
  accounts,
  limit,
  ric,
}: {
  accounts: string[];
  limit: SelectedLimit;
  ric: string;
}) => {
  const filter = andFilters(
    listFilter("account", accounts),
    `metric = ${filterString(limit.metric)}`,
    ric && limit.scope === LimitScope.PerRic
      ? `ric = ${filterString(ric)}`
      : "",
  );
  const { rows } = useTradingRows("limitOverrides", {
    columns: [
      "overrideId",
      "time",
      "user",
      "account",
      "ric",
      "side",
      "quantity",
      "utilisation",
      "reason",
      "note",
    ],
    filter,
    sort: { sortDefs: [{ column: "time", sortType: "D" }] },
    rowCount: 20,
  });
  return (
    <>
      <span className={`${classBase}-label`}>Overrides</span>
      {rows.length === 0 ? (
        <p className={`${classBase}-muted`}>No orders sent over this limit.</p>
      ) : (
        <ul className={`${classBase}-overrides`}>
          {rows.map((row) => (
            <li key={String(row.overrideId)}>
              <time>{timeOf(row.time)}</time>
              <span>
                <b>
                  {String(row.side) === "BUY" ? "Buy" : "Sell"}{" "}
                  {Number(row.quantity).toLocaleString("en-GB")}{" "}
                  {String(row.ric)}
                </b>{" "}
                · {String(row.account)} · {String(row.user)} ·{" "}
                {Math.round(Number(row.utilisation))}%
                <br />
                <span className={`${classBase}-muted`}>
                  {LIMIT_OVERRIDE_REASON_LABEL[
                    row.reason as LimitOverrideReason
                  ] ?? String(row.reason)}
                  {row.note ? ` · ${String(row.note)}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * What uses the selected limit: the positions and working orders of the
 * accounts it covers (in its RIC or underlying, for one that is per RIC),
 * and the orders sent over it with an override.
 */
const Contributors = ({
  accounts,
  limit,
}: {
  accounts: string[];
  limit: SelectedLimit | undefined;
}) => {
  const ric = limit ? ricOf(limit) : "";
  const underlying = limit?.scope === LimitScope.Underlying;
  const positionsFilter = andFilters(
    listFilter("account", accounts),
    ric ? `${underlying ? "underlying" : "ric"} = ${filterString(ric)}` : "",
  );
  const ordersFilter = andFilters(
    listFilter("account", accounts),
    ric && !underlying ? `ric = ${filterString(ric)}` : "",
    "leavesQty > 0",
  );
  const positions = useTradingDataSource("positions", {
    columns: [
      "id",
      "account",
      "ric",
      "underlying",
      "quantity",
      "marketValueUsd",
      "totalPnlUsd",
      "currency",
    ],
    filterSpec: { filter: positionsFilter },
  });
  const orders = useTradingDataSource("parentOrders", {
    columns: [
      "orderId",
      "account",
      "ric",
      "side",
      "leavesQty",
      "price",
      "status",
    ],
    filterSpec: { filter: ordersFilter },
  });
  useEffect(() => {
    positions.filter = { filter: positionsFilter };
  }, [positions, positionsFilter]);
  useEffect(() => {
    orders.filter = { filter: ordersFilter };
  }, [orders, ordersFilter]);

  return (
    <aside
      aria-label="Contributors"
      className={`${classBase}-pane`}
      data-testid="limit-contributors"
    >
      <h3>Contributors</h3>
      {limit ? (
        <>
          <p className={`${classBase}-muted`}>
            {limit.entityId} · {limitLabel(limit.metric, ric)} ·{" "}
            {formatLimitAmount(limit.used)} of {formatLimitAmount(limit.soft)}{" "}
            {LIMIT_STATE_LABEL[limit.state] ?? ""}
          </p>
          <div style={{ height: 180 }}>
            <Table config={positionColumns} dataSource={positions} />
          </div>
          <span className={`${classBase}-label`}>Working orders</span>
          <div style={{ height: 160 }}>
            <Table config={orderColumns} dataSource={orders} />
          </div>
          <Overrides accounts={accounts} limit={limit} ric={ric} />
        </>
      ) : (
        <p className={`${classBase}-muted`}>
          Select a limit to see the positions and orders that use it.
        </p>
      )}
    </aside>
  );
};
