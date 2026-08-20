import { readFile } from "node:fs/promises";
import { measureGoldEvidence, goldSnapshot } from "./gold-measurement.mjs";
const measurement = await measureGoldEvidence(process.env.WRITING_MCP_PRIVATE_ACCEPTANCE);
const baseline = JSON.parse(await readFile(new URL("../reports/gold-evidence-baseline.json", import.meta.url), "utf8"));
const candidate = goldSnapshot(measurement, null);
const fields = ["recallAt5", "recallAt10", "recallAt50", "mrr", "requiredRecallAt50"];
const regressions = ["train", "holdout"].flatMap((split) => fields.filter((field) => candidate[split][field] < baseline[split][field]).map((field) => `${split}.${field}`));
console.log(JSON.stringify({ candidate, regressions }, null, 2));
if (measurement.verdict !== "PASS" || regressions.length) process.exitCode = 1;
