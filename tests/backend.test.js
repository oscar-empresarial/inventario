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
