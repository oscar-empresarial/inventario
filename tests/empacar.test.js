// EMPACAR (Oscar, 21-sep-2026). Dos pedidos, probados CORRIENDO las funciones de verdad de
// index.html con un formulario de mentiras (el mismo molde de la sal del vinagre):
//
//  1. "A Carlos no lo dejes guardar sin elegir a qué producto resulta; tiene que decir sí o
//     sí qué producto resulta."
//  2. "que le dé también cómo colocar cuánto sacó de más de materia prima — generalmente es
//     fragancia... cuánto echó en total para todo, o cuánto echó para cada uno".
//
// La mitad del servidor (que doPost tampoco lo guarde, y que los DOS motores descuenten lo
// mismo) esta en 3-INVENTARIO/app-ingeniero/prueba_empaque_resulta.mjs.
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
  // hasta la llave de cierre de la funcion, que va a 4 espacios de sangria
  const fin = source.indexOf('\n    }', i) + 6;
  assert.ok(fin > i, 'no se encontro el final de ' + firma);
  return source.slice(i, fin);
}

const CATALOGOS = {
  materiasPrimas: ['Agua', 'Varsol', 'Limón', 'Acido Sulfónico'],
  fragancias: ['Lavanda', 'Manzana verde', 'Limon', 'Esencia (Coco)'],
  colores: ['Azul'],
  solidos: ['Bicarbonato'],
};

function cargar(form, filasMp, opciones = {}) {
  const ctx = { console, Math, String, Number, parseFloat, isFinite, Array, Object, RegExp, JSON };
  vm.createContext(ctx);
  const codigo = [
    'function normalize', 'function unique', 'function similarityScore', 'function resolverEnCatalogo',
    'function textoVariosCatalogo', 'function conPunto', 'function esNumero', 'function hasSize',
    'function validarPresentacion', 'function recordMerma', 'function validarItemCatalogo',
    'function fmtMpEmpaque', 'function cuentaMpEmpaque', 'function litrosEmpacadosMp', 'function aLitrosMp',
    'function armarMpEmpaque', 'function registrosMpEmpaque', 'function faltaProductoResultante',
    'function buildEmpaque()', 'function buildRecords()',
  ].map(tomar).join('\n');
  vm.runInContext(codigo, ctx);
  const pintado = [];
  Object.assign(ctx, {
    valueOf: k => (form[k] == null ? '' : String(form[k])),
    leerFilasMpEmpaque: () => filasMp || [],
    baseRecord: tipo => ({ TipoRegistro: tipo, Responsable: 'Carlos', Observacion: form.Observacion || '' }),
    getCatalog: k => CATALOGOS[k] || [],
    invItems: () => [],
    getItemOptions: () => CATALOGOS.materiasPrimas.concat(CATALOGOS.solidos),
    tamborExiste: () => opciones.tamborExiste !== false,
    productoDelTanqueUI: () => 'Deterfull',
    sugerirResultante: () => opciones.propuesta || null,
    pintarResultante: h => pintado.push(h),
    state: { catalogos: {}, selectedType: form.tipo || 'Empacar producto' },
    document: { getElementById: () => ({ checked: false }) },
  });
  ctx.pintado = pintado;
  return ctx;
}

// Un empaque normal: 20 galones de Deterfull del tanque 5.
const GALONES = {
  Responsable: 'Carlos', Subempaque: 'tambor', TamborID: '5', Presentacion: 'Galon transparente 4 L',
  CantidadPresentacion: '20', Etiqueta: 'Deterfull', Accesorio: 'Tapa normal', SkuResultante: '111235',
};
const con = (cambios) => Object.assign({}, GALONES, cambios);

// ================== 1. EL PRODUCTO QUE RESULTA ES OBLIGATORIO ==================

test('un empaque SIN producto que resulta NO se guarda: mensaje claro y ningun registro', () => {
  const r = cargar(con({ SkuResultante: '' }), []).buildEmpaque();
  assert.ok(r.error, 'se dejo guardar un empaque sin producto que resulta');
  assert.match(r.error, /a qué producto resulta/i);
  assert.ok(!r.records && !r.build && !r.confirmar, 'no puede salir nada para guardar');
});

test('si la propuesta sale al guardar, se MUESTRA y aun asi no se guarda en ese toque', () => {
  const ctx = cargar(con({ SkuResultante: '' }), [], { propuesta: { sku: '111235', nombre: 'DETERFULL GALON' } });
  const r = ctx.buildEmpaque();
  assert.match(r.error || '', /propone DETERFULL GALON \(111235\)/);
  assert.ok(!r.records, 'la app no puede escoger por el ingeniero');
  assert.equal(ctx.pintado.length, 1, 'la propuesta se pinta en "¿A qué producto resulta?" para que la vea');
});

