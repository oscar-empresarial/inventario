import test from "node:test";
import assert from "node:assert/strict";
import { auditState } from "./auditor-core.mjs";

const config = {
  requiredBackendVersion: "2.2.0-revisiones",
  allowedOperators: ["Carlos", "Neyder"],
  sharedWorkstation: false,
  bomAuditStartDate: "2026-07-22T00:00:00-05:00",
  bomTolerancePercent: 15,
  bomHighDeviationPercent: 50,
  recentActivityHours: 100000,
  productAliases: {},
  componentAliases: { "tea (duplicado)": "TEA" },
  policy: { readOnly: true, neverAutoAdjust: true },
};

const boms = {
  boms: [
    {
      product: "Ecovarsol",
      title: "Ecovarsol 120 lt",
      target: { quantity: 120, unit: "L" },
      components: [
        { item: "Formol", quantity: 40, unit: "mL" },
        { item: "Carbopol", quantity: 300, unit: "g" },
        { item: "Fragancia", quantity: 1, unit: "L" },
        { item: "TEA (duplicado)", quantity: 200, unit: "mL" },
        { item: "Exxol", quantity: 5000, unit: "mL" },
        { item: "Agua", quantity: 110, unit: "L" },
      ],
      source: { workbook: "Costos.xlsx", sheet: "Ecovarsol" },
    },
  ],
};

function stateWithProduction(liters, components, extraRows = []) {
  const operationId = "OP-TEST-1";
  const records = [
    {
      ID: "P-1",
      OperacionID: operationId,
      IdempotencyKey: "REQ-1",
      RequestHash: "HASH-1",
      HashIntegridad: "I-1",
      FechaServidor: "2026-07-23T12:00:00Z",
      Responsable: "Carlos",
      TipoRegistro: "Preparar tambor",
      Producto: "Ecovarsol",
      LitrosPreparados: liters,
      TamborID: "12",
    },
    ...components.map((component, index) => ({
      ID: `C-${index}`,
      OperacionID: operationId,
      IdempotencyKey: "REQ-1",
      RequestHash: "HASH-1",
      HashIntegridad: `I-${index + 2}`,
      FechaServidor: "2026-07-23T12:00:00Z",
      Responsable: "Carlos",
      TipoRegistro: "Consumo materia prima",
      Item: component.item,
      Cantidad: component.quantity,
      Unidad: component.unit,
    })),
    ...extraRows,
  ];
  return {
    ping: { ok: true, version: "2.2.0-revisiones" },
    inventario: { items: [], tambores: [] },
    conciliacion: { hallazgos: [] },
    revision: { pendientes: [] },
    registros: { registros: records },
  };
}

const fullRecipe = [
  { item: "Formol", quantity: 40, unit: "mL" },
  { item: "Carbopol", quantity: 300, unit: "g" },
  { item: "Fragancia", quantity: 1, unit: "L" },
  { item: "TEA", quantity: 200, unit: "mL" },
  { item: "Exxol", quantity: 5, unit: "L" },
  { item: "Agua", quantity: 110, unit: "L" },
];

test("acepta la receta provisional completa de Ecovarsol", () => {
  const report = auditState(
    stateWithProduction(120, fullRecipe),
    config,
    boms,
    new Date("2026-07-23T13:00:00Z"),
  );
  assert.equal(
    report.findings.some((finding) =>
      ["COMPONENTE_BOM_FALTANTE", "PROPORCION_BOM_ATIPICA"].includes(finding.code),
    ),
    false,
  );
});

test("escala la receta cuando se fabrican 100 L en un tanque de 120 L", () => {
  const scale = 100 / 120;
  const scaled = fullRecipe.map((component) => ({
    ...component,
    quantity: component.quantity * scale,
  }));
  const report = auditState(
    stateWithProduction(100, scaled),
    config,
    boms,
    new Date("2026-07-23T13:00:00Z"),
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "PROPORCION_BOM_ATIPICA"),
    false,
  );
});

test("detecta el caso de 120 L declarando solo 1 L de fragancia", () => {
  const report = auditState(
    stateWithProduction(120, [{ item: "Fragancia", quantity: 1, unit: "L" }]),
    config,
    boms,
    new Date("2026-07-23T13:00:00Z"),
  );
  assert.ok(
    report.findings.filter((finding) => finding.code === "COMPONENTE_BOM_FALTANTE")
      .length >= 5,
  );
  assert.ok(
    report.findings.some((finding) => finding.code === "COBERTURA_VOLUMETRICA_BAJA"),
  );
});

test("detecta RequestId reutilizado en operaciones diferentes", () => {
  const state = stateWithProduction(120, fullRecipe, [
    {
      ID: "OTHER-1",
      OperacionID: "OP-OTHER",
      IdempotencyKey: "REQ-1",
      RequestHash: "HASH-2",
      HashIntegridad: "OTHER-HASH",
      Responsable: "Carlos",
      TipoRegistro: "Entrada mercancía",
      Item: "Fragancia",
      Cantidad: 1,
      Unidad: "L",
    },
  ]);
  const report = auditState(state, config, boms);
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.code === "CONFLICTO_IDEMPOTENCIA" &&
        finding.severity === "CRITICA",
    ),
  );
});

test("detecta inventario negativo y nombre de envase sospechoso", () => {
  const state = stateWithProduction(120, fullRecipe);
  state.inventario.items = [
    {
      Categoria: "Envase",
      Item: "Envase transparente 810 L",
      Variante: "",
      Stock: -2,
      Unidad: "und",
    },
  ];
  const report = auditState(state, config, boms);
  assert.ok(report.findings.some((finding) => finding.code === "STOCK_NEGATIVO"));
  assert.ok(
    report.findings.some((finding) => finding.code === "NOMBRE_ENVASE_SOSPECHOSO"),
  );
});
