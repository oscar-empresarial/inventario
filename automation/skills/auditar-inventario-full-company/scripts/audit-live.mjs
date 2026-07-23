import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditState, buildMarkdownReport } from "./auditor-core.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function fetchJson(apiUrl, action, extra = {}) {
  const url = new URL(apiUrl);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(extra)) {
    if (value != null) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${action}: HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action}: el servidor no devolvió JSON válido`);
  }
}

async function loadSnapshot(directory) {
  const names = ["ping", "inventario", "conciliacion", "revision", "registros"];
  const entries = await Promise.all(
    names.map(async (name) => [name, await readJson(path.join(directory, `${name}.json`))]),
  );
  return Object.fromEntries(entries);
}

async function loadLive(apiUrl, config) {
  const today = new Date().toISOString().slice(0, 10);
  const [ping, inventario, conciliacion, revision, registros] = await Promise.all([
    fetchJson(apiUrl, "ping"),
    fetchJson(apiUrl, "inventario"),
    fetchJson(apiUrl, "conciliacion"),
    fetchJson(apiUrl, "revision"),
    fetchJson(apiUrl, "registros", {
      desde: config.recordsFrom || "2020-01-01",
      hasta: today,
    }),
  ]);
  return { ping, inventario, conciliacion, revision, registros };
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(
  args.config || path.join(scriptDir, "..", "references", "default-config.json"),
);
const bomsPath = path.resolve(
  args.boms || path.join(scriptDir, "..", "references", "boms-provisionales.json"),
);
const config = await readJson(configPath);
const bomCatalog = await readJson(bomsPath);
const apiUrl = args.api || config.apiUrl;

if (config.policy?.readOnly !== true) {
  throw new Error("La configuración debe declarar policy.readOnly=true.");
}

const state = args.snapshot
  ? await loadSnapshot(path.resolve(args.snapshot))
  : await loadLive(apiUrl, config);
const report = auditState(state, config, bomCatalog);
const markdown = buildMarkdownReport(report);
const outputDir = path.resolve(args.out || path.join(process.cwd(), "reports"));
await fs.mkdir(outputDir, { recursive: true });

const stamp = report.generatedAt
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z")
  .replace("T", "-");
const markdownPath = path.join(outputDir, `auditoria-${stamp}.md`);
const jsonPath = path.join(outputDir, `auditoria-${stamp}.json`);
await Promise.all([
  fs.writeFile(markdownPath, markdown, "utf8"),
  fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8"),
]);

console.log(
  JSON.stringify(
    {
      mode: report.mode,
      summary: report.summary,
      markdownPath,
      jsonPath,
    },
    null,
    2,
  ),
);
