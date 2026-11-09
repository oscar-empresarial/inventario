// La historia de un item (trazabilidad, 9-nov-2026): la pantalla pinta lo que manda el Worker
// (action 'historia') y NO escribe nada. Se prueba corriendo la funcion de verdad sobre una
// respuesta con la forma real, sin navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

function cortar(desde, hasta) {
  const a = source.indexOf(desde);
  const b = source.indexOf(hasta, a);
  assert.ok(a >= 0 && b > a, 'no encuentro ' + desde);
  return source.slice(a, b);
}

function cargar() {
  const escapeHtml = cortar('function escapeHtml(str)', '\n    function ').replace(/\n\s*$/, '');
  const nivel = cortar('var HIST_NIVEL', 'function verHistoriaItem');
  const pintar = cortar('function pintarHistoria(det, h)', 'function redondear(n)');
  const ctx = { out: null };
  vm.createContext(ctx);
  vm.runInContext(escapeHtml + '\n' + nivel + '\n' + pintar, ctx);
  return ctx;
}

const mov = (o) => Object.assign({ fila: 1, fecha: '2026-10-01T10:00:00Z', responsable: 'Carlos', tipo: 'Consumo materia prima', efecto: 'consumo', delta: -10, saldo: 90, unidad: 'L', cantidadOriginal: 10, unidadOriginal: 'L', producto: 'Desmanchador', detalle: 'Gastado en Desmanchador (16)', compra: null }, o);

function respuesta() {
  return {
    ok: true, item: 'Acido Nítrico 55%', variante: '', unidad: 'L', existe: true, saldo: 3,
    resumen: { movimientos: 3, entradas: 250, consumos: -30, ajustes: 0, conteos: 1, anuladas: 1 },
    movimientos: [
      mov({ fila: 10, efecto: 'conteo', delta: 50, saldo: 50, tipo: 'Conteo inventario', detalle: 'Conteo: el libro decia 0 y se conto 50 L', producto: '' }),
      mov({ fila: 20, efecto: 'entrada', delta: 250, saldo: 300, unidadOriginal: 'unidad', cantidadOriginal: 250, detalle: 'Llego por la compra #60', producto: '', compra: { compra: 60, renglon: 144 }, factura: { cantidad: 250, recibido: 250, unidad: 'unidad' } }),
      mov({ fila: 30, delta: -30, saldo: 270, producto: 'Ácido muriático', detalle: 'Gastado en Ácido muriático (Balde de trabajo)' }),
    ],
    anuladas: [{ fila: 5, fecha: '2026-09-01T10:00:00Z', responsable: 'Carlos', tipo: 'Consumo materia prima', cantidad: 5, unidad: 'L', producto: 'X' }],
    porProducto: [{ producto: 'Ácido muriático', veces: 1, total: 30, promedio: 30, ultimo: '2026-10-28T18:54:00Z' }],
    alertas: [
      { nivel: 'alto', codigo: 'conteo_absurdo', titulo: 'Un conteo dejo un saldo imposible', detalle: 'El 2026-07-27 Carlos conto 46030 L', filas: [10] },
      { nivel: 'medio', codigo: 'producto_parece_otro', titulo: 'Se gasto en un producto que parece de otro item', detalle: '30 L quedaron como gasto de "Ácido muriático"', filas: [30] },
    ],
  };
}

test('la historia pinta saldo, alertas, gasto por producto y movimientos', () => {
  const ctx = cargar();
  const det = { innerHTML: '', querySelector() { return null; } };
  ctx.pintarHistoria(det, respuesta());
  const h = det.innerHTML;
  assert.match(h, /Historia de Acido Nítrico 55%/);
  assert.match(h, /Hoy el libro dice <b>3 L<\/b>/);
  assert.match(h, /Revisar · Un conteo dejo un saldo imposible/);
  assert.match(h, /Mirar · Se gasto en un producto que parece de otro item/);
  assert.match(h, /En qué se gastó/);
  assert.match(h, /Compra #60: pidió 250 unidad, recibió 250/);
  assert.match(h, /Anuladas \(no cuentan en el saldo\)/);
});

test('las filas señaladas por una alerta salen en amarillo y las otras no', () => {
  const ctx = cargar();
  const det = { innerHTML: '', querySelector() { return null; } };
  ctx.pintarHistoria(det, respuesta());
  const filas = det.innerHTML.split('<tr ').filter(t => /fila \d+/.test(t));
  const amarillas = filas.filter(t => t.includes('#fef9c3')).map(t => (/fila (\d+)/.exec(t) || [])[1]);
  assert.deepEqual(amarillas.sort(), ['10', '30']);
  assert.equal(filas.length, 3);
});

test('sin movimientos dice que no hay y no revienta; el texto del servidor se escapa', () => {
  const ctx = cargar();
  const det = { innerHTML: '', querySelector() { return null; } };
  ctx.pintarHistoria(det, { ok: true, item: 'Sal', variante: '', unidad: 'kg', existe: false, saldo: 0, resumen: {}, movimientos: [], alertas: [] });
  assert.match(det.innerHTML, /todavía no tiene movimientos/);
  const det2 = { innerHTML: '', querySelector() { return null; } };
  const r = respuesta();
  r.alertas[0].detalle = '<img src=x onerror=alert(1)>';
  ctx.pintarHistoria(det2, r);
  assert.ok(!det2.innerHTML.includes('<img src=x'), 'el HTML del servidor se escapa');
});

test('mas de 40 movimientos: muestra 40 y ofrece ver los mas viejos', () => {
  const ctx = cargar();
  const det = { innerHTML: '', querySelector() { return null; } };
  const r = respuesta();
  r.movimientos = Array.from({ length: 55 }, (_, i) => mov({ fila: 100 + i, saldo: 500 - i }));
  ctx.pintarHistoria(det, r);
  assert.match(det.innerHTML, /Ver los 15 más viejos/);
  assert.equal((det.innerHTML.match(/fila 1\d\d/g) || []).length, 40);
});

test('el inventario abre la historia de lo que no es producto terminado y pide action historia al Worker', () => {
  assert.match(source, /data-hist-item=/);
  assert.match(source, /verHistoriaItem\(fila\.dataset\.histItem/);
  assert.match(source, /action: 'historia'/);
  assert.match(source, /ACCIONES_WORKER = \[[^\]]*'historia'/);
  // solo lectura: la historia no puede escribir en la hoja
  const trozo = cortar('function verHistoriaItem', 'function redondear(n)');
  assert.doesNotMatch(trozo, /enviarRegistro|method:\s*'POST'|TipoRegistro/);
});
