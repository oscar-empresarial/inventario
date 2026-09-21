// PREPARAR UN TANQUE: CAPACIDAD, LITROS FABRICADOS, "EL RESTO EN AGUA" Y SIN "ESTADO".
//
// Oscar, 21-sep-2026:
//  - "Quita eso [Estado del tanque], no lo usa. Que cuando lo haga, ya queda listo."
//  - "una cosa es la capacidad del tanque y otra cuanto va a fabricar de verdad", y un boton
//    "y el resto en agua" que calcule los litros de agua para llegar a lo que se fabrica.
//
// Aqui se CORRE el codigo de verdad: las funciones de la pantalla (sacadas de index.html) y
// los DOS motores del inventario — el Apps Script (3-INVENTARIO/app-ingeniero/Código.js) y el
// del Worker (_cloudflare/full/src/lab_motor.js) — con las filas que dejaria ese guardado.
// El caso es el que puso Oscar: tanque de 120 L, se fabrican 60 L, 5 L de materia prima
// liquida -> 55 L de agua, y el tanque queda con 60 L (no 120) y LISTO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
const RAIZ = path.join(__dirname, '..', '..', '..');

function tomar(firma, hasta) {
  const i = source.indexOf(firma);
  assert.ok(i >= 0, 'no se encontro ' + firma);
  const fin = hasta ? source.indexOf(hasta, i) : source.indexOf('\n    }', i) + 6;
  assert.ok(fin > i, 'no se encontro el final de ' + firma);
  return source.slice(i, fin);
}

// ================== LA PANTALLA ==================

test('la casilla "Estado del tanque" ya no esta en la pantalla ni se manda', () => {
  assert.doesNotMatch(html, /id="EstadoTanque"/);
  assert.doesNotMatch(html, /data-field="estanque"/);
  assert.doesNotMatch(source, /valueOf\('EstadoTanque'\)/);
  assert.doesNotMatch(source, /baseRecord\('Estado tambor'\)/);
  assert.doesNotMatch(source, /Queda EN PROCESO/);
});

test('la pantalla separa la capacidad del tanque de los litros que se fabrican', () => {
  assert.match(html, /<label for="Tanque">Capacidad del tanque<\/label>/);
  assert.match(html, /id="litrosLabel">Litros que vas a fabricar</);
  assert.match(html, /id="btnRestoAgua"[^>]*>El resto en agua</);
  assert.match(html, /id="restoAguaCuenta"/);
  assert.match(source, /getElementById\('btnRestoAgua'\)\.addEventListener\('click', ponerRestoEnAgua\)/);
});

function cargarCuentas() {
  const ctx = { Math, String, parseFloat, isFinite };
  vm.createContext(ctx);
  vm.runInContext([tomar('function normalize'), tomar('function conPunto'),
    tomar('function capacidadLitros'), tomar('function calcularRestoAgua')].join('\n'), ctx);
  return ctx;
}

test('la capacidad se lee del rotulo del tanque; "Otro / revisar" no es un numero', () => {
  const { capacidadLitros } = cargarCuentas();
  assert.equal(capacidadLitros('120 L'), 120);
  assert.equal(capacidadLitros('20 L'), 20);
  assert.equal(capacidadLitros('Otro / revisar'), null);
  assert.equal(capacidadLitros(''), null);
  assert.equal(capacidadLitros('Balde'), null);
});

