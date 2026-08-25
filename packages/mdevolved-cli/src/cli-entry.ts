#!/usr/bin/env node
import { main } from "./cli.js";

const exitCode = await main();
if (exitCode !== 0) process.exitCode = exitCode;
