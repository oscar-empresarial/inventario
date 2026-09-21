// LA VARIANTE VACIA NO ES LA REFERENCIA (21-sep-2026). Lo encontro el chat que cambio Empacar:
// parseInventario aceptaba la columna 'Referencia' como variante. Referencia es el nivel MAS
// ALTO que ha tenido el item (lo usa el semaforo de compras), un numero, nunca una variante.
// Con la variante vacia, pickField caia a la Referencia y:
//   - el inventario mostraba "Varsol · 56" (Varsol tiene 14,69 L y su Referencia es 56),
//   - el aviso de despues de guardar decia que NO habia Varsol, porque buscaba la variante ''
//     y el renglon tenia '56' (56 items con existencia salian como "no hay"),
//   - 18 productos terminados sin lote mostraban un "Lote: 10" inventado,
//   - la vista previa de Empacar no podia buscar el renglon sin variante.
// Los datos de abajo son los renglones REALES que devuelve /lab/api (action=inventario).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

function tomar(firma) {
  const i = source.indexOf(firma);
  assert.ok(i >= 0, 'no se encontro ' + firma);
  const fin = source.indexOf('\n    }', i) + 6;
  assert.ok(fin > i, 'no se encontro el final de ' + firma);
  return source.slice(i, fin);
}

const INVENTARIO_REAL = {
  items: [
    { Item: 'Varsol', Variante: '', Categoria: 'Materia prima', Stock: 14.69, Unidad: 'L', Minimo: '', Referencia: 56 },
    { Item: 'Varsol', Variante: 'Limon', Categoria: 'Materia prima', Stock: 0, Unidad: 'L', Minimo: '', Referencia: 3 },
    { Item: 'Varsol Galon transparente 4 L', Variante: '', Categoria: 'Producto terminado', Stock: 10, Unidad: 'und', Minimo: '', Referencia: 10 },
    { Item: 'Ecovarsol Galon transparente 4 L', Variante: '12', Categoria: 'Producto terminado', Stock: 39, Unidad: 'und', Minimo: '', Referencia: 39 },
    { Item: 'Etiqueta', Variante: '', Categoria: 'Etiqueta', Stock: 5, Unidad: 'und', Minimo: '', Referencia: 56 },
    { Item: 'Etiqueta', Variante: 'Deterfull', Categoria: 'Etiqueta', Stock: 300, Unidad: 'und', Minimo: '', Referencia: 900 },
  ],
  tambores: [],
};

function cargar() {
  const ctx = { console, Math, String, Number, parseFloat, isFinite, isNaN, Array, Object, RegExp, JSON, Date };
  vm.createContext(ctx);
  const codigo = [
    'function normalize', 'function conPunto', 'function parseInventario', 'function pickField',
    'function nombreDe', 'function faltantesDe', 'function fmtMpEmpaque', 'function cuentaMpEmpaque',
    'function pintarCuentasMpEmpaque',
  ].map(tomar).join('\n');
  vm.runInContext(codigo, ctx);
  ctx.state = { catalogos: {} };
  ctx.lsGet = () => null;
  ctx.BOM_PALOS_JS = { rosca: [], mariposa: [] };
  ctx.state.inventario = ctx.parseInventario(INVENTARIO_REAL);
  return ctx;
}

test('Varsol sin variante se ve "Varsol", no "Varsol · 56"', () => {
  const ctx = cargar();
  const varsol = ctx.state.inventario.find(r => r.item === 'Varsol' && r.stock === 14.69);
  assert.ok(varsol, 'no se cargo el renglon de Varsol');
  assert.equal(String(varsol.variante), '', 'la variante vacia tiene que seguir vacia');
  assert.equal(ctx.nombreDe(varsol), 'Varsol');
  assert.ok(!/·\s*56/.test(ctx.nombreDe(varsol)), 'salio "' + ctx.nombreDe(varsol) + '"');
  // La Referencia sigue sirviendo para lo suyo: el semaforo de compras.
  assert.equal(varsol.referencia, 56);
});

test('una variante de verdad se sigue mostrando', () => {
  const ctx = cargar();
  const limon = ctx.state.inventario.find(r => r.item === 'Varsol' && String(r.variante) === 'Limon');
  assert.ok(limon, 'se perdio Varsol · Limon');
  assert.equal(ctx.nombreDe(limon), 'Varsol · Limon');
  const eco = ctx.state.inventario.find(r => r.item === 'Ecovarsol Galon transparente 4 L');
  assert.equal(String(eco.variante), '12', 'el lote de un producto terminado es su variante');
  const etq = ctx.state.inventario.find(r => r.item === 'Etiqueta' && r.stock === 300);
  assert.equal(ctx.nombreDe(etq), 'Deterfull (etiqueta)');
});

test('un producto terminado sin lote no muestra un lote inventado', () => {
  const ctx = cargar();
  const galon = ctx.state.inventario.find(r => r.item === 'Varsol Galon transparente 4 L');
  assert.equal(String(galon.variante), '', 'salio con lote "' + galon.variante + '"');
  assert.equal(ctx.nombreDe(galon), 'Varsol Galon transparente 4 L');
});

test('una etiqueta sin variante no sale como "56 (etiqueta)"', () => {
  const ctx = cargar();
  const etq = ctx.state.inventario.find(r => r.item === 'Etiqueta' && r.stock === 5);
  assert.equal(ctx.nombreDe(etq), 'Etiqueta');
});

test('el aviso de despues de guardar NO dice que falta Varsol (hay 14,69 L)', () => {
  const ctx = cargar();
  const faltan = ctx.faltantesDe([
    { TipoRegistro: 'Consumo materia prima', Item: 'Varsol', Variante: '', Categoria: 'Materia prima', Unidad: 'L' },
    { TipoRegistro: 'Salida directa/Baja', Item: 'Varsol Galon transparente 4 L', Variante: '', Categoria: 'Producto terminado', Unidad: 'und' },
  ]);
  assert.deepEqual(Array.from(faltan, f => f.item + "|" + f.variante), []);
});

test('el aviso SI dice que falta lo que de verdad esta en cero', () => {
  const ctx = cargar();
  const faltan = ctx.faltantesDe([
    { TipoRegistro: 'Consumo materia prima', Item: 'Varsol', Variante: 'Limon', Categoria: 'Materia prima', Unidad: 'L' },
  ]);
  assert.deepEqual(Array.from(faltan, f => f.item + "|" + f.variante), ['Varsol|Limon']);
});

test('Empacar: la vista previa muestra el saldo del Varsol que se descuenta (el sin variante)', () => {
  const ctx = cargar();
  const caja = { textContent: '' };
  const campos = {
    '.mpe-item': { value: 'Varsol' }, '.mpe-cant': { value: '2' },
    '.mpe-uni': { value: 'L' }, '.mpe-modo': { value: 'total' }, '.mpe-cuenta': caja,
  };
  const fila = { querySelector: sel => campos[sel] };
  ctx.valueOf = k => ({ CantidadPresentacion: '10', Presentacion: 'Galon transparente 4 L' })[k] || '';
  ctx.document = { querySelectorAll: () => [fila] };
  ctx.pintarCuentasMpEmpaque();
  assert.match(caja.textContent, /en inventario: 14,69 L/, 'salio: ' + caja.textContent);
});
