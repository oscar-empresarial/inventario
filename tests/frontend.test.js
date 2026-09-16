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

test('la interfaz ofrece correcciones rápidas de tanque, componentes y traslado', () => {
  assert.match(html, /data-tab="correcciones"/);
  assert.match(html, /id="btnCorregirTanque"/);
  assert.match(html, /id="btnCompletarProduccion"/);
  assert.match(html, /id="btnTrasladarSaldo"/);
  assert.match(source, /TipoRegistro:'Corrección tanque'/);
  assert.match(source, /TipoRegistro:'Corrección producción'/);
  assert.match(html, /id="corrTanqueAprobado"/);
  assert.match(html, /id="corrProduccionAprobado"/);
  assert.match(html, /1\. Elige el caso/);
  assert.match(html, /Preguntas rápidas antes de corregir/);
  assert.match(html, /¿Ya se empacó o salió alguna cantidad/);
});

test('los hallazgos de producción tienen una acción para completar materias primas', () => {
  assert.match(source, /data-conc-action="COMPLETAR_MP"/);
  assert.match(source, /abrirCompletarProduccion/);
});

test('Correcciones diagnostica Apps Script en vez de ocultar fallos de conexión', () => {
  assert.match(source, /function loadCorrecciones[\s\S]*diagnosticarConexion\(estado\)/);
});

test('inventario y selectores de tanque usan orden natural', () => {
  assert.match(source, /function compararNatural/);
  assert.match(source, /sort\(function\(a,b\)[\s\S]*compararNatural/);
});

// ================== EL INSUMO QUE SI EXISTE Y LA APP DECIA QUE NO ==================
//
// No se comprueba con un regex sobre el texto: se CORRE la funcion de verdad contra los
// nombres reales del catalogo del laboratorio (16-sep-2026). El freno quedo grabado el
// 12-sep: 'La materia prima "peroxido" no aparece en la lista', con "Peróxido 50%" en el
// catalogo y 155,93 L de saldo.
const vm = require('node:vm');
function cargarResolvedor() {
  const ctx = { console };
  vm.createContext(ctx);
  // Solo los tres ayudantes que necesita la decision; no hay DOM en la prueba.
  const trozos = ['function normalize', 'function unique', 'function similarityScore',
    'function resolverEnCatalogo', 'function textoVariosCatalogo'];
  const codigo = trozos.map(firma => {
    const i = source.indexOf(firma);
    assert.ok(i > 0, 'no se encontro ' + firma);
    // hasta la llave de cierre de la funcion, que va a 4 espacios de sangria
    const fin = source.indexOf('\n    }', i);
    return source.slice(i, fin + 6);
  }).join('\n');
  vm.runInContext(codigo, ctx);
  return ctx;
}
const CATALOGO_REAL = ['Acido Bórico', 'Acido Cítrico', 'Acido Nítrico 55%', 'Acido Sulfónico',
  'Alcohol 96%', 'Alcohol Puro', 'Peróxido 50%', 'Soda CAustica', 'Soda Líquida', 'Varsol', 'Limón'];

test('lo que el ingeniero teclea se resuelve contra el catalogo, no se rechaza', () => {
  const { resolverEnCatalogo } = cargarResolvedor();
  // Los dos casos reales: uno grabado en lab_rechazos, el otro dicho por Oscar.
  // (los objetos nacen dentro del vm, con otro prototipo: se comparan los campos)
  const perox = resolverEnCatalogo('peroxido', CATALOGO_REAL);
  assert.equal(perox.estado, 'ok');
  assert.equal(perox.nombre, 'Peróxido 50%');
  const sulf = resolverEnCatalogo('sulfonico', CATALOGO_REAL);
  assert.equal(sulf.estado, 'ok');
  assert.equal(sulf.nombre, 'Acido Sulfónico');
  // El nombre exacto sigue entrando igual, con tilde o sin ella.
  assert.equal(resolverEnCatalogo('Acido Sulfónico', CATALOGO_REAL).nombre, 'Acido Sulfónico');
  assert.equal(resolverEnCatalogo('acido sulfonico', CATALOGO_REAL).nombre, 'Acido Sulfónico');
});

test('cuando hay varios candidatos se PREGUNTA con la lista, nunca se escoge por el operario', () => {
  const { resolverEnCatalogo } = cargarResolvedor();
  const soda = resolverEnCatalogo('soda', CATALOGO_REAL);
  assert.equal(soda.estado, 'varios');
  assert.equal(Array.from(soda.opciones).sort().join('|'), 'Soda CAustica|Soda Líquida');
  assert.equal(resolverEnCatalogo('alcohol', CATALOGO_REAL).estado, 'varios');
  // y lo que de verdad no existe sigue sin existir
  assert.equal(resolverEnCatalogo('kriptonita', CATALOGO_REAL).estado, 'nada');
  assert.equal(resolverEnCatalogo('', CATALOGO_REAL).estado, 'vacio');
});

test('una tilde no mueve el consumo de la fragancia al saldo de la materia prima', () => {
  const { resolverEnCatalogo } = cargarResolvedor();
  // En el catalogo conviven "Limón" (materia prima) y "Limon" (fragancia): sin tildes son
  // la MISMA palabra. Lo escrito letra por letra manda; si no, se pregunta.
  const conTilde = ['Limón', 'Limon', 'Varsol'];
  assert.equal(resolverEnCatalogo('Limon', conTilde).nombre, 'Limon');
  assert.equal(resolverEnCatalogo('Limón', conTilde).nombre, 'Limón');
  assert.equal(resolverEnCatalogo('limon', conTilde).estado, 'varios');
});

test('lo que se guarda es el nombre del catalogo, no el tecleado (si no, el saldo se parte en dos)', () => {
  assert.match(source, /if \(resuelto\.estado === 'ok'\) m\.item = resuelto\.nombre;/);
  assert.match(source, /function validarItemCatalogo\(item, nuevoItem, opciones, aplicar\)/);
  assert.match(source, /aplicar\(resuelto\.nombre\)/);
});

test('el datalist de materias primas ofrece lo mismo que la validacion acepta', () => {
  assert.match(source, /function llenarDatalistMp\(\)[\s\S]*invItems\('Materia prima'\)/);
});