test('lo que se guarda es lo que se VE: el SKU ya no se rellena por debajo con el buscador', () => {
  const cuerpo = tomar('function buildEmpaque()');
  assert.doesNotMatch(cuerpo, /hallado\s*&&\s*hallado\.sku/);
  assert.doesNotMatch(tomar('function buildRecords()'), /halladoP\s*&&\s*halladoP\.sku/);
  const r = cargar(GALONES, []).buildEmpaque();
  assert.ok(!r.error, r.error);
  assert.equal(r.records[0].SKU, '111235');
});

test('las recargas salen sin etiqueta pero SI resultan a un producto (RCG-...)', () => {
  const recarga = con({ TamborID: '7', Presentacion: 'Recarga litros', CantidadPresentacion: '12',
    Etiqueta: 'Sin etiqueta', Accesorio: 'Sin accesorio' });
  const bien = cargar(Object.assign({}, recarga, { SkuResultante: 'RCG-LCQ204' }), []).buildEmpaque();
  assert.ok(!bien.error, bien.error);
  assert.equal(bien.records.length, 1);
  assert.equal(bien.records[0].SKU, 'RCG-LCQ204');
  const sin = cargar(Object.assign({}, recarga, { SkuResultante: '' }), []).buildEmpaque();
  assert.match(sin.error || '', /a qué producto resulta/i);
});

test('empacar materia prima directa y solido/polvo tambien exigen el producto que resulta', () => {
  const mp = { Responsable: 'Carlos', Subempaque: 'materia', Item: 'Varsol', Presentacion: 'Litro transparente 1 L',
    CantidadPresentacion: '10', Etiqueta: 'Varsol', Accesorio: 'Tapa normal' };
  assert.match(cargar(Object.assign({ SkuResultante: '' }, mp), []).buildEmpaque().error || '', /a qué producto resulta/i);
  const rMp = cargar(Object.assign({ SkuResultante: '258' }, mp), []).buildEmpaque();
  assert.ok(!rMp.error, rMp.error);
  assert.equal(rMp.records[0].SKU, '258');

  const solido = { tipo: 'Empacar sólido/polvo', Responsable: 'Carlos', Item: 'Bicarbonato', Presentacion: 'Bolsa 500 g',
    CantidadPresentacion: '10', Etiqueta: 'Bicarbonato' };
  const sinS = cargar(Object.assign({ SkuResultante: '' }, solido), []).buildRecords();
  assert.match(sinS.error || '', /a qué producto resulta/i);
  const conS = cargar(Object.assign({ SkuResultante: 'BIC500' }, solido), []).buildRecords();
  assert.ok(!conS.error, conS.error);
  assert.equal(conS.records[0].SKU, 'BIC500');
});

// ================== 2. LA MATERIA PRIMA QUE SE ECHA AL EMPACAR ==================

test('30 ml POR CADA UNIDAD x 20 galones = 600 ml de fragancia, en el mismo movimiento', () => {
  const r = cargar(GALONES, [{ item: 'Lavanda', cantidad: '30', unidad: 'ml', modo: 'unidad' }]).buildEmpaque();
  assert.ok(!r.error, r.error);
  assert.equal(r.records.length, 2);
  const frag = r.records[1];
  assert.equal(frag.TipoRegistro, 'Consumo materia prima');   // el MISMO tipo de "Preparé"
  assert.equal(frag.Item, 'Lavanda');
  assert.equal(frag.Categoria, 'Fragancia');
  assert.equal(frag.Cantidad, '600');
  assert.equal(frag.Unidad, 'ml');
  assert.equal(frag.TamborID, '5');
  assert.equal(frag.Producto, 'Deterfull');
  assert.match(frag.Observacion, /30 ml por cada unidad × 20 unidades = 600 ml/);
});

test('"para todo lo empacado" descuenta exactamente lo que se escribio', () => {
  const r = cargar(GALONES, [{ item: 'lavanda', cantidad: '250', unidad: 'ml', modo: 'total' }]).buildEmpaque();
  assert.ok(!r.error, r.error);
  assert.equal(r.records[1].Cantidad, '250');
  assert.equal(r.records[1].Item, 'Lavanda');   // el nombre del catalogo, no el tecleado
  const coma = cargar(GALONES, [{ item: 'Lavanda', cantidad: '0,25', unidad: 'L', modo: 'total' }]).buildEmpaque();
  assert.equal(coma.records[1].Cantidad, '0.25');
});

