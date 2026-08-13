#!/usr/bin/env node
import { runStdio } from "./server.js";
runStdio().catch((error)=>{console.error("writing-mcp failed:",error);process.exitCode=1;});
