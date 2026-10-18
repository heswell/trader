// @vuu-ui/vuu-chart 4.0.0-alpha.22 ships JavaScript only (no .d.ts), see
// trader upstream issue 94. These declarations cover the subset of the API
// trading-ui uses, transcribed from the package README and chart models.
// Remove this file when the package publishes its own types.
declare module "@vuu-ui/vuu-chart" {
  import type { DataSource } from "@vuu-ui/vuu-data-types";
  import type { ColumnMap } from "@vuu-ui/vuu-utils";
  import type { CSSProperties, ReactElement } from "react";

  export type ChartRow = readonly unknown[];

  /** A css colour, "up" / "down", or a palette slot "palette-1".."palette-8". */
  export type ChartColor = string;

  export type ChartLegendPosition = "top" | "bottom" | "none";
  export type ChartDataZoom = boolean | "inside" | "slider" | "both";
  export type ChartAggregation =
    | "sum"
    | "avg"
    | "min"
    | "max"
    | "last"
    | "count";

  export type MarkLineValue =
    | number
    | "last"
    | "min"
    | "max"
    | "average"
    | { weightedAverage: string };

  export interface MarkLineDef {
    value: MarkLineValue;
    label?: string;
    color?: ChartColor;
    lineType?: "solid" | "dashed" | "dotted";
    /** echarts markLine label position (default "insideEndTop"). */
    labelPosition?: string;
  }

  export interface ColorBy {
    columnName: string;
    colors: Record<string, ChartColor>;
    defaultColor?: ChartColor;
  }

  export type RowFilter =
    | Record<string, unknown>
    | ((row: ChartRow, columnMap: ColumnMap) => boolean);

  export interface ChartItemEvent {
    columnMap: ColumnMap;
    dataIndex: number;
    dataSource: DataSource;
    groupPath?: string[];
    nativeEvent?: MouseEvent;
    row?: ChartRow;
    rows?: ChartRow[];
    seriesId: string;
    seriesName: string;
    value: unknown;
  }

  // biome-ignore lint/suspicious/noExplicitAny: echarts option objects are untyped here
  export type EChartsOption = Record<string, any>;

  export interface VuuChartBaseProps {
    className?: string;
    /** Merged over (object) or transforms (function) the generated option. */
    echartsOptions?: EChartsOption | ((option: EChartsOption) => EChartsOption);
    id?: string;
    /** Rows read per DataSource (default 1000). */
    maxRows?: number;
    // biome-ignore lint/suspicious/noExplicitAny: echarts instance
    onChartReady?: (chart: any) => void;
    onItemClick?: (event: ChartItemEvent) => void;
    onItemContextMenu?: (event: ChartItemEvent) => void;
    renderer?: "canvas" | "svg";
    showTooltip?: boolean;
    style?: CSSProperties;
    theme?: Record<string, unknown>;
    "aria-label"?: string;
    role?: string;
    "data-testid"?: string;
  }

  export interface CandlestickOverlay {
    type: "line" | "scatter";
    columnName: string;
    id?: string;
    name?: string;
    dataSource?: DataSource;
    timeColumnName?: string;
    where?: RowFilter;
    color?: ChartColor;
    colorBy?: ColorBy;
    symbol?: string;
    symbolSize?: number;
    markLines?: MarkLineDef[];
  }

  export interface CandlestickChartProps extends VuuChartBaseProps {
    crosshair?: boolean;
    dataSource: DataSource;
    dataZoom?: ChartDataZoom;
    formatTime?: (ts: number) => string;
    legend?: ChartLegendPosition;
    markLines?: MarkLineDef[];
    ohlcColumnNames?: {
      open?: string;
      high?: string;
      low?: string;
      close?: string;
    };
    overlays?: CandlestickOverlay[];
    timeColumnName?: string;
    volumeColumnName?: string;
    volumePaneHeight?: number;
    xAxisType?: "category" | "time";
  }

  export interface DepthChartProps extends VuuChartBaseProps {
    askValue?: string;
    bidValue?: string;
    cumulativeSizeColumnName?: string;
    dataSource: DataSource;
    legend?: ChartLegendPosition;
    priceColumnName?: string;
    showMidPrice?: boolean;
    sideColumnName?: string;
    sizeColumnName?: string;
  }

  export interface CartesianSeries {
    type: "line" | "area" | "bar" | "scatter";
    columnName: string;
    id?: string;
    name?: string;
    dataSource?: DataSource;
    xColumnName?: string;
    yAxisIndex?: number;
    stack?: string;
    step?: false | "start" | "middle" | "end";
    smooth?: boolean;
    showSymbol?: boolean;
    symbolSize?: number;
    areaOpacity?: number;
    color?: ChartColor;
    colorBy?: ColorBy;
    where?: RowFilter;
    markLines?: MarkLineDef[];
  }

  export interface CartesianAxis {
    columnName: string;
    name?: string;
    type?: "category" | "time" | "value";
  }

  export interface CartesianValueAxis {
    name?: string;
    type?: "value" | "log";
    position?: "left" | "right" | "top" | "bottom";
    scale?: boolean;
    min?: number;
    max?: number;
  }

  export interface CartesianChartProps extends VuuChartBaseProps {
    aggregation?: ChartAggregation;
    crosshair?: boolean;
    dataSource: DataSource;
    dataZoom?: ChartDataZoom;
    legend?: ChartLegendPosition;
    orientation?: "vertical" | "horizontal";
    series: CartesianSeries[];
    xAxis: CartesianAxis;
    yAxes?: CartesianValueAxis[];
  }

  export interface HeatmapAxis {
    columnName: string;
    name?: string;
    type?: "category" | "time" | "value";
    bucketSize?: number;
  }

  export interface HeatmapChartProps extends VuuChartBaseProps {
    aggregation?: ChartAggregation;
    colorScale?: "sequential" | "diverging";
    dataSource: DataSource;
    dataZoom?: ChartDataZoom;
    formatTime?: (ts: number) => string;
    max?: number;
    min?: number;
    showVisualMap?: boolean;
    valueColumnName: string;
    where?: RowFilter;
    xAxis: HeatmapAxis;
    yAxis: HeatmapAxis;
  }

  export interface HierarchyChartProps extends VuuChartBaseProps {
    aggregation?: ChartAggregation;
    colorMode?: "palette" | "sign";
    dataSource: DataSource;
    donut?: boolean;
    formatValue?: (value: number) => string;
    groupByColumnNames: string[];
    legend?: ChartLegendPosition;
    valueColumnName: string;
    where?: RowFilter;
  }

  export const CandlestickChart: (props: CandlestickChartProps) => ReactElement;
  export const DepthChart: (props: DepthChartProps) => ReactElement;
  export const CartesianChart: (props: CartesianChartProps) => ReactElement;
  export const HeatmapChart: (props: HeatmapChartProps) => ReactElement;
  export const TreemapChart: (props: HierarchyChartProps) => ReactElement;
  export const SunburstChart: (props: HierarchyChartProps) => ReactElement;
  export const PieChart: (
    props: Omit<HierarchyChartProps, "groupByColumnNames"> & {
      groupByColumnNames: string[];
    },
  ) => ReactElement;
}
