#!/usr/bin/env node
/** MCP entry: load ~/.contextmind/profile.json then start context-compress. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(join(root, "contextmind/lib/llm-profile.mjs")).href);
await import(pathToFileURL(join(root, "context-compress-main/dist/index.js")).href);
