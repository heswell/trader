# Alternative to `bun run start:all` for overmind / foreman / honcho.
# First: `bun run start:all --prepare` (certs, builds, generated portal module
# list) and a Keycloak with the "vuu" realm (`docker compose up -d keycloak`).
# portal / trading are the stock entries (vuu-portal main, @heswell/oms/main)
# with ports / origins from the TRADER_* settings (scripts/stack/serve.ts).
portal: bun ./scripts/stack/serve.ts portal
trading: bun ./scripts/stack/serve.ts trading
features: bun ./scripts/stack/serve.ts features
host: bun ./scripts/stack/serve.ts host
