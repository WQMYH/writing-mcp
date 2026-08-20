import { measureGoldEvidence } from "./gold-measurement.mjs";
const measurement = await measureGoldEvidence(process.env.WRITING_MCP_PRIVATE_ACCEPTANCE);
for (const gate of measurement.gates) console.error(`[gold:gate] ${gate.pass ? "PASS" : "FAIL"} ${gate.name}`);
console.log(JSON.stringify(measurement, null, 2));
if (measurement.verdict !== "PASS") process.exitCode = 1;
