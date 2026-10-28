#!/usr/bin/env node
/**
 * Release gate: fail on any high or critical advisory in the production
 * dependency tree, except the specific advisories accepted below.
 *
 * This replaces a bare `npm audit --omit=dev --audit-level=high`, which cannot
 * ignore an advisory that has no compatible fix. The level is NOT lowered: a new
 * high or critical advisory still blocks a release, and so does an audit that
 * could not be run or read.
 *
 * Accepting an advisory is a decision with a reason and a way out, not a mute
 * button. Add an entry only with both, and delete it once the dependency is
 * upgraded — the script says so when an entry stops matching anything.
 */
import { spawnSync } from "node:child_process";

const ACCEPTED = new Map([
  [
    "GHSA-mrhx-c7xc-m3w5",
    "zod <4.6.6: memory exhaustion validating oversized constrained collections. " +
      "The only fix is zod 4, a major upgrade across every schema in the app " +
      "(accepted 2026-10-28; upgrade zod, then delete this entry).",
  ],
  [
    "GHSA-xcx6-jx8p-x3h5",
    "@azure/msal-node <=7.0.2 (via @azure/identity): authorization-code-flow " +
      "parameter disclosure. The app only uses DefaultAzureCredential for managed-identity " +
      "storage access (src/lib/storage.ts), never that flow; @azure/identity still pins " +
      "msal-node ^6 (accepted 2026-10-28; delete this entry when identity moves to a fixed msal-node).",
  ],
]);

const BLOCKING = new Set(["high", "critical"]);

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("audit-gate: could not read `npm audit` output, so the gate fails closed.");
  console.error(result.stderr || result.stdout || "(no output)");
  process.exit(1);
}
if (report.error) {
  console.error(`audit-gate: npm audit failed (${report.error.code ?? "error"}): ${report.error.summary ?? ""}`);
  process.exit(1);
}

// Every advisory appears once as an object in the `via` list of the package it
// is about; transitive dependents only carry the package name as a string.
const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via !== "object" || !via.url) continue;
    advisories.set(via.url.split("/").pop(), via);
  }
}

const blocking = [];
const accepted = [];
for (const [id, advisory] of advisories) {
  if (!BLOCKING.has(advisory.severity)) continue;
  (ACCEPTED.has(id) ? accepted : blocking).push([id, advisory]);
}

for (const [id, advisory] of accepted) {
  console.log(`audit-gate: ACCEPTED ${id} (${advisory.severity}) ${advisory.name}: ${ACCEPTED.get(id)}`);
}
for (const id of ACCEPTED.keys()) {
  if (!advisories.has(id)) {
    console.log(`audit-gate: ${id} no longer matches anything — delete it from ACCEPTED in scripts/audit-gate.mjs.`);
  }
}

if (blocking.length > 0) {
  for (const [id, advisory] of blocking) {
    console.error(`audit-gate: BLOCKING ${id} (${advisory.severity}) ${advisory.name}: ${advisory.title}\n  ${advisory.url}`);
  }
  console.error(`audit-gate: ${blocking.length} high/critical advisor${blocking.length === 1 ? "y" : "ies"} not accepted.`);
  process.exit(1);
}
console.log("audit-gate: no unaccepted high or critical advisories.");
