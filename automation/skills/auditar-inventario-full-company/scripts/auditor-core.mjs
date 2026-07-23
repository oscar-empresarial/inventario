const SEVERITY_ORDER = {
  CRITICA: 0,
  ALTA: 1,
  MEDIA: 2,
  BAJA: 3,
  INFO: 4,
};

export function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(duplicado\)/g, "")
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeUnit(value) {
  const unit = normalize(value);
  if (/^(l|lt|lts|litro|litros)$/.test(unit)) return "L";
  if (/^(ml|mililitro|mililitros)$/.test(unit)) return "mL";
  if (/^(kg|kilo|kilos|kilogramo|kilogramos)$/.test(unit)) return "kg";
  if (/^(g|gr|gramo|gramos)$/.test(unit)) return "g";
  if (/^(und|unidad|unidades)$/.test(unit)) return "und";
  return String(value ?? "").trim();
}

function dimension(unit) {
  const normalized = normalizeUnit(unit);
  if (normalized === "L" || normalized === "mL") return "volume";
  if (normalized === "kg" || normalized === "g") return "mass";
  if (normalized === "und") return "count";
  return normalized ? `other:${normalized}` : "";
}

function toBaseQuantity(quantity, unit) {
  const value = finiteNumber(quantity);
  if (value == null) return null;
  const normalized = normalizeUnit(unit);
  if (normalized === "mL") return value / 1000;
  if (normalized === "g") return value / 1000;
  return value;
}

