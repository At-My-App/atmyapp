import * as fs from "node:fs";
import { CliError } from "./errors";

export function lockFile(file: string, message: string): () => void {
  const take = () => {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - fs.lstatSync(file).mtimeMs;
    let active = false;
    try {
      const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        active = true;
      }
    } catch (cause) {
      active = (cause as NodeJS.ErrnoException).code === "EPERM";
    }
    if (active || age < 10 * 60_000) {
      throw new CliError("store_locked", message, {
        fix: "Wait for the current command to finish. If none is running, remove " + file + ".",
      });
    }
    fs.rmSync(file, { force: true });
    take();
  }
  return () => fs.rmSync(file, { force: true });
}
