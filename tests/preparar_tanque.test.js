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
  // El tanque 1 (ambientador de piso) es de 170 L y la lista no lo tenia: quedaba como
  // "Otro / revisar" (auditoria del 21-sep). Con el freno de capacidad, escoger 160 lo
  // bloquearia al llenarlo completo.
  assert.match(html, /<select id="Tanque">[\s\S]*?<option>170 L<\/option>[\s\S]*?<\/select>/);
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

// ================== LA CAPACIDAD DE CADA TANQUE (Oscar, 21-sep-2026: "me parece delicado") ==================
// La capacidad se GUARDA por tanque: sale de la ultima preparacion que la dijo con numero
// ("120 L") o de una fila 'Capacidad tanque' (asi quedo el tanque 1 en 170 L). "Otro / revisar"
// no es un dato: no borra una capacidad conocida ni inventa una. Y el freno: el tanque no
// puede quedar con mas de lo que le cabe, tampoco al agregarle litros ("¿adicionales o total?").

const prep = (fila, tambor, tanque, litros, extra) => Object.assign({ _FilaOrigen: fila, ID: 'c' + fila,
  OperacionID: 'OP-C' + fila, TipoRegistro: 'Preparar tambor', FechaServidor: '2026-09-0' + (fila % 9 + 1) + 'T15:00:00.000Z',
  Responsable: 'Carlos', TamborID: tambor, Producto: 'Ambientadores de piso', Tanque: tanque, LitrosPreparados: litros, Motivo: '' }, extra || {});
const FILAS_CAP = [
  prep(2, '1', 'Otro / revisar', 170),
  prep(3, '1', '120 L', 20),          // el 4-ago se anoto "120 L" en una adicion de 20 L
  prep(4, '2', 'Otro / revisar', 170),
  prep(5, '3', '120 L', 120),
  prep(6, '3', '', 10),               // adicion sin capacidad: la del tanque se conserva
  { _FilaOrigen: 7, ID: 'c7', OperacionID: 'OP-C7', TipoRegistro: 'Capacidad tanque', FechaServidor: '2026-09-21T19:00:00.000Z',
    Responsable: 'Oscar', TamborID: '1', Tanque: '170 L', Observacion: 'Capacidad dicha por Oscar' },
];

for (const [nombre, correr] of [['Apps Script (Código.js)', async f => motorAppsScript(f)], ['Worker (lab_motor.js)', motorWorker]]) {
  test(nombre + ': la capacidad de cada tanque sale de lo que se dijo con numero, y la ultima manda', async () => {
    const inv = await correr(FILAS_CAP);
    const t = id => inv.tambores.find(x => x.id === id);
    assert.equal(t('1').capacidad, 170, 'la fila Capacidad tanque (170) le gana al "120 L" del 4-ago');
    assert.equal(t('2').capacidad, null, 'solo "Otro / revisar": sin capacidad, no se inventa');
    assert.equal(t('3').capacidad, 120, 'una adicion sin capacidad no la borra');
    assert.equal(t('3').disponible, 130);
    // Sin la fila de Oscar, el tanque 1 quedaria en 120: por eso se escribio.
    const sinOscar = await correr(FILAS_CAP.slice(0, 5));
    assert.equal(sinOscar.tambores.find(x => x.id === '1').capacidad, 120);
  });
  test(nombre + ': "Capacidad tanque" no mueve litros ni inventario', async () => {
    const a = await correr(FILAS_CAP.slice(0, 5));
    const b = await correr(FILAS_CAP);
    // (por texto: lo que sale del vm del Apps Script tiene otro prototipo)
    assert.equal(JSON.stringify(b.tambores.map(t => t.disponible)), JSON.stringify(a.tambores.map(t => t.disponible)));
    assert.equal(JSON.stringify(b.items), JSON.stringify(a.items));
  });
}

// ---- El freno del servidor (Apps Script), corrido de verdad ----
function servidorCon(tambores) {
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
  ctx.__inv = { items: [], tambores };
  vm.runInContext('getInventario = function () { return __inv; };', ctx);
  return ctx;
}
const lanza = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };
const TANQUES = [{ id: '1', disponible: 150, capacidad: 170 }, { id: '4', disponible: 27, capacidad: 170 },
  { id: '2', disponible: 2.5, capacidad: null }, { id: '9', disponible: 0, capacidad: 60 }];

