/**
 * The METRICS table writer without vuu-server, for engine-local tables
 * (e.g. @heswell/trading-test-data in the browser). The server module is in
 * `@heswell/trading-metrics/server`.
 */
export * from "./server/MetricsTablePublisher";
