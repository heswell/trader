/** Generates a self-signed localhost cert for the dev portal server (apps/portal-config/certs). */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dir, "../apps/portal-config/certs");
mkdirSync(dir, { recursive: true });
if (existsSync(resolve(dir, "cert.pem")) && !process.argv.includes("--force")) {
  console.log("certs already exist (use --force to regenerate)");
  process.exit(0);
}
const proc = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "825",
  "-keyout",
  resolve(dir, "key.pem"),
  "-out",
  resolve(dir, "cert.pem"),
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1",
]);
if (proc.exitCode !== 0) {
  console.error(proc.stderr.toString());
  process.exit(1);
}
console.log(`wrote ${dir}/{key,cert}.pem`);