test('servidor: no se fabrica mas de lo que le cabe al tanque (dicho en el registro o guardado)', () => {
  const s = servidorCon(TANQUES);
  assert.match(lanza(() => s.validarCapacidadTanque_({ LitrosPreparados: 180 }, '1', 180)), /NO CABE EN EL TANQUE 1/);
  assert.match(lanza(() => s.validarCapacidadTanque_({ LitrosPreparados: 61 }, '9', 61)), /es de 60 L/);
  assert.match(lanza(() => s.validarCapacidadTanque_({ LitrosPreparados: 130, Tanque: '120 L' }, 'Tanque 99', 130)), /NO CABE/);
  assert.equal(s.validarCapacidadTanque_({ LitrosPreparados: 60 }, '1', 60), 170);
  assert.equal(s.validarCapacidadTanque_({ LitrosPreparados: 500 }, '2', 500), null, 'sin capacidad no hay con que frenar');
});

test('servidor: "¿adicionales o total?" con la capacidad a la vista, y adicionales que no caben se frenan', () => {
  const s = servidorCon(TANQUES);
  // 150 + 60 = 210 > 170: la pregunta solo deja "total".
  const q = lanza(() => s.resolverResiduoTanque_({ LitrosPreparados: 60 }, '1', 170));
  assert.match(q, /RESIDUO EN EL TANQUE 1/);
  assert.match(q, /NO PUEDEN SER ADICIONALES/);
  assert.match(q, /210 L/);
  assert.doesNotMatch(q, />>> Si los 60 L son ADICIONALES/);
  // Y si igual llega "adicional" (una app vieja), el servidor la frena.
  assert.match(lanza(() => s.resolverResiduoTanque_({ LitrosPreparados: 60, ResiduoTanque: 'adicional' }, '1', 170)), /NO CABE EN EL TANQUE 1/);
  // "total" si cabe: el tanque queda con los 60.
  assert.equal(s.resolverResiduoTanque_({ LitrosPreparados: 60, ResiduoTanque: 'total' }, '1', 170), 150);
  // 27 + 60 = 87 <= 170: la pregunta de siempre, con la capacidad escrita.
  const q2 = lanza(() => s.resolverResiduoTanque_({ LitrosPreparados: 60 }, '4', 170));
  assert.match(q2, /ADICIONALES a lo que había, el tanque queda con 87 L de 170 L/);
  assert.doesNotMatch(q2, /NO PUEDEN SER ADICIONALES/);
  assert.equal(s.resolverResiduoTanque_({ LitrosPreparados: 60, ResiduoTanque: 'adicional' }, '4', 170), 0);
  // Sin capacidad conocida, la pregunta queda como estaba.
  assert.match(lanza(() => s.resolverResiduoTanque_({ LitrosPreparados: 500 }, '2', null)), /ADICIONALES a lo que había, el tanque queda con 502.5 L\./);
});

test('servidor: la fila "Capacidad tanque" se acepta con litros y sin mentir sobre lo que hay', () => {
  const s = servidorCon(TANQUES);
  assert.equal(lanza(() => s.validarTipoPermitido_('Capacidad tanque')), '');
  const mov = p => lanza(() => s.validarMovimientoPost_(Object.assign({ TipoRegistro: 'Capacidad tanque', Responsable: 'Oscar' }, p), 'Capacidad tanque'));
  assert.equal(mov({ TamborID: '1', Tanque: '170 L' }), '');
  assert.match(mov({ TamborID: '1', Tanque: 'Otro / revisar' }), /en litros/);
  assert.match(mov({ TamborID: '1', Tanque: '120 L' }), /tiene 150 L/);
  assert.match(mov({ TamborID: 'No existe', Tanque: '60 L' }), /No existe el tanque/);
});