test('varias materias primas, cada una con su categoria (y la tilde no cruza fragancia con MP)', () => {
  const r = cargar(GALONES, [
    { item: 'Lavanda', cantidad: '20', unidad: 'ml', modo: 'unidad' },
    { item: 'Azul', cantidad: '5', unidad: 'ml', modo: 'total' },
    { item: 'Limón', cantidad: '100', unidad: 'ml', modo: 'total' },
    { item: 'Esencia (Coco)', cantidad: '10', unidad: 'ml', modo: 'total' },
  ]).buildEmpaque();
  assert.ok(!r.error, r.error);
  const por = n => r.records.find(x => x.Item === n) || {};
  assert.equal(por('Lavanda').Cantidad, '400');
  assert.equal(por('Azul').Categoria, 'Color');
  assert.equal(por('Limón').Categoria, 'Materia prima');   // "Limon" es la fragancia; "Limón", la MP
  assert.equal(por('Esencia').Variante, 'Coco');            // se guarda partida, como la parte doPost
});

test('si el tanque no aparece y se confirma, la fragancia viaja IGUAL (no solo el empaque)', () => {
  const r = cargar(GALONES, [{ item: 'Lavanda', cantidad: '30', unidad: 'ml', modo: 'unidad' }], { tamborExiste: false }).buildEmpaque();
  assert.ok(r.confirmar, 'tenia que preguntar por el tanque');
  const lista = r.build();
  assert.ok(lista.some(x => x.TipoRegistro === 'Consumo materia prima' && x.Cantidad === '600'));
});

test('la cuenta imposible se frena: 30 L por galon son mas que todo lo empacado', () => {
  const r = cargar(GALONES, [{ item: 'Lavanda', cantidad: '30', unidad: 'L', modo: 'unidad' }]).buildEmpaque();
  assert.match(r.error || '', /igual o más que TODO lo que empacaste/);
});

test('renglon repetido, sin cantidad o que no existe: se dice y no se guarda nada', () => {
  const rep = cargar(GALONES, [{ item: 'Lavanda', cantidad: '1', unidad: 'ml' }, { item: 'lavanda', cantidad: '2', unidad: 'ml' }]).buildEmpaque();
  assert.match(rep.error || '', /repetida/);
  const sinCant = cargar(GALONES, [{ item: 'Lavanda', cantidad: '', unidad: 'ml' }]).buildEmpaque();
  assert.match(sinCant.error || '', /Ponle cantidad a "Lavanda"/);
  const noEsta = cargar(GALONES, [{ item: 'Perfume de marte', cantidad: '3', unidad: 'ml' }]).buildEmpaque();
  assert.match(noEsta.error || '', /no aparece en la lista/);
});

test('sin renglones de materia prima el empaque sale igual que siempre', () => {
  const r = cargar(GALONES, []).buildEmpaque();
  assert.ok(!r.error, r.error);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].TipoRegistro, 'Empacar desde tambor');
});

test('solido/polvo y materia prima directa tambien llevan su materia prima del empaque', () => {
  const solido = { tipo: 'Empacar sólido/polvo', Responsable: 'Carlos', Item: 'Bicarbonato', Presentacion: 'Bolsa 500 g',
    CantidadPresentacion: '10', Etiqueta: 'Bicarbonato', SkuResultante: 'BIC500' };
  const s = cargar(solido, [{ item: 'Lavanda', cantidad: '2', unidad: 'ml', modo: 'unidad' }]).buildRecords();
  assert.ok(!s.error, s.error);
  assert.equal(s.records[1].Cantidad, '20');
  assert.equal(s.records[1].Producto, 'Bicarbonato');
});

test('la seccion existe en la pantalla, se muestra en los tres empaques y se limpia al guardar', () => {
  assert.match(html, /data-field="mpextra"/);
  assert.match(html, /id="mpExtraLista"/);
  assert.match(source, /'Empacar sólido\/polvo': \[[^\]]*'mpextra'/);
  const sub = tomar('function updateSubempaque');
  assert.equal((sub.match(/'mpextra'/g) || []).length, 3, 'se esconde y se muestra en los dos subtipos');
  assert.match(tomar('function resetForm'), /limpiarFilasMpEmpaque\(\)/);
  // Y la clase de los renglones NO es la de "Preparé": leerFilasMp() lee todo '.mp-fila'.
  assert.doesNotMatch(tomar('function agregarFilaMpEmpaque'), /className = 'mp-fila'/);
});