test('EL RESTO EN AGUA: tanque de 120 L, se fabrican 60 L con 5 L de MP liquida -> 55 L de agua', () => {
  const { calcularRestoAgua } = cargarCuentas();
  const r = calcularRestoAgua('60', [{ item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' }], '');
  assert.equal(r.agua, 55);
  assert.equal(r.enLitros, 5);
  assert.equal(r.total, 60, 'la cuenta sale de lo que se fabrica, no de la capacidad');
});

test('lo que va en kg o g no se suma como volumen, y se dice cual fue', () => {
  const { calcularRestoAgua } = cargarCuentas();
  const r = calcularRestoAgua('60', [
    { item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' },
    { item: 'Soda CAustica', cantidad: '1', unidad: 'kg' },
    { item: 'Fragancia', cantidad: '500', unidad: 'ml' },
    { item: 'Sal', cantidad: '100', unidad: 'g' },
  ], '');
  assert.equal(r.enLitros, 5.5, '5 L + 500 ml; el kg y los g no suman');
  assert.equal(r.agua, 54.5);
  assert.equal(r.sinVolumen.length, 2);
  assert.match(r.sinVolumen.join(' | '), /Soda CAustica 1 kg/);
});

test('la base sacada de otro tanque cuenta, y una fila de Agua ya puesta se reemplaza, no se suma', () => {
  const { calcularRestoAgua } = cargarCuentas();
  const r = calcularRestoAgua('60', [
    { item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' },
    { item: 'Agua', cantidad: '30', unidad: 'L' },
  ], '10');
  assert.equal(r.agua, 45, '60 - 5 de MP - 10 de base; los 30 de agua viejos no cuentan');
});

test('con coma decimal la cuenta sigue bien (parseFloat("0,5") daria 0)', () => {
  const { calcularRestoAgua } = cargarCuentas();
  const r = calcularRestoAgua('60,5', [{ item: 'Glicerina', cantidad: '0,5', unidad: 'L' }], '');
  assert.equal(r.agua, 60);
});

test('si las materias primas ya llenan el lote, el agua sale negativa (y el boton no la pone)', () => {
  const { calcularRestoAgua } = cargarCuentas();
  const r = calcularRestoAgua('60', [{ item: 'Acido Sulfónico', cantidad: '70', unidad: 'L' }], '');
  assert.equal(r.agua, -10);
  assert.ok(calcularRestoAgua('', [], '').error, 'sin litros a fabricar no hay cuenta');
  // El boton: agua <= 0 -> avisa y NO toca las filas.
  const boton = tomar('function ponerRestoEnAgua');
  assert.match(boton, /if \(!\(r\.agua > 0\)\) \{[\s\S]{0,200}No se puso agua\.[\s\S]{0,60}return;/);
  // Y sin litros a fabricar PREGUNTA por la capacidad; no la supone.
  assert.match(boton, /window\.confirm\('No escribiste cuántos litros vas a fabricar/);
});

// buildPreparacion de verdad, con un formulario de mentiras (mismo molde que frontend.test.js).
function cargarPreparacion(form, mps) {
  const ctx = { console, Math, String, Number, parseFloat, isFinite, Array, Object, Date };
  vm.createContext(ctx);
  vm.runInContext([
    tomar('function normalize'), tomar('function unique'), tomar('function similarityScore'),
    tomar('function resolverEnCatalogo'), tomar('function textoVariosCatalogo'),
    tomar('function conPunto'), tomar('function esNumero'), tomar('function baseRecord'),
    tomar('var _confirmoSoloConsumo'),
    tomar('function buildPreparacion()', '\n    function buildEmpaque()'),
  ].join('\n'), ctx);
  Object.assign(ctx, {
    valueOf: k => (form[k] == null ? '' : form[k]),
    leerFilasMp: () => mps.map(m => Object.assign({ variante: '' }, m)),
    infoTanque: () => null,   // tanque nuevo
    nuevoRequestId: () => 'req-prueba',
    getCatalog: () => ['Agua', 'Acido Sulfónico', 'Soda CAustica'],
    invItems: () => [],
    state: { catalogos: {} },
    document: { getElementById: () => ({ checked: true }) },
  });
  return ctx;
}

const FORM_OSCAR = { Responsable: 'Carlos', Destino: 'tanque', TamborID: 'Tanque 40', Producto: 'Deterfull',
  Tanque: '120 L', LitrosPreparados: '60' };
const MPS_OSCAR = [{ item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' }, { item: 'Agua', cantidad: '55', unidad: 'L' }];

test('un registro nuevo de preparacion sale SIN estado: una sola fila, Motivo vacio', () => {
  const ctx = cargarPreparacion(FORM_OSCAR, MPS_OSCAR);
  const r = ctx.buildPreparacion();
  assert.ok(!r.error && !r.confirmar, r.error || r.confirmar);
  assert.equal(r.records.length, 1, 'no sale una fila "Estado tambor" aparte');
  const p = r.records[0];
  assert.equal(p.TipoRegistro, 'Preparar tambor');
  assert.equal(p.Motivo, '', 'sin estado: los motores lo dejan Listo');
  assert.equal(p.Tanque, '120 L');
  assert.equal(p.LitrosPreparados, '60');
  assert.equal(p.Componentes.length, 2);
});

test('no se puede fabricar mas de lo que le cabe al tanque', () => {
  const ctx = cargarPreparacion(Object.assign({}, FORM_OSCAR, { LitrosPreparados: '130' }),
    [{ item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' }, { item: 'Agua', cantidad: '125', unidad: 'L' }]);
  const r = ctx.buildPreparacion();
  assert.match(r.error || '', /no caben/);
  assert.match(r.error, /litros/, 'el error lleva la palabra "litros" para enfocar esa casilla');
  // "Otro / revisar" no tiene numero: no hay con que frenar.
  const ctx2 = cargarPreparacion(Object.assign({}, FORM_OSCAR, { Tanque: 'Otro / revisar', LitrosPreparados: '130' }),
    [{ item: 'Acido Sulfónico', cantidad: '5', unidad: 'L' }, { item: 'Agua', cantidad: '125', unidad: 'L' }]);
  assert.ok(!ctx2.buildPreparacion().error);
});

test('sin litros a fabricar se PIDEN; la capacidad no se toma en silencio', () => {
  const ctx = cargarPreparacion(Object.assign({}, FORM_OSCAR, { LitrosPreparados: '' }), MPS_OSCAR);
  const r = ctx.buildPreparacion();
  assert.ok(!r.records, 'no puede salir un registro con los litros supuestos');
  assert.match(r.error || '', /cuántos litros vas a fabricar/);
  assert.match(r.error, /120 L/);
});

// ================== LOS DOS MOTORES ==================
// Las filas que deja ese guardado en la hoja (el Apps Script expande la preparacion en la
// fila del tanque + una por componente), mas un empaque de 5 galones del mismo tanque.
const FILAS = [
  { _FilaOrigen: 2, ID: 'a1', OperacionID: 'OP-CAP-1', TipoRegistro: 'Preparar tambor', FechaServidor: '2026-09-21T15:00:00.000Z',
    Responsable: 'Carlos', TamborID: 'Tanque 40', Producto: 'Deterfull', Tanque: '120 L', LitrosPreparados: 60, Motivo: '' },
  { _FilaOrigen: 3, ID: 'a2', OperacionID: 'OP-CAP-1', TipoRegistro: 'Consumo materia prima', FechaServidor: '2026-09-21T15:00:00.000Z',
    Categoria: 'Materia prima', Item: 'Acido Sulfónico', Cantidad: 5, Unidad: 'L', TamborID: 'Tanque 40', Motivo: 'Producción' },
  { _FilaOrigen: 4, ID: 'a3', OperacionID: 'OP-CAP-1', TipoRegistro: 'Consumo materia prima', FechaServidor: '2026-09-21T15:00:00.000Z',
    Categoria: 'Materia prima', Item: 'Agua', Cantidad: 55, Unidad: 'L', TamborID: 'Tanque 40', Motivo: 'Producción' },
];
const EMPAQUE = { _FilaOrigen: 5, ID: 'a4', OperacionID: 'OP-CAP-2', TipoRegistro: 'Empacar desde tambor',
  FechaServidor: '2026-09-21T16:00:00.000Z', TamborID: 'Tanque 40', Presentacion: 'Galón 4 L', CantidadPresentacion: 5,
  Etiqueta: 'Sin etiqueta', Accesorio: 'Sin accesorio' };

function motorAppsScript(filas) {
  const fuente = fs.readFileSync(path.join(RAIZ, '3-INVENTARIO', 'app-ingeniero', 'Código.js'), 'utf8');
  const ctx = {
    console, Logger: { log: () => {} },
    Utilities: { getUuid: () => 'x'.repeat(36), sleep: () => {} },
    SpreadsheetApp: { openById: () => ({}), getActiveSpreadsheet: () => ({}), flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    UrlFetchApp: {}, LockService: {}, ContentService: {}, CacheService: {},
  };
  vm.createContext(ctx);
  new vm.Script(fuente, { filename: 'Código.js' }).runInContext(ctx);
  ctx.__filas = filas;
  vm.runInContext('leerRegistros = function () { return { encabezados: [], filas: __filas }; };' +
    'leerMinimos = function () { return {}; };', ctx);
  return ctx.calcularInventario_();
}
async function motorWorker(filas) {
  const m = await import(pathToFileURL(path.join(RAIZ, '_cloudflare', 'full', 'src', 'lab_motor.js')).href);
  return m.calcularInventario(filas);
}
const tanque = (inv) => inv.tambores.find(t => t.id === 'Tanque 40');

for (const [nombre, correr] of [['Apps Script (Código.js)', async f => motorAppsScript(f)], ['Worker (lab_motor.js)', motorWorker]]) {
  test(nombre + ': el tanque queda con los 60 L FABRICADOS, no con los 120 de capacidad, y LISTO', async () => {
    const t = tanque(await correr(FILAS));
    assert.ok(t, 'el tanque no aparece en la lista');
    assert.equal(t.disponible, 60);
    assert.equal(t.tanque, '120 L', 'la capacidad queda solo como rotulo');
    assert.equal(t.estado, 'Listo', 'sin campo de estado, el tanque queda listo');
  });
  test(nombre + ': Empacar descuenta de los 60 L (5 galones -> quedan 40 L)', async () => {
    const t = tanque(await correr(FILAS.concat([EMPAQUE])));
    assert.equal(t.disponible, 40);
  });
}
