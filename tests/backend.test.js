const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codigo.gs'), 'utf8');
const context = {
  console,
  Logger: { log() {} },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest(_alg, value) {
      return [...crypto.createHash('sha256').update(value).digest()].map(x => x > 127 ? x - 256 : x);
    }
  },
  Session: {
    getActiveUser: () => ({ getEmail: () => '' }),
    getEffectiveUser: () => ({ getEmail: () => 'owner@fullcompany.test' })
  },
  SpreadsheetApp: { openById() { throw new Error('La hoja no se usa en estas pruebas unitarias'); } },
  ContentService: {}, LockService: {}
};
vm.createContext(context);
vm.runInContext(source, context);
const getInventarioReal = context.getInventario;
context.leerMinimos = () => ({});
context.getInventario = () => ({
  items: [
    { Item: 'Fragancia', Variante: '', Stock: 50, Unidad: 'L' },
    { Item: 'Varsol', Variante: '', Stock: 500, Unidad: 'L' }
  ],
  tambores: [
    { id: '12', producto: 'Ecovarsol', disponible: 120 },
    { id: 'BASE-1', producto: 'Base múltiple', disponible: 200 }
  ]
});

function prod(componentes, extra = {}) {
  return { TipoRegistro: 'Preparar tambor', Producto: 'Ecovarsol', TamborID: '12', LitrosPreparados: 120, FormulaCompleta: true, Componentes: componentes, ...extra };
}

test('bloquea el incidente: 120 L con solo 1 L de fragancia', () => {
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }])), /al menos dos componentes/);
});
test('bloquea dos componentes que no explican el volumen', () => {
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }, { Item: 'Varsol', Cantidad: 1, Unidad: 'L' }])), /Fórmula incompleta/);
});
test('acepta 120 L completamente explicados', () => {
  const r = context.validarProduccionPost_(prod([{ Item: 'Agua', Cantidad: 119, Unidad: 'L' }, { Item: 'Fragancia', Cantidad: 1000, Unidad: 'ml' }]));
  assert.equal(r.litros, 120);
  assert.equal(r.componentes.length, 2);
});
test('acepta una base trazada más otro componente', () => {
  const r = context.validarProduccionPost_(prod([{ Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }], { BaseTanque: 'BASE-1', BaseLitros: 119 }));
  assert.equal(r.baseLitros, 119);
});
test('bloquea base insuficiente o tomada del tanque destino', () => {
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }], { BaseTanque: 'BASE-1', BaseLitros: 201 })), /Base insuficiente/);
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }], { BaseTanque: '12', BaseLitros: 119 })), /mismo tanque/);
});
test('exige confirmación de fórmula completa', () => {
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Agua', Cantidad: 119, Unidad: 'L' }, { Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }], { FormulaCompleta: false })), /confirmar FormulaCompleta/);
});
test('bloquea materias primas duplicadas', () => {
  assert.throws(() => context.validarProduccionPost_(prod([{ Item: 'Agua', Cantidad: 60, Unidad: 'L' }, { Item: 'Agua', Cantidad: 60, Unidad: 'L' }])), /duplicada/);
});
test('bloquea consumo y empaque sin inventario suficiente', () => {
  assert.throws(() => context.validarStockItem_('Fragancia', '', 51, 'L'), /Inventario insuficiente/);
  assert.throws(() => context.validarEmpaquePost_({ TamborID: '12', Presentacion: 'Galón 4 L', CantidadPresentacion: 31 }), /Inventario insuficiente/);
});
test('permite usar exactamente el saldo disponible', () => {
  assert.doesNotThrow(() => context.validarStockItem_('Fragancia', '', 50, 'L'));
  assert.doesNotThrow(() => context.validarEmpaquePost_({ TamborID: '12', Presentacion: 'Galón 4 L', CantidadPresentacion: 30 }));
});
test('corrección exige motivo y referencia original', () => {
  assert.throws(() => context.validarMovimientoPost_({ Motivo: '', ReferenciaOriginal: 'OP-1' }, 'Novedad/Corrección'), /Motivo explícito/);
  assert.throws(() => context.validarMovimientoPost_({ Motivo: 'Faltante' }, 'Novedad/Corrección'), /ReferenciaOriginal/);
  assert.doesNotThrow(() => context.validarMovimientoPost_({ Motivo: 'Faltante / merma', ReferenciaOriginal: 'OP-1' }, 'Novedad/Corrección'));
});
test('hash de auditoría es estable y completo', () => assert.match(context.hashFila_(['a', 1]), /^[a-f0-9]{64}$/));

