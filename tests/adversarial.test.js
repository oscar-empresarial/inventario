const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codigo.gs'), 'utf8');
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
    'Usuario', 'VersionBOM', 'HashIntegridad', 'DestinoTambor'
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
  context.getInventario = () => ({
    items: [
      { Item: 'Fragancia', Variante: '', Stock: 1000, Unidad: 'L' },
      { Item: 'Varsol', Variante: '', Stock: 1000, Unidad: 'L' }
    ],
    tambores: [
      { id: '1', producto: 'Base corta', disponible: 18 },
      { id: '12', producto: 'Ecovarsol', disponible: 120 },
      { id: 'BASE-1', producto: 'Base múltiple', disponible: 500 }
    ]
  });
  return { context, workbook, sheets, registro, lock };
}

function validProduction(extra = {}) {
  return {
    RequestId: 'REQ-VALID-0001', TipoRegistro: 'Preparar tambor', Responsable: 'Carlos',
    Producto: 'Ecovarsol', TamborID: '12', LitrosPreparados: 120, FormulaCompleta: true,
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
    assert.equal(row.TamborID, '12');
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
    Responsable: 'Carlos', ReferenciaOriginal: original.operacionId, TamborID: '12',
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
    TamborID: '12', Producto: 'Blanqueador',
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
