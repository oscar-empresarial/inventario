import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [sourcePath, requestedOutputPath] = process.argv.slice(2);
if (!sourcePath) {
  throw new Error("Uso: node extract-boms.mjs <Costos.xlsx> [salida.json]");
}

const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const parseNdjson = (ndjson) =>
  String(ndjson ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? "").trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
};

const normalizeUnit = (unit) => {
  const value = normalize(unit);
  if (/^(l|lt|lts|litro|litros)$/.test(value)) return "L";
  if (/^(ml|mililitro|mililitros)$/.test(value)) return "mL";
  if (/^(kg|kilo|kilos|kilogramo|kilogramos)$/.test(value)) return "kg";
  if (/^(g|gr|gramo|gramos)$/.test(value)) return "g";
  if (/^(und|unidad|unidades)$/.test(value)) return "und";
  if (/^(hora|horas)$/.test(value)) return "h";
  return String(unit ?? "").trim();
};

const parseTarget = (title) => {
  const match = normalize(title).match(
    /(\d+(?:[.,]\d+)?)\s*(litros?|lts?|lt|l|kilogramos?|kilos?|kg|gramos?|gr|g)\b/,
  );
  if (!match) return null;
  return {
    quantity: Number(match[1].replace(",", ".")),
    unit: normalizeUnit(match[2]),
  };
};

const excludedSheets = new Set(
  [
    "costos",
    "subs 2",
    "subs",
    "resumen",
    "materias primas",
    "envases",
    "bases",
  ].map(normalize),
);

const excludedComponents =
  /^(envase|enase|galon(?:es)?|pimpina|etiqueta|mano de obra|costo|total)/;

const sourceBytes = await fs.readFile(sourcePath);
const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
const input = await FileBlob.load(sourcePath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheetSummary = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 30000,
});
const sheetNames = parseNdjson(sheetSummary.ndjson)
  .filter((record) => record.kind === "sheet")
  .map((record) => record.name);

const boms = [];
for (const sheetName of sheetNames) {
  if (excludedSheets.has(normalize(sheetName))) continue;

  const tableResult = await workbook.inspect({
    kind: "table",
    sheetId: sheetName,
    range: "A1:E25",
    maxChars: 24000,
    tableMaxRows: 25,
    tableMaxCols: 5,
    tableMaxCellChars: 120,
  });
  const table = parseNdjson(tableResult.ndjson).find(
    (record) => record.kind === "table" && Array.isArray(record.values),
  );
  if (!table) continue;

  const rows = table.values;
  const title = String(rows.find((row) => row?.[0])?.[0] ?? sheetName).trim();
  const headerIndex = rows.findIndex((row) => {
    const first = normalize(row?.[0]);
    const second = normalize(row?.[1]);
    return (
      (first === "nombre" ||
        first === "insumo" ||
        first.includes("materia prima")) &&
      second.includes("cantidad")
    );
  });
  if (headerIndex < 0) continue;

  const components = [];
  let started = false;
  for (const row of rows.slice(headerIndex + 1)) {
    const name = String(row?.[0] ?? "").trim();
    const quantity = parseNumber(row?.[1]);
    const unit = normalizeUnit(row?.[2]);

    if (!name && !started) continue;
    if (!name && started) break;
    if (excludedComponents.test(normalize(name))) {
      if (started) break;
      continue;
    }
    if (quantity == null || quantity <= 0 || !unit) {
      if (started) break;
      continue;
    }

    started = true;
    components.push({ item: name, quantity, unit });
  }

  if (components.length < 1) continue;
  const target = parseTarget(title);
  boms.push({
    product: sheetName,
    title,
    target,
    components,
    status: "PROVISIONAL_PENDIENTE_VALIDACION",
    source: {
      workbook: path.basename(sourcePath),
      sheet: sheetName,
      range: table.address,
    },
  });
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  policy: {
    authoritativeForBlocking: false,
    notes:
      "Extracción inicial para alertas. Validar cada receta y definir mermas antes de usar como control obligatorio.",
  },
  source: {
    path: sourcePath,
    sha256: sourceHash,
  },
  boms,
};

const outputPath = path.resolve(requestedOutputPath || "boms-provisionales.json");
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      sheets: sheetNames.length,
      boms: boms.length,
      incompleteTargets: boms.filter((bom) => !bom.target).length,
      lowComponentCount: boms.filter((bom) => bom.components.length < 2).length,
    },
    null,
    2,
  ),
);