test('campo prioriza LitrosPreparados sobre una Cantidad vacía', () => {
  assert.equal(context.campo({ Cantidad: '', LitrosPreparados: 120 }, ['litrospreparados', 'cantidad']), 120);
});

test('un empaque del tanque 1 nunca descuenta el tanque 12', () => {
  context.leerRegistros = () => ({ filas: [
    { TipoRegistro: 'Preparar tambor', TamborID: '1', Producto: 'Otro', LitrosPreparados: 18 },
    { TipoRegistro: 'Preparar tambor', TamborID: '12', Producto: 'Ecovarsol', LitrosPreparados: 120 },
    { TipoRegistro: 'Empacar desde tambor', TamborID: '1', Presentacion: 'Pimpina 20 L', CantidadPresentacion: 1 },
    { TipoRegistro: 'Empacar desde tambor', TamborID: '1', Presentacion: 'Galón 4 L', CantidadPresentacion: 15 }
  ] });
  const inv = getInventarioReal();
  assert.equal(inv.tambores.find(t => t.id === '12').disponible, 120);
  assert.equal(inv.tambores.find(t => t.id === '1').disponible, 0);
});

test('un empaque del tanque 2 nunca descuenta el tanque 28', () => {
  context.leerRegistros = () => ({ filas: [
    { TipoRegistro: 'Preparar tambor', TamborID: '2', Producto: 'A', LitrosPreparados: 20 },
    { TipoRegistro: 'Preparar tambor', TamborID: '28', Producto: 'B', LitrosPreparados: 20 },
    { TipoRegistro: 'Empacar desde tambor', TamborID: '2', Presentacion: 'Galón 4 L', CantidadPresentacion: 5 }
  ] });
  const inv = getInventarioReal();
  assert.equal(inv.tambores.find(t => t.id === '2').disponible, 0);
  assert.equal(inv.tambores.find(t => t.id === '28').disponible, 20);
});

test('conciliación agrupa auditoría legacy y conserva los litros preparados', () => {
  context.leerRegistros = () => ({ filas: [
    { TipoRegistro: 'Preparar tambor', TamborID: '1', LitrosPreparados: 18, Cantidad: '', Producto: 'A' },
    { TipoRegistro: 'Empacar desde tambor', TamborID: '1', Presentacion: 'Pimpina 20 L', CantidadPresentacion: 1 }
  ] });
  const result = context.getConciliacion();
  const saldo = result.hallazgos.find(h => h.codigo === 'SALDO-TAMBOR-NEGATIVO');
  assert.equal(saldo.esperado, 18);
  assert.equal(saldo.real, 20);
  assert.equal(result.hallazgos.filter(h => h.codigo === 'AUDITORIA-LEGACY').length, 1);
  assert.equal(result.resumen.filasLegacy, 2);
});

test('solo el flujo controlado puede resolver revisiones', () => {
  assert.throws(() => context.validarTipoPermitido_('Eliminar item'), /no permitido/);
  assert.throws(() => context.validarTipoPermitido_('Aprobación item'), /no permitido/);
  assert.doesNotThrow(() => context.validarTipoPermitido_('Revisión item'));
  const rows = context.construirRevisionItem_({
    Accion: 'APROBAR', Categoria: 'Envase', Item: 'Tarro 2 L',
    Motivo: 'Validado contra factura', ReferenciaOriginal: 'OP-ORIGEN'
  }, 'Carlos');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TipoRegistro, 'Aprobación item');
});

test('permite agrupar líneas relacionadas en una sola operación', () => {
  assert.doesNotThrow(() => context.validarTipoPermitido_('Movimiento compuesto'));
  const rows = context.expandirProduccion_(prod([
    { Item: 'Agua', Cantidad: 119, Unidad: 'L' },
    { Item: 'Fragancia', Cantidad: 1, Unidad: 'L' }
  ]), 'Carlos', 'OP-TEST');
  assert.equal(rows.length, 3);
  assert.equal(rows[1].TipoRegistro, 'Consumo materia prima');
});

test('corregir un tanque cambia el producto sin alterar sus litros', () => {
  context.leerRegistros = () => ({ filas: [
    {
      ID: 'OP-ORIGINAL-01-01', OperacionID: 'OP-ORIGINAL-01',
      TipoRegistro: 'Preparar tambor', TamborID: '7',
      Producto: 'Etherpool', LitrosPreparados: 100
    },
    {
      TipoRegistro: 'Corrección tanque', TamborID: '7',
      Item: 'Etherpool', Producto: 'Blanqueador',
      ReferenciaOriginal: 'OP-ORIGINAL-01', Motivo: 'Nombre equivocado'
    }
  ] });
  const inv = getInventarioReal();
  const tanque = inv.tambores.find(t => t.id === '7');
  assert.equal(tanque.producto, 'Blanqueador');
  assert.equal(tanque.disponible, 100);
  assert.equal(inv.items.find(i => i.Item === 'Blanqueador').Stock, 100);
  assert.equal(inv.items.some(i => i.Item === 'Etherpool'), false);
});

