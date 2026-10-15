import { readFileSync, rmSync, writeFileSync } from "node:fs";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Pid of the live process (not this one) holding `path`, if any. */
export const lockHolder = (path: string): number | undefined => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return pid && pid !== process.pid && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Take a pid lock file so two live processes never share a store. A lock
 * left by a dead process (kill -9) is taken over.
 */
export const acquireLock = (path: string, what: string) => {
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = lockHolder(path);
    if (pid !== undefined) {
      throw Error(
        `persistence ${what} is in use by process ${pid} (remove ${path} if that is wrong)`,
      );
    }
    writeFileSync(path, String(process.pid));
  }
  return () => rmSync(path, { force: true });
};
