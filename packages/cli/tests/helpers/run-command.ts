import type { Command } from "commander";

/** Run the real command action and parse its only stdout document. */
export async function run(command: Command, args: string[]) {
  let out = "";
  const write = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    command.exitOverride();
    await command.parseAsync(["node", command.name(), ...args]);
  } finally {
    write.mockRestore();
    error.mockRestore();
  }
  return out ? JSON.parse(out) : null;
}