test('completar una producción agrega consumos enlazados pero nunca vuelve a fabricar litros', () => {
  context.leerRegistros = () => ({ filas: [
    {
      ID: 'OP-ORIGINAL-02-01', OperacionID: 'OP-ORIGINAL-02',
      TipoRegistro: 'Preparar tambor', TamborID: '8',
      Producto: 'Blanqueador', LitrosPreparados: 120
    }
  ] });
  const rows = context.construirCorreccionProduccion_({
    ReferenciaOriginal: 'OP-ORIGINAL-02',
    TamborID: '8',
    Motivo: 'Faltaron materias primas en el registro',
    Componentes: [
      { Item: 'Agua', Cantidad: 110, Unidad: 'L' },
      { Item: 'Hipoclorito 13%', Cantidad: 10, Unidad: 'L' }
    ]
  }, 'Carlos');
  assert.equal(rows[0].TipoRegistro, 'Novedad/Corrección');
  assert.equal(rows.filter(r => r.TipoRegistro === 'Consumo materia prima').length, 2);
  assert.equal(rows.some(r => r.TipoRegistro === 'Preparar tambor'), false);
  rows.slice(1).forEach(r => assert.equal(r.ReferenciaOriginal, 'OP-ORIGINAL-02'));
});

test('la conciliación reconoce componentes añadidos por una corrección enlazada', () => {
  context.leerRegistros = () => ({ filas: [
    {
      ID: 'OP-ORIGINAL-03-01', OperacionID: 'OP-ORIGINAL-03',
      TipoRegistro: 'Preparar tambor', TamborID: '9',
      Producto: 'Blanqueador', LitrosPreparados: 100,
      FechaServidor: '2026-07-24T10:00:00.000Z', Usuario: 'qa'
    },
    {
      ID: 'OP-CORR-03-01', OperacionID: 'OP-CORR-03',
      TipoRegistro: 'Novedad/Corrección', TamborID: '9',
      Producto: 'Blanqueador', ReferenciaOriginal: 'OP-ORIGINAL-03',
      FechaServidor: '2026-07-24T11:00:00.000Z', Usuario: 'qa'
    },
    {
      ID: 'OP-CORR-03-02', OperacionID: 'OP-CORR-03',
      TipoRegistro: 'Consumo materia prima', TamborID: '9',
      Producto: 'Blanqueador', Item: 'Agua', Cantidad: 90, Unidad: 'L',
      ReferenciaOriginal: 'OP-ORIGINAL-03',
      FechaServidor: '2026-07-24T11:00:00.000Z', Usuario: 'qa'
    },
    {
      ID: 'OP-CORR-03-03', OperacionID: 'OP-CORR-03',
      TipoRegistro: 'Consumo materia prima', TamborID: '9',
      Producto: 'Blanqueador', Item: 'Hipoclorito 13%', Cantidad: 10, Unidad: 'L',
      ReferenciaOriginal: 'OP-ORIGINAL-03',
      FechaServidor: '2026-07-24T11:00:00.000Z', Usuario: 'qa'
    }
  ] });
  const result = context.getConciliacion();
  assert.equal(result.hallazgos.some(h => h.codigo === 'BOM-INCOMPLETA'), false);
  assert.equal(result.hallazgos.some(h => h.codigo === 'RENDIMIENTO-IMPOSIBLE'), false);
});

test('trasladar saldo manualmente relaciona dos nombres existentes sin borrar historial', () => {
  const original = context.itemExisteOficial_;
  context.itemExisteOficial_ = item => ['Fragancia', 'Varsol'].includes(item);
  try {
    const rows = context.construirRevisionItem_({
      Accion: 'RELACIONAR', Categoria: 'Materia prima',
      Item: 'Fragancia', ItemDestino: 'Varsol', OrigenManual: true,
      Motivo: 'Se registró con el nombre equivocado',
      ReferenciaOriginal: 'CATALOGO-PRUEBA'
    }, 'Neyder');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].TipoRegistro, 'Aprobación item');
    assert.equal(rows[1].TipoRegistro, 'Traslado inventario');
    assert.equal(rows[1].Item, 'Fragancia');
    assert.equal(rows[1].Producto, 'Varsol');
  } finally {
    context.itemExisteOficial_ = original;
  }
});
