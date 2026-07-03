#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "./app.ts";
import { runCliApp } from "./cli.ts";

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  realpathSync(entryPath) === fileURLToPath(import.meta.url)
) {
  await runCliApp(app, process.argv.slice(2));
}
