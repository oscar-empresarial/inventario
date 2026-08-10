const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Código.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const frontendSource = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

function makeBackend(options = {}) {
  let uuid = 0;
  class FakeRange {
    constructor(sheet, row, col, rows = 1, cols = 1) {
      this.sheet = sheet; this.row = row; this.col = col; this.rows = rows; this.cols = cols;
    }
    getValues() { return this.sheet.read(this.row, this.col, this.rows, this.cols, false); }
    getDisplayValues() { return this.sheet.read(this.row, this.col, this.rows, this.cols, true); }
    setValue(value) { this.setValues([[value]]); return this; }
    setValues(values) {
      if (this.sheet.failBatch && this.row > 1 && values.length > 1) {
        const mode = this.sheet.failBatch;
        this.sheet.failBatch = '';
        if (mode === 'before') throw new Error('FALLO_INYECTADO_ANTES_DE_ESCRIBIR');
        this.sheet.write(this.row, this.col, values);
        throw new Error('FALLO_INYECTADO_DESPUES_DE_ESCRIBIR');
      }
      this.sheet.write(this.row, this.col, values);
      return this;
    }
  }
  class FakeSheet {
    constructor(name, rows = [[]]) { this.name = name; this.data = rows.map(r => r.slice()); this.failBatch = ''; }
    getName() { return this.name; }
    getLastRow() { return this.data.length; }
    getLastColumn() { return this.data.reduce((n, r) => Math.max(n, r.length), 0); }
    getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
    getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
    appendRow(row) { this.data.push(row.slice()); }
    hideSheet() {}
    read(row, col, rows, cols, display) {
      const out = [];
      for (let r = 0; r < rows; r++) {
        const line = [];
        for (let c = 0; c < cols; c++) {
          let value = (this.data[row - 1 + r] || [])[col - 1 + c];
          if (value == null) value = '';
          line.push(display ? String(value instanceof Date ? value.toISOString() : value) : value);
        }
        out.push(line);
      }
      return out;
    }
    write(row, col, values) {
      values.forEach((line, r) => {
        const target = row - 1 + r;
        while (this.data.length <= target) this.data.push([]);
        line.forEach((value, c) => { this.data[target][col - 1 + c] = value; });
      });
    }
  }

  const headers = [
    'ID', 'FechaHora', 'Responsable', 'TipoRegistro', 'Categoria', 'Item', 'Variante',
    'Cantidad', 'Unidad', 'Movimiento', 'Motivo', 'Producto', 'LitrosPreparados', 'TamborID',
    'Observacion', 'OperacionID', 'IdempotencyKey', 'EstadoMovimiento', 'FechaServidor',
    'Usuario', 'VersionBOM', 'HashIntegridad', 'DestinoTambor',
    // La hoja real las tiene; sin ellas aquí, un movimiento que las use se guarda "bien"
    // en la prueba pero pierde el dato en la hoja de verdad.
    'CantidadPresentacion', 'Presentacion', 'SKU'
  ];
  const registro = new FakeSheet('REGISTRO_APP', [headers]);
  const catalogos = new FakeSheet('CATALOGOS', [['Materias primas', 'Productos'], ['Fragancia', 'Ecovarsol'], ['Varsol', '']]);
  const sheets = { REGISTRO_APP: registro, CATALOGOS: catalogos };
  const workbook = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { return (sheets[name] = new FakeSheet(name, [[]])); }
  };
  const lock = {
    released: false,
    tryLock() { return options.lockAvailable !== false; },
    releaseLock() { this.released = true; }
  };
  const context = {
    console,
    Logger: { log() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      computeDigest(_alg, value) {
        return [...crypto.createHash('sha256').update(String(value)).digest()].map(x => x > 127 ? x - 256 : x);
      }
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => 'qa@fullcompany.test' }),
      getEffectiveUser: () => ({ getEmail: () => 'owner@fullcompany.test' })
    },
    SpreadsheetApp: { openById: () => workbook },
    LockService: { getScriptLock: () => lock },
    ContentService: {}
  };
  vm.createContext(context);
  vm.runInContext(backendSource, context);
  context.salida = data => data;
  // El getInventario de verdad, antes de taparlo con el falso: sirve para probar el
  // cálculo real de saldos a partir de movimientos.
  const getInventarioReal = context.getInventario;
  context.getInventario = () => ({
    items: [
      { Item: 'Fragancia', Variante: '', Stock: 1000, Unidad: 'L' },
      { Item: 'Varsol', Variante: '', Stock: 1000, Unidad: 'L' }
    ],
    tambores: [
      { id: '1', producto: 'Base corta', disponible: 18 },
      { id: '12', producto: 'Ecovarsol', disponible: 120 },
      { id: 'BASE-1', producto: 'Base múltiple', disponible: 500 },
      // Tanque limpio donde se prepara. El 12 se queda lleno porque sirve de ORIGEN de
      // base en otras pruebas; preparar encima de él lo rechaza el guardarraíl de residuo.
      { id: '77', producto: '', disponible: 0 }
    ]
  });
  return { context, workbook, sheets, registro, lock, getInventarioReal };
}