// ---- La pantalla ----
function cargarPantallaTanques(tambores, form, mps) {
  const ctx = { console, Math, String, Number, parseFloat, isFinite, Array, Object, Date };
  vm.createContext(ctx);
  vm.runInContext([
    tomar('function normalize'), tomar('function compararNatural'), tomar('function unique'), tomar('function similarityScore'),
    tomar('function resolverEnCatalogo'), tomar('function textoVariosCatalogo'),
    tomar('function conPunto'), tomar('function esNumero'), tomar('function baseRecord'),
    tomar('function getTamborOptions'), tomar('function infoTanque'),
    tomar('var _confirmoSoloConsumo'),
    tomar('function buildPreparacion()', '\n    function buildEmpaque()'),
  ].join('\n'), ctx);
  Object.assign(ctx, {
    valueOf: k => (form[k] == null ? '' : form[k]),
    leerFilasMp: () => (mps || []).map(m => Object.assign({ variante: '' }, m)),
    nuevoRequestId: () => 'req-prueba',
    getCatalog: () => ['Agua', 'Acido Sulfónico', 'CMC'],
    invItems: () => [],
    state: { catalogos: { tambores }, tamboresCargados: true },
    document: { getElementById: () => ({ checked: true }) },
  });
  return ctx;
}
const TANQUES_APP = [
  { id: '1', producto: 'Ambientadores de piso', tanque: 'Otro / revisar', disponible: 3, estado: 'Listo', capacidad: 170 },
  { id: '2', producto: 'Jabón líquido para manos', tanque: 'Otro / revisar', disponible: 2.5, estado: 'Listo', capacidad: null },
  { id: '9', producto: 'Limpgrax', tanque: '60 L', disponible: 0, estado: 'Vacío', capacidad: 60 },
];
const MPS_60 = [{ item: 'CMC', cantidad: '100', unidad: 'g' }, { item: 'Agua', cantidad: '60', unidad: 'L' }];

test('donde se escoge el tanque se ve "quedan X de Y L"', () => {
  const ctx = cargarPantallaTanques(TANQUES_APP, {});
  const etiquetas = ctx.getTamborOptions().map(o => o.label);
  assert.ok(etiquetas.some(l => /^1 · .*quedan 3 de 170 L/.test(l)), etiquetas.join(' | '));
  assert.ok(etiquetas.some(l => /^2 · .*quedan 2,5 L/.test(l) || /^2 · .*quedan 2.5 L/.test(l)), 'sin capacidad: solo lo que queda');
  assert.match(html, /de ' \+ [^;]*capacidad/, 'la pestaña de tanques tambien dice "de Y L"');
});

test('agregarle litros a un tanque con producto: no puede pasar la capacidad', () => {
  const ctx = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: '1', LitrosPreparados: '180' }, MPS_60);
  assert.match(ctx.buildPreparacion().error || '', /no caben/);
  const ok = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: '1', LitrosPreparados: '60' }, MPS_60).buildPreparacion();
  assert.ok(ok.records && ok.records.length === 1, ok.error);
  assert.equal(ok.records[0].Tanque, '', 'la capacidad ya estaba guardada: no se repite');
});

test('un tanque sin capacidad la PREGUNTA la primera vez, y la respuesta viaja en el registro', () => {
  const sin = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: '2', LitrosPreparados: '60' }, MPS_60).buildPreparacion();
  assert.match(sin.error || '', /De cuántos litros es el tanque 2/);
  assert.match(sin.error, /Capacidad del tanque/);
  const con = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: '2', LitrosPreparados: '60', Tanque: '170 L' }, MPS_60).buildPreparacion();
  assert.equal(con.records[0].Tanque, '170 L');
  // Un tanque nuevo tambien: sin capacidad no se guarda el lote.
  const nuevo = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: 'Tanque 99', Producto: 'Deterfull', LitrosPreparados: '60' }, MPS_60).buildPreparacion();
  assert.match(nuevo.error || '', /De cuántos litros es el tanque Tanque 99/);
  // El tanque vacio que ya la tiene guardada no pregunta, y frena por ella.
  const vacio = cargarPantallaTanques(TANQUES_APP, { Destino: 'tanque', TamborID: '9', Producto: 'Limpgrax', LitrosPreparados: '61' }, MPS_60).buildPreparacion();
  assert.match(vacio.error || '', /no caben/);
});

test('la capacidad de un tanque nunca se arrastra a otro (ni la que puso la app ni la escogida a mano)', () => {
  const upd = tomar('function updateTanqueCampos');
  assert.match(upd, /if \(cap\) ponerCapacidadGuardada\(cap\);/);
  assert.match(upd, /selCap\.dataset\.auto \|\|[\s\S]{0,120}selCap\.dataset\.para !== normalize\(nombre\)/);
  assert.match(source, /addEventListener\('change', function \(\) \{\s*delete this\.dataset\.auto;\s*this\.dataset\.para = normalize\(valueOf\('TamborID'\)\);/);
});

test('la pregunta "¿adicionales o total?" no ofrece adicionales cuando no caben', () => {
  assert.match(source, /NO PUEDEN SER ADICIONALES/);
  assert.match(source, /ACEPTAR  =  son el TOTAL del tanque/);
});
