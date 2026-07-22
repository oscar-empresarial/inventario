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

test('Revisiones carga una cola global independiente del rango de movimientos', () => {
  assert.match(source, /action:\s*'revision'/);
  assert.match(source, /if \(tab === 'revisar'\) loadRevision\(false\)/);
  assert.match(html, /Centro de revisiones/);
});

test('aprobar, renombrar y relacionar viajan como una sola decisión atómica', () => {
  assert.match(source, /TipoRegistro:'Revisión item'/);
  assert.match(source, /Accion:sel\.accion/);
  assert.match(html, /id="revMotivo"/);
  assert.match(html, /id="revResponsable"/);
});

test('formularios con varias líneas se envían como una operación compuesta', () => {
  assert.match(source, /TipoRegistro:'Movimiento compuesto'/);
  assert.match(source, /Movimientos:hijos/);
  assert.doesNotMatch(source, /for \(var i = 0; i < records\.length; i\+\+\)\s*\{\s*await enviarRegistro/);
});