function canonicalName(value, aliases = {}) {
  const key = normalize(value);
  const aliasEntry = Object.entries(aliases).find(
    ([alias]) => normalize(alias) === key,
  );
  return normalize(aliasEntry ? aliasEntry[1] : value);
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function dateValue(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function truthy(value) {
  return /^(si|sí|true|1|x)$/i.test(String(value ?? "").trim());
}

function severityFromApp(value) {
  const key = normalize(value);
  if (key === "critica") return "CRITICA";
  if (key === "alta") return "ALTA";
  if (key === "media") return "MEDIA";
  if (key === "baja") return "BAJA";
  return "INFO";
}

export function auditState(state, config, bomCatalog, now = new Date()) {
  const findings = [];
  const dedupe = new Set();
  const add = (severity, code, entity, detail, recommendation, evidence = {}) => {
    const finding = {
      severity,
      code,
      entity: String(entity || "Sistema"),
      detail,
      recommendation,
      evidence,
    };
    const key = [code, finding.entity, detail].join("|");
    if (dedupe.has(key)) return;
    dedupe.add(key);
    findings.push(finding);
  };

  const ping = state.ping || {};
  if (!ping.ok) {
    add(
      "CRITICA",
      "BACKEND_NO_DISPONIBLE",
      "Apps Script",
      "El backend no confirmó que está operativo.",
      "Detener nuevos registros hasta comprobar el despliegue y la conexión.",
    );
  } else if (
    config.requiredBackendVersion &&
    ping.version !== config.requiredBackendVersion
  ) {
    add(
      "CRITICA",
      "BACKEND_INCOMPATIBLE",
      "Apps Script",
      `La versión activa es ${ping.version || "desconocida"} y se esperaba ${config.requiredBackendVersion}.`,
      "Actualizar el despliegue existente y volver a ejecutar la auditoría.",
      { actual: ping.version, expected: config.requiredBackendVersion },
    );
  }

  for (const finding of state.conciliacion?.hallazgos || []) {
    add(
      severityFromApp(finding.prioridad),
      `CONCILIACION_${finding.codigo || "SIN_CODIGO"}`,
      finding.entidad,
      finding.detalle || "La conciliación reportó una diferencia.",
      "Revisar trazabilidad y soporte físico; no ajustar automáticamente.",
      {
        expected: finding.esperado,
        actual: finding.real,
        difference: finding.diferencia,
      },
    );
  }

  const items = state.inventario?.items || [];
  for (const item of items) {
    const stock = finiteNumber(item.Stock);
    const entity = [item.Item, item.Variante].filter(Boolean).join(" · ");
    if (stock == null) {
      add(
        "CRITICA",
        "STOCK_NO_NUMERICO",
        entity,
        "La existencia no es un número finito.",
        "Revisar el movimiento origen y la unidad antes de continuar.",
        { value: item.Stock },
      );
    } else if (stock < -0.000001) {
      add(
        "ALTA",
        "STOCK_NEGATIVO",
        entity,
        `La existencia calculada es ${stock} ${item.Unidad || ""}.`,
        "Hacer conteo físico y reconstruir el movimiento faltante; no editar el saldo directamente.",
      );
    }

    if (normalize(item.Categoria).includes("envase")) {
      const match = String(item.Item || "").match(/\b(\d+(?:[.,]\d+)?)\s*l\b/i);
      if (match && Number(match[1].replace(",", ".")) > 25) {
        add(
          "MEDIA",
          "NOMBRE_ENVASE_SOSPECHOSO",
          entity,
          `El nombre parece indicar un envase de ${match[1]} L, una capacidad inusual.`,
          "Confirmar si la unidad correcta era mL y corregir mediante Revisiones con referencia.",
        );
      }
    }
  }

  const itemUnitGroups = groupBy(
    items,
    (item) =>
      `${normalize(item.Categoria)}|${normalize(item.Item)}|${normalize(item.Variante)}`,
  );
  for (const group of itemUnitGroups.values()) {
    const dimensions = new Set(group.map((item) => dimension(item.Unidad)).filter(Boolean));
    if (dimensions.size > 1) {
      add(
        "ALTA",
        "UNIDADES_INCOMPATIBLES",
        [group[0].Item, group[0].Variante].filter(Boolean).join(" · "),
        `El mismo artículo aparece con unidades incompatibles: ${[...new Set(group.map((item) => item.Unidad))].join(", ")}.`,
        "Unificar el maestro y transferir saldo con una corrección trazable.",
      );
    }
  }

  const tanks = state.inventario?.tambores || [];
  const tankGroups = groupBy(tanks, (tank) => normalize(tank.id));
  for (const [tankId, group] of tankGroups) {
    if (tankId && group.length > 1) {
      add(
        "ALTA",
        "TANQUE_ACTIVO_DUPLICADO",
        group[0].id,
        "El inventario actual contiene el mismo identificador de tanque más de una vez.",
        "Separar TanqueFisicoID de LoteProduccionID antes de nuevos movimientos.",
      );
    }
  }
  for (const tank of tanks) {
    const available = finiteNumber(tank.disponible);
    if (available != null && available < -0.000001) {
      add(
        "ALTA",
        "TANQUE_NEGATIVO",
        tank.id,
        `El tanque tiene ${available} L disponibles.`,
        "Revisar producción y empaques del lote; confirmar con conteo físico.",
      );
    }
    if (normalize(tank.estado) === "vacio" && available > 0.000001) {
      add(
        "MEDIA",
        "ESTADO_TANQUE_INCONSISTENTE",
        tank.id,
        "El tanque figura vacío pero conserva cantidad disponible.",
        "Revisar el último cambio de estado y el saldo calculado.",
      );
    }
  }

  const records = state.registros?.registros || state.registros || [];
  const allowedOperators = new Set(
    (config.allowedOperators || []).map((operator) => normalize(operator)),
  );
  const unexpectedOperators = new Map();
  const missingResponsible = [];
  for (const record of records) {
    const responsible = normalize(record.Responsable);
    if (!responsible) missingResponsible.push(record);
    else if (allowedOperators.size && !allowedOperators.has(responsible)) {
      unexpectedOperators.set(
        String(record.Responsable),
        (unexpectedOperators.get(String(record.Responsable)) || 0) + 1,
      );
    }
  }
  if (missingResponsible.length) {
    add(
      "ALTA",
      "RESPONSABLE_FALTANTE",
      "Movimientos",
      `${missingResponsible.length} movimiento(s) no indican responsable.`,
      "Identificar el soporte original y documentar la atribución sin borrar historia.",
    );
  }
  for (const [operator, count] of unexpectedOperators) {
    add(
      "MEDIA",
      "RESPONSABLE_NO_RECONOCIDO",
      operator,
      `${count} movimiento(s) usan un responsable fuera de la lista esperada.`,
      "Confirmar si es una persona autorizada y actualizar el catálogo de operadores.",
    );
  }

  if (config.sharedWorkstation) {
    add(
      "MEDIA",
      "IDENTIDAD_DECLARADA_NO_VERIFICADA",
      "Computador compartido",
      "El campo Responsable se selecciona manualmente y la cuenta de Google no demuestra quién realizó cada movimiento.",
      "Añadir un PIN corto por operador o una confirmación personal cuando sea viable.",
    );
  }

  const legacyRows = records.filter(
    (record) =>
      !String(record.OperacionID || "").trim() ||
      !String(record.IdempotencyKey || "").trim() ||
      !String(record.HashIntegridad || "").trim(),
  );
  if (legacyRows.length) {
    add(
      "BAJA",
      "METADATOS_HISTORICOS_INCOMPLETOS",
      "Histórico",
      `${legacyRows.length} fila(s) anteriores no tienen todos los metadatos modernos de auditoría.`,
      "Mantenerlas agrupadas como deuda histórica; no inventar metadatos retroactivos.",
    );
  }

  const idGroups = groupBy(
    records.filter((record) => String(record.ID || "").trim()),
    (record) => String(record.ID),
  );
  for (const [id, group] of idGroups) {
    if (group.length > 1) {
      add(
        "CRITICA",
        "ID_MOVIMIENTO_DUPLICADO",
        id,
        `El identificador aparece ${group.length} veces.`,
        "Detener escrituras y revisar el lote atómico que generó las filas.",
      );
    }
  }

  const requestGroups = groupBy(
    records.filter((record) => String(record.IdempotencyKey || "").trim()),
    (record) => String(record.IdempotencyKey),
  );
  for (const [requestId, group] of requestGroups) {
    const operations = new Set(group.map((record) => record.OperacionID).filter(Boolean));
    const requestHashes = new Set(group.map((record) => record.RequestHash).filter(Boolean));
    if (operations.size > 1 || requestHashes.size > 1) {
      add(
        "CRITICA",
        "CONFLICTO_IDEMPOTENCIA",
        requestId,
        "El mismo RequestId está asociado con operaciones o payloads diferentes.",
        "Bloquear temporalmente nuevos envíos y revisar el código de reintento.",
        { operations: [...operations], requestHashes: [...requestHashes] },
      );
    }
  }

  const operationGroups = new Map();
  records.forEach((record, index) => {
    const key = String(record.OperacionID || `LEGACY-${record.ID || index + 1}`);
    if (!operationGroups.has(key)) operationGroups.set(key, []);
    operationGroups.get(key).push(record);
  });
  const bomStart = dateValue(config.bomAuditStartDate) ?? Number.NEGATIVE_INFINITY;
  const componentAliases = config.componentAliases || {};
  const productAliases = config.productAliases || {};
  const boms = bomCatalog?.boms || [];
  const bomMap = new Map();
  for (const bom of boms) {
    bomMap.set(canonicalName(bom.product, productAliases), bom);
    bomMap.set(canonicalName(bom.title, productAliases), bom);
  }

  for (const [operationId, rows] of operationGroups) {
    const production = rows.find((row) =>
      normalize(row.TipoRegistro).startsWith("preparar tambor"),
    );
    if (production) {
      const product = String(production.Producto || "").trim();
      const liters = finiteNumber(production.LitrosPreparados);
      const productionDate =
        dateValue(production.FechaServidor) ??
        dateValue(production.FechaHora) ??
        Number.NEGATIVE_INFINITY;
      const modernOperation =
        Boolean(String(production.OperacionID || "").trim()) &&
        productionDate >= bomStart;
      const components = rows.filter((row) =>
        normalize(row.TipoRegistro).includes("consumo materia prima"),
      );

      if (
        modernOperation &&
        (!product ||
          !String(production.TamborID || "").trim() ||
          liters == null ||
          liters <= 0)
      ) {
        add(
          "ALTA",
          "PRODUCCION_INCOMPLETA",
          operationId,
          "La producción no conserva producto, tanque y volumen positivo completos.",
          "Revisar el payload y el movimiento compuesto antes de empacar.",
        );
      }
      if (modernOperation && components.length < 2) {
        add(
          "ALTA",
          "COMPONENTES_INSUFICIENTES",
          `${operationId} · ${product}`,
          `La producción conserva ${components.length} componente(s) de materia prima.`,
          "Comparar con la receta, documentar el faltante y no inventar consumos.",
        );
      }

      const liquidTotal = components.reduce((total, component) => {
        return dimension(component.Unidad) === "volume"
          ? total + (toBaseQuantity(component.Cantidad, component.Unidad) || 0)
          : total;
      }, 0);
      if (modernOperation && liters > 0 && liquidTotal / liters < 0.8) {
        add(
          "ALTA",
          "COBERTURA_VOLUMETRICA_BAJA",
          `${operationId} · ${product}`,
          `Los líquidos trazados cubren ${(100 * liquidTotal / liters).toFixed(1)}% del volumen producido.`,
          "Verificar componentes y unidades; no completar la receta por suposición.",
        );
      }
      if (modernOperation && liters > 0 && liquidTotal / liters > 1.05) {
        add(
          "ALTA",
          "COBERTURA_VOLUMETRICA_ALTA",
          `${operationId} · ${product}`,
          `Los líquidos trazados equivalen a ${(100 * liquidTotal / liters).toFixed(1)}% del volumen producido.`,
          "Revisar cantidades, unidades y doble registro.",
        );
      }

      if (modernOperation) {
        const bom = bomMap.get(canonicalName(product, productAliases));
        if (!bom) {
          add(
            "MEDIA",
            "BOM_NO_ESTANDARIZADA",
            product || operationId,
            "No existe una fórmula normalizada para comparar esta producción.",
            "Validar la receta y la merma; agregar una versión aprobada de BOM.",
          );
        } else {
          const scale =
            bom.target?.unit === "L" && liters > 0
              ? liters / bom.target.quantity
              : null;
          const actualByName = new Map();
          for (const component of components) {
            const key = canonicalName(component.Item, componentAliases);
            if (!actualByName.has(key)) actualByName.set(key, []);
            actualByName.get(key).push(component);
          }

          for (const expectedComponent of bom.components || []) {
            const key = canonicalName(expectedComponent.item, componentAliases);
            const actualRows = actualByName.get(key) || [];
            if (!actualRows.length) {
              add(
                "ALTA",
                "COMPONENTE_BOM_FALTANTE",
                `${operationId} · ${product}`,
                `No aparece el componente ${expectedComponent.item} de la fórmula provisional.`,
                "Confirmar con la hoja de producción y dejar resolución en Revisiones.",
                { source: bom.source },
              );
              continue;
            }

            if (scale == null) continue;
            const expectedDimension = dimension(expectedComponent.unit);
            const expectedQuantity =
              toBaseQuantity(expectedComponent.quantity, expectedComponent.unit) * scale;
            const comparableRows = actualRows.filter(
              (row) => dimension(row.Unidad) === expectedDimension,
            );
            if (!comparableRows.length) {
              add(
                "MEDIA",
                "UNIDAD_BOM_INCOMPATIBLE",
                `${operationId} · ${expectedComponent.item}`,
                "El componente existe, pero su unidad no es comparable con la receta provisional.",
                "Confirmar la unidad de medida y registrar una conversión explícita.",
              );
              continue;
            }
            const actualQuantity = comparableRows.reduce(
              (sum, row) => sum + toBaseQuantity(row.Cantidad, row.Unidad),
              0,
            );
            if (expectedQuantity > 0) {
              const deviation =
                (100 * Math.abs(actualQuantity - expectedQuantity)) / expectedQuantity;
              if (deviation > Number(config.bomTolerancePercent ?? 15)) {
                add(
                  deviation > Number(config.bomHighDeviationPercent ?? 50)
                    ? "ALTA"
                    : "MEDIA",
                  "PROPORCION_BOM_ATIPICA",
                  `${operationId} · ${expectedComponent.item}`,
                  `La cantidad difiere ${deviation.toFixed(1)}% de la receta provisional escalada.`,
                  "Revisar receta, medición y merma; no ajustar automáticamente.",
                  {
                    expected: expectedQuantity,
                    actual: actualQuantity,
                    dimension: expectedDimension,
                    source: bom.source,
                  },
                );
              }
            }
          }

          const expectedNames = new Set(
            (bom.components || []).map((component) =>
              canonicalName(component.item, componentAliases),
            ),
          );
          for (const component of components) {
            if (!expectedNames.has(canonicalName(component.Item, componentAliases))) {
              add(
                "BAJA",
                "COMPONENTE_ADICIONAL_BOM",
                `${operationId} · ${component.Item}`,
                "El componente no aparece en la fórmula provisional.",
                "Confirmar si es una modificación válida y versionar la receta si corresponde.",
              );
            }
          }
        }
      }
    }

    for (const packaging of rows.filter((row) => {
      const type = normalize(row.TipoRegistro);
      return type.startsWith("empacar desde tambor") || type.startsWith("empacar producto");
    })) {
      const quantity = finiteNumber(packaging.CantidadPresentacion);
      if (
        !String(packaging.TamborID || "").trim() ||
        !String(packaging.Presentacion || "").trim() ||
        quantity == null ||
        quantity <= 0
      ) {
        add(
          "ALTA",
          "EMPAQUE_INCOMPLETO",
          operationId,
          "El empaque no conserva tanque, presentación y cantidad positiva completos.",
          "Revisar la operación antes de entregar o sincronizar producto terminado.",
        );
      }
      if (!String(packaging.Etiqueta || "").trim() && !truthy(packaging.SinEtiqueta)) {
        add(
          "MEDIA",
          "ESTADO_ETIQUETA_AMBIGUO",
          operationId,
          "El empaque no indica etiqueta ni declara explícitamente que salió sin etiqueta.",
          "Corregir el estado documental mediante una revisión trazable.",
        );
      }
    }
  }

  const pendingReviews = state.revision?.pendientes || [];
  if (pendingReviews.length) {
    add(
      "MEDIA",
      "REVISIONES_PENDIENTES",
      "Centro de Revisiones",
      `Hay ${pendingReviews.length} elemento(s) pendientes de decisión.`,
      "Revisar nombre, categoría, soporte y saldo antes de aprobar o relacionar.",
    );
  }

  const recordDates = records
    .map((record) => dateValue(record.FechaServidor) ?? dateValue(record.FechaHora))
    .filter((value) => value != null);
  const latestActivity = recordDates.length ? Math.max(...recordDates) : null;
  if (
    latestActivity != null &&
    now.getTime() - latestActivity >
      Number(config.recentActivityHours ?? 72) * 60 * 60 * 1000
  ) {
    add(
      "INFO",
      "SIN_ACTIVIDAD_RECIENTE",
      "Movimientos",
      "No se observan movimientos dentro de la ventana operativa configurada.",
      "Confirmar si la planta estuvo inactiva o si existe un problema de guardado.",
    );
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.entity.localeCompare(b.entity),
  );
  const counts = Object.fromEntries(
    Object.keys(SEVERITY_ORDER).map((severity) => [
      severity,
      findings.filter((finding) => finding.severity === severity).length,
    ]),
  );

  return {
    generatedAt: now.toISOString(),
    mode: "SOLO_LECTURA",
    policy: config.policy || {},
    summary: {
      findings: findings.length,
      counts,
      inventoryItems: items.length,
      tanks: tanks.length,
      records: records.length,
      pendingReviews: pendingReviews.length,
      reconcilerFindings: (state.conciliacion?.hallazgos || []).length,
      latestActivity: latestActivity ? new Date(latestActivity).toISOString() : null,
    },
    findings,
  };
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildMarkdownReport(report) {
  const counts = report.summary.counts;
  const lines = [
    "# Auditoría de inventario Full Company",
    "",
    `Generada: ${report.generatedAt}`,
    "",
    "> Modo solo lectura: este informe no bloqueó operaciones, no aprobó revisiones y no modificó inventario.",
    "",
    "## Resumen",
    "",
    `- Hallazgos: ${report.summary.findings}`,
    `- Críticos: ${counts.CRITICA}; altos: ${counts.ALTA}; medios: ${counts.MEDIA}; bajos: ${counts.BAJA}; informativos: ${counts.INFO}`,
    `- Artículos: ${report.summary.inventoryItems}; tanques: ${report.summary.tanks}; movimientos: ${report.summary.records}`,
    `- Conciliación: ${report.summary.reconcilerFindings}; revisiones pendientes: ${report.summary.pendingReviews}`,
    `- Último movimiento: ${report.summary.latestActivity || "sin fecha disponible"}`,
    "",
    "## Qué revisar primero",
    "",
  ];

  const priority = report.findings.filter((finding) =>
    ["CRITICA", "ALTA"].includes(finding.severity),
  );
  if (!priority.length) {
    lines.push("No se detectaron hallazgos críticos o altos.");
  } else {
    lines.push("| Prioridad | Código | Entidad | Hallazgo | Acción |");
    lines.push("|---|---|---|---|---|");
    for (const finding of priority.slice(0, 60)) {
      lines.push(
        `| ${finding.severity} | ${escapeCell(finding.code)} | ${escapeCell(finding.entity)} | ${escapeCell(finding.detail)} | ${escapeCell(finding.recommendation)} |`,
      );
    }
  }

  const other = report.findings.filter(
    (finding) => !["CRITICA", "ALTA"].includes(finding.severity),
  );
  lines.push("", "## Controles y mejoras", "");
  if (!other.length) {
    lines.push("Sin observaciones adicionales.");
  } else {
    lines.push("| Prioridad | Código | Entidad | Hallazgo | Acción |");
    lines.push("|---|---|---|---|---|");
    for (const finding of other.slice(0, 80)) {
      lines.push(
        `| ${finding.severity} | ${escapeCell(finding.code)} | ${escapeCell(finding.entity)} | ${escapeCell(finding.detail)} | ${escapeCell(finding.recommendation)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Regla de cierre",
    "",
    "Cerrar cada alerta con responsable, fecha, explicación, soporte y decisión. Para diferencias físicas, realizar conteo antes de cualquier ajuste.",
    "",
  );
  return lines.join("\n");
}
