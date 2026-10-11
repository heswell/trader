// Plain CommonJS so it runs under npm/yarn/pnpm (node) as well as bun.
const agent = process.env.npm_config_user_agent ?? "";
if (!agent.startsWith("bun")) {
  console.error(
    "\nThis repo supports `bun install` only (npm, yarn and pnpm are not supported).\n" +
      "Use bun >= 1.3: https://bun.sh\n",
  );
  process.exit(1);
}
