#!/usr/bin/env node
import { assertLocalConfig } from "./opensource-isolation.mjs";

assertLocalConfig();
console.log("[prepare-config] Keeping local isolation targets; environment overrides are ignored.");
