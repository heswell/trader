# Alternative to `bun run start:all` for overmind / foreman / honcho.
# First: `bun run start:all --prepare` (certs, builds, generated server configs)
# and a Keycloak with the "vuu" realm (`docker compose up -d keycloak`).
portal: VUU_CONFIG_FILE=apps/portal-config/application.stack.conf bun ./apps/portal-config/src/start-portal.ts
trading: VUU_CONFIG_FILE=apps/portal-config/application.trading.stack.conf bun ./apps/portal-config/src/start-trading.ts
features: bun ./scripts/stack/serve.ts features
host: bun ./scripts/stack/serve.ts host
