// Jest setup file to configure test environment
process.env.NODE_ENV = "test";

// Disable actual worker threads in tests
process.env.DISABLE_WORKERS = "true";

// Operation IDs (runtime/operations.ts) go to a throwaway folder, never the user's config.
{
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  process.env.ATMYAPP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atmyapp-state-"));
}
