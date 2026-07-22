const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
const source = scripts.map(match => match[1]).join('\n');

test('JavaScript de la interfaz tiene sintaxis válida', () => assert.doesNotThrow(() => new Function(source)));
test('cada movimiento genera RequestId', () => {
  assert.match(source, /RequestId:\s*nuevoRequestId\(\)/);
  assert.match(source, /crypto\.randomUUID/);
});
test('producción viaja como una operación con fórmula y componentes', () => {
  assert.match(source, /produccion\.FormulaCompleta\s*=\s*true/);
  assert.match(source, /produccion\.Componentes\s*=\s*componentes/);
});
test('la app confirma el resultado con el servidor', () => {
  assert.match(source, /action:\s*'operacion'/);
  assert.match(source, /Guardado y confirmado/);
});
test('la interfaz exige referencia para una corrección', () => {
  assert.match(html, /id="ReferenciaOriginal"/);
  assert.match(source, /ReferenciaOriginal/);
});
test('la interfaz expone conciliación automática', () => {
  assert.match(source, /action:\s*'conciliacion'/);
  assert.match(html, /id="conciliacionEstado"/);
});
