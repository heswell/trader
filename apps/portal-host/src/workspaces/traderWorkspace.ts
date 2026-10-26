import type { NamedWorkspaceDefinitionV1 } from "@vuu-ui/core";

/** Id of the Trader system workspace: routed at /workspaces/trader. */
export const TRADER_WORKSPACE_ID = "trader";

type JsonProps = { [key: string]: string | boolean };

interface Panel {
  /** Item and component id: keys the item's saved state (link groups). */
  id: string;
  /** Portal module name (apps/features/trading/src/catalog.ts). */
  module: string;
  title: string;
  /** Props for the module's component (e.g. `defaultLinkGroup`). */
  props?: JsonProps;
  /** 1-based grid lines. */
  column: { start: number; span: number };
  row: { start: number; span: number };
}

/*
 * Three columns (1.4 : 1 : 1). Rows are shared, so their boundaries are
 * those of every column's split: left 1:1 (0.5), middle 1:1.5 (0.4), right
 * 2:1 (0.667) give 0.4 / 0.1 / 0.167 / 0.333 = 12fr 3fr 5fr 10fr.
 */
const COLUMNS = ["7fr", "5fr", "5fr"];
const ROWS = ["12fr", "3fr", "5fr", "10fr"];

const left = { start: 1, span: 1 };
const middle = { start: 2, span: 1 };
const right = { start: 3, span: 1 };

/*
 * Link groups: red follows the instruments grid (orders, fills, ticket and
 * the market panels), green follows the ladder's picker (ladder, tape,
 * positions). Each module's own default group is the one it has here, so
 * only the ladder needs props (its picker).
 */
const PANELS: readonly Panel[] = [
  {
    id: "trader-instruments",
    module: "TradingWatchlist",
    title: "Instruments",
    column: left,
    row: { start: 1, span: 2 },
  },
  {
    id: "trader-orders",
    module: "TradingOrders",
    title: "Orders",
    column: left,
    row: { start: 3, span: 2 },
  },
  {
    id: "trader-fills",
    module: "TradingFills",
    title: "Fills",
    column: left,
    row: { start: 3, span: 2 },
  },
  {
    id: "trader-positions",
    module: "TradingPositions",
    title: "Positions",
    column: left,
    row: { start: 3, span: 2 },
  },
  {
    id: "trader-ticket",
    module: "TradingTicket",
    title: "Ticket",
    column: middle,
    row: { start: 1, span: 1 },
  },
  {
    id: "trader-chart",
    module: "TradingChart",
    title: "Chart",
    column: middle,
    row: { start: 2, span: 3 },
  },
  {
    id: "trader-depth",
    module: "TradingDepth",
    title: "Depth",
    column: middle,
    row: { start: 2, span: 3 },
  },
  {
    id: "trader-depth-chart",
    module: "TradingDepthChart",
    title: "Depth chart",
    column: middle,
    row: { start: 2, span: 3 },
  },
  {
    id: "trader-ladder",
    module: "TradingLadder",
    title: "Ladder",
    props: { showInstrumentPicker: true },
    column: right,
    row: { start: 1, span: 3 },
  },
  {
    id: "trader-tape",
    module: "TradingTape",
    title: "Tape",
    column: right,
    row: { start: 4, span: 1 },
  },
];

const STACKS = [
  {
    id: "trader-blotters",
    itemIds: ["trader-orders", "trader-fills", "trader-positions"],
    selectedItemId: "trader-orders",
  },
  {
    id: "trader-market",
    itemIds: ["trader-chart", "trader-depth", "trader-depth-chart"],
    selectedItemId: "trader-chart",
  },
];

/** Date of the current default layout. */
const UPDATED_AT = "2026-10-25T00:00:00.000Z";

/**
 * The Trader system workspace: a v2 GridLayoutDocument of `portal-module`
 * items. Users edit a personal copy (same id) and can reset it to this.
 * Panels whose module the user can't open (ticket and ladder need
 * trading-execute) render the portal's "not available" message.
 */
export const TRADER_WORKSPACE: NamedWorkspaceDefinitionV1 = {
  version: 1,
  id: TRADER_WORKSPACE_ID,
  name: "Trader",
  description:
    "Instruments, blotters, ticket, charts, depth, ladder and tape with red / green link groups",
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
  snapshot: {
    version: 1,
    componentState: {},
    layout: {
      kind: "grid-layout",
      version: 2,
      components: PANELS.map(({ id, module, props }) => {
        const settings: { [key: string]: string | JsonProps } = {
          moduleId: module,
        };
        if (props) settings.props = props;
        return { id, type: "portal-module", version: 1, settings };
      }),
      layout: {
        id: "trader-workspace",
        columns: COLUMNS,
        rows: ROWS,
        items: PANELS.map(({ id, title, column, row }) => ({
          id,
          title,
          column,
          row,
          dropTarget: true,
          header: true,
          resizeable: "hv" as const,
        })),
        stacks: STACKS,
        placeholderIds: [],
      },
    },
  },
};

/** The portal's system workspaces. */
export const SYSTEM_WORKSPACES: readonly NamedWorkspaceDefinitionV1[] = [
  TRADER_WORKSPACE,
];
