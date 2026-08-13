"use strict";

const path = require("node:path");
const packageJson = require("./package.json");
const metadata = packageJson.__claudepp;

if (!metadata?.originalMain || !metadata?.userRoot) {
  throw new Error("Claude++ loader metadata is missing");
}

process.env.CLAUDE_PLUSPLUS_USER_ROOT = metadata.userRoot;
process.env.CLAUDE_PLUSPLUS_RUNTIME = path.join(metadata.userRoot, "runtime");

try {
  require(path.join(process.env.CLAUDE_PLUSPLUS_RUNTIME, "main.js"));
} catch (error) {
  process.stderr.write(`[Claude++ loader] Runtime failed: ${error?.stack ?? error}\n`);
}

module.exports = require(path.join(__dirname, metadata.originalMain));