function validProduction(extra = {}) {
  return {
    RequestId: 'REQ-VALID-0001', TipoRegistro: 'Preparar tambor', Responsable: 'Carlos',
    Producto: 'Ecovarsol', TamborID: '77', LitrosPreparados: 120, FormulaCompleta: true,
    Componentes: [
      { Item: 'Agua', Cantidad: 119, Unidad: 'L' },
      { Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }
    ],
    ...extra
  };
}

function post(context, payload) {
  return context.doPost({ postData: { contents: JSON.stringify(payload) } });
}

function xorshift(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

test('payload válido se expande y persiste en un único lote de tres filas', () => {
  const { context, registro } = makeBackend();
  const result = post(context, validProduction());
  assert.equal(result.ok, true);
  assert.equal(result.movimientos, 3);
  assert.equal(registro.getLastRow(), 4);
  const tipos = registro.data.slice(1).map(r => r[3]);
  assert.deepEqual(tipos, ['Preparar tambor', 'Consumo materia prima', 'Consumo materia prima']);
  assert.equal(new Set(registro.data.slice(1).map(r => r[16])).size, 1, 'todas las filas comparten RequestId');
  assert.equal(new Set(registro.data.slice(1).map(r => r[15])).size, 1, 'todas las filas comparten OperacionID');
});

test('fuzz determinista rechaza números no finitos, cero y negativos', () => {
  const { context } = makeBackend();
  const invalid = [undefined, null, '', 0, -0, -1, -0.001, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '-Infinity', '0', '-2'];
  invalid.forEach(value => {
    const payload = validProduction();
    payload.LitrosPreparados = value;
    assert.throws(() => context.validarProduccionPost_(payload), /mayor que cero/, `LitrosPreparados=${String(value)}`);
  });
  invalid.forEach(value => {
    const payload = validProduction();
    payload.Componentes = [
      { Item: 'Agua', Cantidad: 119, Unidad: 'L' },
      { Item: 'Fragancia', Cantidad: value, Unidad: 'L' }
    ];
    assert.throws(() => context.validarProduccionPost_(payload), /mayor que cero/, `Componente=${String(value)}`);
  });
});

test('fuzz determinista acepta cantidades válidas y conserva límites de cobertura', () => {
  const { context } = makeBackend();
  const random = xorshift(0x5eca91b);
  for (let i = 0; i < 80; i++) {
    const litros = 1 + Math.round(random() * 499000) / 1000;
    const fragancia = Math.max(0.001, Math.round(litros * (0.001 + random() * 0.05) * 1000) / 1000);
    const agua = litros - fragancia;
    const payload = validProduction({
      LitrosPreparados: litros,
      Componentes: [
        { Item: 'Agua', Cantidad: agua, Unidad: 'L' },
        { Item: 'Fragancia', Cantidad: fragancia, Unidad: 'L' }
      ]
    });
    assert.doesNotThrow(() => context.validarProduccionPost_(payload), `iteración ${i}`);
  }
  assert.doesNotThrow(() => context.validarProduccionPost_(validProduction({
    Componentes: [{ Item: 'Agua', Cantidad: 95, Unidad: 'L' }, { Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }]
  })), '80% exacto es el mínimo permitido');
  assert.throws(() => context.validarProduccionPost_(validProduction({
    Componentes: [{ Item: 'Agua', Cantidad: 94.999, Unidad: 'L' }, { Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }]
  })), /incompleta/);
});

test('campos obligatorios vacíos y fórmula incompleta se rechazan sin escribir', () => {
  const mutations = [
    ['Producto', '', /Producto es obligatorio/],
    ['TamborID', '', /TamborID es obligatorio/],
    ['FormulaCompleta', false, /confirmar FormulaCompleta/],
    ['Componentes', [], /al menos dos componentes/],
    ['Componentes', 'Agua 119 L', /lista de materias primas/]
  ];
  mutations.forEach(([field, value, expected], i) => {
    const { context, registro } = makeBackend();
    const payload = validProduction({ RequestId: `REQ-EMPTY-${String(i).padStart(4, '0')}` });
    payload[field] = value;
    const result = post(context, payload);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(registro.getLastRow(), 1);
  });
});

test('componentes duplicados se detectan tras normalizar caso, acentos y espacios', () => {
  const { context } = makeBackend();
  const payload = validProduction({
    Componentes: [
      { Item: 'Agua', Cantidad: 60, Unidad: 'L' },
      { Item: '  ÁGUA  ', Cantidad: 60, Unidad: 'L' }
    ]
  });
  assert.throws(() => context.validarProduccionPost_(payload), /duplicada/);
});

test('repetir el mismo RequestId y payload no duplica filas', () => {
  const { context, registro } = makeBackend();
  const payload = validProduction();
  assert.equal(post(context, payload).ok, true);
  const rows = registro.getLastRow();
  const second = post(context, payload);
  assert.equal(second.ok, true);
  assert.equal(second.duplicado, true);
  assert.equal(registro.getLastRow(), rows);
});

test('reutilizar RequestId con un payload distinto se rechaza como conflicto', () => {
  const { context, registro } = makeBackend();
  const first = validProduction();
  assert.equal(post(context, first).ok, true);
  const rows = registro.getLastRow();
  const changed = validProduction({ Producto: 'Producto distinto' });
  const second = post(context, changed);
  assert.equal(second.ok, false);
  assert.match(second.error, /RequestId.*payload|idempotencia.*conflicto/i);
  assert.equal(registro.getLastRow(), rows);
});

test('fallo antes de setValues no deja producción parcial y queda confirmable como rechazo', () => {
  const { context, registro } = makeBackend();
  registro.failBatch = 'before';
  const result = post(context, validProduction({ RequestId: 'REQ-FAIL-BEFORE' }));
  assert.equal(result.ok, false);
  assert.equal(registro.getLastRow(), 1);
  const status = context.getEstadoOperacion_('REQ-FAIL-BEFORE');
  assert.equal(status.encontrada, true);
  assert.equal(status.ok, false);
  assert.match(status.error, /ANTES_DE_ESCRIBIR/);
});

test('fallo ambiguo después de setValues se confirma por RequestId sin duplicar al reintentar', () => {
  const { context, registro } = makeBackend();
  const payload = validProduction({ RequestId: 'REQ-FAIL-AFTER' });
  registro.failBatch = 'after';
  const response = post(context, payload);
  assert.equal(response.ok, false, 'la respuesta directa es ambigua/fallida');
  assert.equal(registro.getLastRow(), 4, 'el lote completo sí alcanzó a persistirse');
  const status = context.getEstadoOperacion_('REQ-FAIL-AFTER');
  assert.equal(status.ok, true);
  assert.equal(status.movimientos, 3);
  const retry = post(context, payload);
  assert.equal(retry.duplicado, true);
  assert.equal(registro.getLastRow(), 4);
});

test('lock ocupado rechaza la concurrencia sin escribir y siempre libera el lock', () => {
  const { context, registro, lock } = makeBackend({ lockAvailable: false });
  const result = post(context, validProduction({ RequestId: 'REQ-LOCK-0001' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /otro movimiento en proceso/);
  assert.equal(registro.getLastRow(), 1);
  assert.equal(lock.released, true);
});

test('tanque 1 y tanque 12 usan coincidencia exacta para una base', () => {
  const { context } = makeBackend();
  assert.throws(() => context.validarBaseDisponible_('1', 19), /Base insuficiente.*1/);
  assert.doesNotThrow(() => context.validarBaseDisponible_('12', 119));
  assert.throws(() => context.validarBaseDisponible_('01', 1), /no encontrado/i);
});

function makeFrontend(operationStates) {
  const calls = { fetch: [], status: [] };
  const storage = {};
  const context = {
    console,
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    document: { addEventListener() {}, querySelectorAll() { return []; } },
    window: { crypto: { randomUUID: () => 'FRONTEND-UUID-0001' } },
    fetch: async (...args) => { calls.fetch.push(args); return { ok: true }; },
    Blob: function () {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    localStorage: {
      getItem(key) { return Object.hasOwn(storage, key) ? storage[key] : null; },
      setItem(key, value) { storage[key] = String(value); }
    }
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(frontendSource, context);
  context.esperar = async () => {};
  context.state.backendCompatible = true;
  context.state.backendVersion = context.BACKEND_VERSION_REQUERIDA;
  context.verificarBackendCompatible = async () => context.BACKEND_VERSION_REQUERIDA;
  context.consultarOperacion = async requestId => {
    calls.status.push(requestId);
    const status = operationStates.length ? operationStates.shift() : { encontrada: false, ok: false };
    return { version: context.BACKEND_VERSION_REQUERIDA, ...status };
  };
  return { context, calls, storage };
}

test('frontend conserva RequestId mientras espera confirmación y acepta confirmación tardía', async () => {
  const states = [
    { encontrada: false, ok: false }, { encontrada: false, ok: false },
    { encontrada: true, ok: true, operacionId: 'OP-1', movimientos: 3 }
  ];
  const { context, calls, storage } = makeFrontend(states);
  const record = validProduction({ RequestId: 'REQ-FRONTEND-1' });
  const result = await context.enviarRegistro(record);
  assert.equal(result.ok, true);
  assert.equal(calls.fetch.length, 1);
  assert.deepEqual(calls.status, ['REQ-FRONTEND-1', 'REQ-FRONTEND-1', 'REQ-FRONTEND-1']);
  assert.equal(JSON.parse(calls.fetch[0][1].body).RequestId, 'REQ-FRONTEND-1');
  assert.deepEqual(JSON.parse(storage[context.OPERACIONES_PENDIENTES_KEY]), {}, 'la bandeja se limpia solo después de confirmar');
});

test('frontend no declara éxito si nunca puede confirmar el guardado', async () => {
  const { context, calls, storage } = makeFrontend(Array.from({ length: 12 }, () => ({ encontrada: false, ok: false })));
  await assert.rejects(() => context.enviarRegistro(validProduction({ RequestId: 'REQ-TIMEOUT-01' })), /no fue posible confirmar/i);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.status.length, 12);
  const pendientes = JSON.parse(storage[context.OPERACIONES_PENDIENTES_KEY]);
  assert.equal(pendientes['REQ-TIMEOUT-01'].payload.RequestId, 'REQ-TIMEOUT-01', 'el payload ambiguo queda recuperable');
});

test('frontend bloquea el POST si la versión del backend no coincide', async () => {
  const { context, calls, storage } = makeFrontend([]);
  context.verificarBackendCompatible = async () => {
    const error = new Error('backend incompatible');
    error.backendIncompatible = true;
    throw error;
  };
  await assert.rejects(() => context.enviarRegistro(validProduction({ RequestId: 'REQ-VERSION-OLD' })), /incompatible/);
  assert.equal(calls.fetch.length, 0, 'nunca transmite a un backend de contrato desconocido');
  assert.equal(storage[context.OPERACIONES_PENDIENTES_KEY], undefined, 'no crea un pendiente para algo que nunca intentó enviar');
});

test('frontend y backend comparten el contrato de cantidades finitas', () => {
  const { context: frontend } = makeFrontend([]);
  [NaN, Infinity, -Infinity, 'NaN', 'Infinity', '-Infinity', '', '0', '-1', '1abc'].forEach(value => {
    assert.equal(frontend.esNumero(value, false), false, `frontend debe rechazar ${String(value)}`);
  });
  ['0.001', '1', '1.5', '1,5', 120].forEach(value => {
    assert.equal(frontend.esNumero(value, false), true, `frontend debe aceptar ${String(value)}`);
  });
});

test('los tanques se ordenan naturalmente por número y luego por nombre', () => {
  const { context: frontend } = makeFrontend([]);
  const ids = ['1', '14', '25', '21', '27', '28', 'Creolina', '9', '12', '2', '11', '30'];
  ids.sort(frontend.compararNatural);
  assert.deepEqual(ids, ['1', '2', '9', '11', '12', '14', '21', '25', '27', '28', '30', 'Creolina']);
});

test('contrato frontend-backend de Preparar tambor permanece compatible', () => {
  const { context } = makeBackend();
  assert.match(frontendSource, /produccion\.FormulaCompleta\s*=\s*true/);
  assert.match(frontendSource, /produccion\.Componentes\s*=\s*componentes/);
  assert.match(frontendSource, /TipoRegistro:\s*'Movimiento compuesto'/);
  const expanded = context.expandirProduccion_(validProduction(), 'Carlos', 'OP-CONTRACT');
  assert.equal(expanded[0].TipoRegistro, 'Preparar tambor');
  assert.equal(expanded.length, 3);
  expanded.slice(1).forEach(row => {
    assert.equal(row.TipoRegistro, 'Consumo materia prima');
    assert.equal(row.TamborID, '77');
    assert.equal(row.Producto, 'Ecovarsol');
  });
});

test('corrección de tanque puede trasladar producto terminado del mismo lote sin duplicarlo', () => {
  const { context } = makeBackend();
  context.leerRegistros = () => ({ filas: [
    {
      ID: 'OP-TANK-01-01', OperacionID: 'OP-TANK-01',
      TipoRegistro: 'Preparar tambor', TamborID: '12',
      Producto: 'Etherpool', LitrosPreparados: 120
    }
  ] });
  context.getInventario = () => ({
    items: [
      { Item: 'Etherpool Galón 4 L', Variante: '12', Categoria: 'Producto terminado', Stock: 5, Unidad: 'und' },
      { Item: 'Etherpool Pimpina 20 L', Variante: '99', Categoria: 'Producto terminado', Stock: 2, Unidad: 'und' }
    ],
    tambores: [{ id: '12', producto: 'Etherpool', disponible: 100 }]
  });
  const rows = context.construirCorreccionTanque_({
    ReferenciaOriginal: 'OP-TANK-01',
    TamborID: '12',
    Producto: 'Blanqueador',
    Motivo: 'Producto seleccionado por error',
    AprobadoPor: 'Oscar',
    TrasladarEmpacados: true
  }, 'Carlos');
  assert.equal(rows[0].TipoRegistro, 'Corrección tanque');
  assert.equal(rows[0].AprobadoPor, 'Oscar');
  assert.equal(rows[0].Item, 'Etherpool');
  const transfers = rows.filter(r => r.TipoRegistro === 'Traslado inventario');
  assert.equal(transfers.length, 1, 'solo traslada existencias del lote corregido');
  assert.equal(transfers[0].Item, 'Etherpool Galón 4 L');
  assert.equal(transfers[0].Producto, 'Blanqueador Galón 4 L');
  assert.equal(transfers[0].Cantidad, 5);
});

test('correcciones rechazan referencias inexistentes o de un lote anterior reutilizado', () => {
  const { context } = makeBackend();
  context.leerRegistros = () => ({ filas: [
    {
      ID: 'OP-OLD-01', OperacionID: 'OP-OLD',
      TipoRegistro: 'Preparar tambor', TamborID: '12',
      Producto: 'Viejo', LitrosPreparados: 50
    },
    {
      ID: 'OP-NEW-01', OperacionID: 'OP-NEW',
      TipoRegistro: 'Preparar tambor', TamborID: '12',
      Producto: 'Actual', LitrosPreparados: 80
    }
  ] });
  assert.throws(() => context.construirCorreccionTanque_({
    ReferenciaOriginal: 'NO-EXISTE', TamborID: '12',
    Producto: 'Correcto', Motivo: 'Corrección solicitada'
  }, 'Carlos'), /no existe|encontr/i);
  assert.throws(() => context.construirCorreccionTanque_({
    ReferenciaOriginal: 'OP-OLD', TamborID: '12',
    Producto: 'Correcto', Motivo: 'Corrección solicitada'
  }, 'Carlos'), /lote actual|preparación posterior/i);
});

test('POST de completar producción persiste una corrección atómica e idempotente', () => {
  const { context, registro } = makeBackend();
  const original = post(context, validProduction({ RequestId: 'REQ-PROD-ORIGINAL' }));
  assert.equal(original.ok, true);
  const payload = {
    RequestId: 'REQ-CORR-PROD-01', TipoRegistro: 'Corrección producción',
    // Mismo tanque que la preparación que se está corrigiendo.
    Responsable: 'Carlos', ReferenciaOriginal: original.operacionId, TamborID: '77',
    Motivo: 'Se confirmaron componentes omitidos',
    AprobadoPor: 'Oscar',
    Componentes: [
      { Item: 'Agua', Cantidad: 10, Unidad: 'L' },
      { Item: 'Varsol', Cantidad: 5, Unidad: 'L' }
    ]
  };
  const result = post(context, payload);
  assert.equal(result.ok, true);
  assert.equal(result.movimientos, 3);
  assert.equal(registro.data.slice(1).filter(r => r[3] === 'Preparar tambor').length, 1);
  const rows = registro.data.slice(-3);
  assert.deepEqual(rows.map(r => r[3]), ['Novedad/Corrección', 'Consumo materia prima', 'Consumo materia prima']);
  const refIndex = registro.data[0].indexOf('ReferenciaOriginal');
  assert.equal(new Set(rows.map(r => r[refIndex])).size, 1);
  assert.equal(rows[0][refIndex], original.operacionId);
  const approvalIndex = registro.data[0].indexOf('AprobadoPor');
  assert.equal(rows[0][approvalIndex], 'Oscar');
  const retry = post(context, payload);
  assert.equal(retry.duplicado, true);
  assert.equal(registro.getLastRow(), 7);
});

test('POST de corregir tanque escribe una corrección, no una segunda preparación', () => {
  const { context, registro } = makeBackend();
  const original = post(context, validProduction({ RequestId: 'REQ-TANK-ORIGINAL' }));
  const result = post(context, {
    RequestId: 'REQ-CORR-TANK-01', TipoRegistro: 'Corrección tanque',
    Responsable: 'Neyder', ReferenciaOriginal: original.operacionId,
    TamborID: '77', Producto: 'Blanqueador',
    Motivo: 'Se seleccionó el producto equivocado',
    AprobadoPor: 'Oscar',
    TrasladarEmpacados: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.movimientos, 1);
  assert.equal(registro.data.slice(1).filter(r => r[3] === 'Preparar tambor').length, 1);
  assert.equal(registro.data.at(-1)[3], 'Corrección tanque');
  assert.equal(registro.data.at(-1)[11], 'Blanqueador');
  assert.equal(registro.data.at(-1)[registro.data[0].indexOf('AprobadoPor')], 'Oscar');
});

// ===========================================================================
// GUARDARRAÍLES QUE NO TENÍAN PRUEBA
// Estos tres bloques cubren reglas que se agregaron después de escribirse las
// pruebas y que, por no estar cubiertas, rompieron el archivo entero sin que
// nadie se enterara. Van aquí para que no vuelva a pasar en silencio.
// ===========================================================================

test('preparar sobre un tanque que ya tiene producto se detiene y pregunta con cuánto queda', () => {
  const { context } = makeBackend();
  // El tanque 12 ya tiene 120 L: registrar otros 120 L sin decir qué pasó con lo
  // anterior es exactamente cómo se duplicó la preparación del tanque 1.
  assert.throws(
    () => context.validarProduccionPost_(validProduction({ TamborID: '12' })),
    /RESIDUO EN EL TANQUE 12/
  );
});

test('el residuo se resuelve diciendo si los litros son adicionales o el total', () => {
  const { context } = makeBackend();
  // "total": el tanque queda con lo declarado (aprovechó el sobrante o lo vació).
  assert.doesNotThrow(() => context.validarProduccionPost_(
    validProduction({ TamborID: '12', ResiduoTanque: 'total' })));
  // "adicional": se rellenó encima, los litros se suman a lo que había.
  assert.doesNotThrow(() => context.validarProduccionPost_(
    validProduction({ TamborID: '12', ResiduoTanque: 'adicional' })));
});

test('la misma preparación registrada dos veces en el día avisa antes de duplicarla', () => {
  const { context } = makeBackend();
  const primera = post(context, validProduction({ RequestId: 'REQ-DUP-PRIMERA' }));
  assert.equal(primera.ok, true);
  // Mismo producto, mismo tanque, mismos componentes, otro RequestId: para el
  // sistema es una operación nueva, pero casi siempre es la misma tecleada dos veces.
  const segunda = post(context, validProduction({ RequestId: 'REQ-DUP-SEGUNDA' }));
  assert.equal(segunda.ok, false, 'debe frenarse y pedir confirmación');
  assert.match(String(segunda.error), /ya (se )?registr|duplicad/i);
  // Si el operario confirma que de verdad son dos tandas distintas, pasa.
  const confirmada = post(context, validProduction({
    RequestId: 'REQ-DUP-CONFIRMADA', ConfirmoNoDuplicado: true
  }));
  assert.equal(confirmada.ok, true);
});

test('el conteo total contra Siigo persiste un lote con su SKU', () => {
  const { context, registro } = makeBackend();
  // Es lo que manda la pestaña "Conteo total": varios conteos en una sola operación.
  // Los dos DOMICILIO tienen el MISMO nombre y distinto código: si el SKU no viajara,
  // el conteo de uno le pisaría el saldo al otro.
  const result = post(context, {
    RequestId: 'REQ-CONTEO-SIIGO-01', TipoRegistro: 'Movimiento compuesto', Responsable: 'Carlos',
    Movimientos: [
      { TipoRegistro: 'Conteo inventario', Categoria: 'Producto Siigo', Item: 'DOMICILIO',
        Variante: 'DOMICILIO', Cantidad: 0, Unidad: 'unidad', SKU: 'DOMICILIO',
        Observacion: 'Conteo total' },
      { TipoRegistro: 'Conteo inventario', Categoria: 'Producto Siigo', Item: 'DOMICILIO',
        Variante: 'AA36', Cantidad: 3, Unidad: 'unidad', SKU: 'AA36',
        Observacion: 'Conteo total' }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.movimientos, 2);
  const iSku = registro.data[0].indexOf('SKU');
  assert.ok(iSku >= 0, 'la columna SKU se crea sola');
  const filas = registro.data.slice(-2);
  assert.deepEqual(filas.map(r => r[iSku]), ['DOMICILIO', 'AA36']);
  const iVariante = registro.data[0].indexOf('Variante');
  assert.deepEqual(filas.map(r => r[iVariante]), ['DOMICILIO', 'AA36'],
    'cada SKU es su propia línea de saldo aunque el nombre sea idéntico');
});

test('un conteo sin observación se rechaza y no escribe nada', () => {
  const { context, registro } = makeBackend();
  const antes = registro.getLastRow();
  const result = post(context, {
    RequestId: 'REQ-CONTEO-SIN-OBS', TipoRegistro: 'Movimiento compuesto', Responsable: 'Carlos',
    Movimientos: [
      { TipoRegistro: 'Conteo inventario', Categoria: 'Producto Siigo', Item: 'DOMICILIO',
        Variante: 'AA36', Cantidad: 3, Unidad: 'unidad', SKU: 'AA36' }
    ]
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /observaci/i);
  assert.equal(registro.getLastRow(), antes, 'un lote rechazado no deja filas a medias');
});

// ===========================================================================
// AUDITORÍA DIARIA
// La auditoría solo sirve si lo que reporta es cierto. Con 14 alertas ALTA falsas
// nadie la lee, y ahí es cuando se cuela la de verdad (la Soda Cáustica marcando
// 46 toneladas pasó 9 días invisible). Estas pruebas fijan las tres reglas.
// ===========================================================================

function auditoriaCon(context, { items = [], filas = [], tambores = [] }) {
  context.getInventario = () => ({ items, tambores });
  context.leerRegistros = () => ({ encabezados: [], filas });
  return context.getAuditoriaDiaria();
}
const codigos = a => a.hallazgos.map(h => h.codigo);

function preparacion(op, tanque, fecha, producto = 'Deterfull preparado') {
  return [
    { TipoRegistro: 'Preparar tambor', OperacionID: op, TamborID: tanque, Producto: producto,
      FechaServidor: fecha, LitrosPreparados: 20 },
    { TipoRegistro: 'Consumo materia prima', OperacionID: op, Item: 'Fragancia',
      Cantidad: 1, Unidad: 'L', FechaServidor: fecha }
  ];
}

test('auditoría: preparar, empacar todo y volver a preparar NO es un duplicado', () => {
  const { context } = makeBackend();
  // Es el caso real del tanque 28: preparó 20 L, empacó 5 galones de 4 L (los 20 L
  // completos) y volvió a preparar. Es el trabajo normal de un día.
  const a = auditoriaCon(context, { filas: [
    ...preparacion('OP-A', '28', '2026-07-24T20:37:00Z'),
    { TipoRegistro: 'Empacar desde tambor', OperacionID: 'OP-EMP', TamborID: '28',
      Presentacion: 'Galon 4 L', CantidadPresentacion: 5, FechaServidor: '2026-07-24T21:23:00Z' },
    ...preparacion('OP-B', '28', '2026-07-24T21:25:00Z')
  ] });
  assert.ok(!codigos(a).includes('PREPARACION_DUPLICADA'),
    'vaciar el tanque en el intermedio hace legítima la segunda preparación');
});

test('auditoría: dos preparaciones seguidas SIN vaciar el tanque sí se reportan', () => {
  const { context } = makeBackend();
  const a = auditoriaCon(context, { filas: [
    ...preparacion('OP-A', '28', '2026-07-24T20:37:00Z'),
    ...preparacion('OP-B', '28', '2026-07-24T21:25:00Z')
  ] });
  assert.ok(codigos(a).includes('PREPARACION_DUPLICADA'),
    'sin salida del tanque en medio, es la misma preparación tecleada dos veces');
});

test('auditoría: los tanques de prueba técnica no generan alertas ni salen en la lista', () => {
  const { context } = makeBackend();
  const a = auditoriaCon(context, { filas: [
    ...preparacion('OP-P1', 'ZZ-PRUEBA-GUARDARRAIL', '2026-07-31T20:41:00Z', 'Prueba tecnica guardarrail'),
    ...preparacion('OP-P2', 'ZZ-PRUEBA-GUARDARRAIL', '2026-07-31T20:41:00Z', 'Prueba tecnica guardarrail')
  ] });
  assert.ok(!codigos(a).includes('PREPARACION_DUPLICADA'),
    'una prueba técnica no es producción y no debe ensuciar el informe');
});

test('auditoría: una materia prima con un saldo imposible HOY se reporta como ALTA', () => {
  const { context } = makeBackend();
  // El caso Soda Cáustica: un solo conteo en toda su historia, y justo ese con la
  // celda dañada. La regla vieja solo miraba el saldo ANTERIOR a un conteo, así que
  // este ítem era invisible. Son 46 toneladas de soda.
  const a = auditoriaCon(context, {
    items: [{ Item: 'Soda Cáustica', Variante: '', Categoria: 'Materia prima', Stock: 46052.9, Unidad: 'kg' }]
  });
  const hallazgo = a.hallazgos.find(h => h.codigo === 'SALDO_IMPOSIBLE');
  assert.ok(hallazgo, 'tiene que detectarlo');
  assert.equal(hallazgo.prioridad, 'ALTA');
  assert.equal(hallazgo.entidad, 'Soda Cáustica');
});

test('auditoría: un saldo normal no dispara la alerta de saldo imposible', () => {
  const { context } = makeBackend();
  const a = auditoriaCon(context, {
    items: [{ Item: 'Hipoclorito puro', Variante: '', Categoria: 'Materia prima', Stock: 36, Unidad: 'L' }]
  });
  assert.ok(!codigos(a).includes('SALDO_IMPOSIBLE'));
});

test('auditoría: un producto terminado con muchas unidades NO es un saldo imposible', () => {
  const { context } = makeBackend();
  // 5.000 envases sí caben en una bodega; 5.000 litros de una materia prima no.
  const a = auditoriaCon(context, {
    items: [{ Item: 'Tapa normal', Variante: '', Categoria: 'Envase', Stock: 5000, Unidad: 'und' }]
  });
  assert.ok(!codigos(a).includes('SALDO_IMPOSIBLE'));
});

// ===========================================================================
// ABRIR PAQUETE: 1 bolsa de 50 pastillas deja de ser bolsa y pasa a ser 50 pastillas.
// No es traslado (ahí entra y sale lo mismo) ni baja (no se perdió nada): multiplica.
// ===========================================================================

function inventarioCon(context, items) {
  context.getInventario = () => ({ items, tambores: [] });
}
const BOLSA = 'Pastilla Cloro 91% Bolsa x 50Unid 1Kl';
const SUELTA = 'Pastilla Cloro 91% x Unidad';
function abrir(extra = {}) {
  return {
    RequestId: 'REQ-ABRIR-0001', TipoRegistro: 'Abrir paquete', Responsable: 'Carlos',
    Categoria: 'Producto terminado', Item: BOLSA, Producto: SUELTA,
    Cantidad: 1, CantidadPresentacion: 50, Unidad: 'und',
    Observacion: 'Se abrió un paquete', ...extra,
  };
}

test('abrir paquete: saca 1 bolsa y mete 50 sueltas', () => {
  const { context, getInventarioReal } = makeBackend();
  context.leerRegistros = () => ({ filas: [
    { TipoRegistro: 'Entrada mercancía', Categoria: 'Producto terminado', Item: BOLSA, Cantidad: 92, Unidad: 'und' },
    { TipoRegistro: 'Abrir paquete', Categoria: 'Producto terminado', Item: BOLSA,
      Producto: SUELTA, Cantidad: 1, CantidadPresentacion: 50, Unidad: 'und' },
  ] });
  const inv = getInventarioReal();
  const bolsas = inv.items.find(i => i.Item === BOLSA);
  const sueltas = inv.items.find(i => i.Item === SUELTA);
  assert.equal(bolsas.Stock, 91, 'quedan 91 bolsas');
  assert.equal(sueltas.Stock, 50, 'salieron 50 pastillas sueltas');
});

test('abrir paquete: no deja abrir bolsas que no hay', () => {
  const { context } = makeBackend();
  inventarioCon(context, [{ Item: BOLSA, Variante: '', Categoria: 'Producto terminado', Stock: 2, Unidad: 'und' }]);
  assert.throws(() => context.validarAbrirPaquetePost_(abrir({ Cantidad: 5 })), /Solo hay 2/);
  assert.doesNotThrow(() => context.validarAbrirPaquetePost_(abrir({ Cantidad: 2 })));
});

test('abrir paquete: exige saber qué sale y cuántas trae', () => {
  const { context } = makeBackend();
  inventarioCon(context, [{ Item: BOLSA, Variante: '', Categoria: 'Producto terminado', Stock: 90, Unidad: 'und' }]);
  assert.throws(() => context.validarAbrirPaquetePost_(abrir({ Producto: '' })), /qué producto sale|Falta/i);
  assert.throws(() => context.validarAbrirPaquetePost_(abrir({ CantidadPresentacion: 0 })), /unidades trae/i);
  assert.throws(() => context.validarAbrirPaquetePost_(abrir({ Producto: BOLSA })), /no pueden ser el mismo/);
});

test('abrir paquete: se guarda como UNA fila y queda el rastro de lo que salió', () => {
  const { context, registro } = makeBackend();
  inventarioCon(context, [{ Item: BOLSA, Variante: '', Categoria: 'Producto terminado', Stock: 92, Unidad: 'und' }]);
  const r = post(context, abrir());
  assert.equal(r.ok, true);
  assert.equal(r.movimientos, 1);
  const fila = registro.data.at(-1), cab = registro.data[0];
  assert.equal(fila[cab.indexOf('TipoRegistro')], 'Abrir paquete');
  assert.equal(fila[cab.indexOf('Item')], BOLSA);
  assert.equal(fila[cab.indexOf('Producto')], SUELTA);
  assert.equal(Number(fila[cab.indexOf('CantidadPresentacion')]), 50);
});
