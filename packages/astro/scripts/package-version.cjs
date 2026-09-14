const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
fs.writeFileSync(
  path.join(root, "src/packageVersion.ts"),
  `// Generated from package.json during build.\nexport const ASTRO_SDK_VERSION = ${JSON.stringify(version)};\n`,
);
