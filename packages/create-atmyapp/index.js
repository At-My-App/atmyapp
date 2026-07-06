#!/usr/bin/env node

const { runCreateAtMyApp } = require("@atmyapp/cli/create");

runCreateAtMyApp().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
