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

// ================== LA ETIQUETA ES POR TIPO, NUNCA POR TAMAÑO ==================
//
// Oscar, 2026-09-16: "cuando Carlos va a elegir la etiqueta del producto, aparecen todos
// los productos... por tamaño no se etiqueta, sino por tipo de producto. [Terpool] tiene
// una unica variacion: etiqueta de Terpool y ya".
//
// Igual que el resolvedor de insumos: no se comprueba con un regex, se CORREN las
// funciones de verdad contra el catalogo REAL de Siigo (catalogo_siigo.json).
function cargarEtiquetas() {
  const ctx = { console };
  vm.createContext(ctx);
  const trozo = firma => {
    const i = source.indexOf(firma);
    assert.ok(i > 0, 'no se encontro ' + firma);
    return source.slice(i, source.indexOf('\n    }', i) + 6);
  };
  const linea = marca => {
    const i = source.indexOf(marca);
    assert.ok(i > 0, 'no se encontro ' + marca);
    return source.slice(i, source.indexOf('\n', i));
  };
  const piezas = ['function normalize', 'function unique', 'function tamanoDe', 'function palabrasDe',
    'function skuDe', 'function buscarEnSiigo', 'function tipoDeEtiqueta', 'function quitarEnvase',
    'function invItems', 'function getEtiquetaOptions'];
  vm.runInContext('var siigoProductos=[];var siigoPorNombre={};var state={catalogos:{},inventario:[]};' +
    'var catalogosLocales={productos:[]};' +
    'function getCatalog(k){return unique((state.catalogos&&state.catalogos[k])||[]);}\n' +
    [linea('var RELLENO = ['), linea('var TAMANO_CON_NUMERO ='), linea('var TAMANO_SUELTO ='),
     linea('var NO_SE_ETIQUETA ='), linea('var COLOR_DEL_ENVASE =')].join('\n') + '\n' + piezas.map(trozo).join('\n'), ctx);
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalogo_siigo.json'), 'utf8'));
  ctx.siigoProductos = cat.productos;
  cat.productos.forEach(p => { ctx.siigoPorNombre[ctx.normalize(p.nombre)] = p.sku; });
  // Los nombres son los REALES que sirve el servidor (16-sep): el catalogo de producto
  // terminado se llama producto + envase, y de ahi salia la lluvia de tamaños.
  ctx.catalogosLocales.productos = ['Deterfull', 'Shoefull', 'Ecovarsol', 'Extermin',
    'Full desincrustante', 'Gotero eliminador de olores', 'Oxycolor', 'Varsol transparente'];
  ctx.state.catalogos = {
    etiquetas: ['Etiqueta', 'Deterfull', 'Extermin', 'Oxycolor'],
    envases: ['Galón 4 L', 'Opaco 4 L', 'Litro transparente 1 L', 'Envase transparente 500 ml',
      'Pimpina 20 L', 'Bomba fumigadora 2 L', 'Azul 1 L', 'Bolsa 500 g', 'Recarga litros'],
    presentaciones: ['Recarga litros', 'Bulto'],
    productos: ['Deterfull', 'Deterfull Galón 4 L', 'Deterfull transparente 1 L',
      'Deterfull Litro transparente 1 L', 'Deterfull Opaco 4 L', 'Deterfull Envase transparente 500 ml',
      'Extermin Pimpina 20 L', 'Extermin Bomba fumigadora 2 L', 'Extermin Recarga litros',
      'Oxycolor Azul 1 L', 'Ecovarsol transparente 4 L', 'Cera para pisos Galón 4 L']
  };
  // lo que ve el ingeniero: las opciones filtradas por lo que escribe, cortadas como las corta
  // renderSuggestions (18)
  ctx.verOpciones = escrito => {
    const q = ctx.normalize(escrito);
    return ctx.getEtiquetaOptions().filter(o => ctx.normalize(o).includes(q)).slice(0, 18);
  };
  return ctx;
}
const TAMANO_EN_EL_NOMBRE = /\b\d+\s*(?:cc|ml|lt|lts|gr|kg)\b|\bgalon|\bpimpina\b/i;

test('la lista de etiquetas no ofrece tamaños: un producto, un renglon', () => {
  const { verOpciones } = cargarEtiquetas();
  // Shoefull vive en Siigo en cuatro tamaños (250ml, 500cc, litro, galon) y Ecovarsol en
  // seis. La etiqueta es la MISMA para todos: tiene que salir UNA sola opcion.
  assert.deepEqual(Array.from(verOpciones('shoefull')), ['Shoefull']);
  assert.ok(verOpciones('ecovarsol').indexOf('Ecovarsol') >= 0);
  assert.ok(verOpciones('ecovarsol').length <= 2, 'Ecovarsol vuelve a salir por tamaños: ' +
    verOpciones('ecovarsol').join(' / '));
  // Los seis Deterfull del inventario (galon, litro, opaco, transparente, 500 ml) son UNA
  // etiqueta, y las tres presentaciones de Extermin tampoco se repiten.
  assert.deepEqual(Array.from(verOpciones('deterfull')), ['Deterfull', 'Deterfull Desengrasante Industrial']);
  assert.ok(verOpciones('extermin').indexOf('Extermin') >= 0);
  // (la "bomba fumigadora" si sigue: para la app es otra version del producto, no un
  // tamaño — esta en la lista DISTINGUEN que decidio Oscar el 18-ago)
  assert.equal(verOpciones('extermin').filter(o => /pimpina|recarga|\d/i.test(o)).length, 0,
    'siguen saliendo tamaños de Extermin: ' + verOpciones('extermin').join(' / '));
  // Y en ninguna busqueda puede salir un renglon que lo que diga sea un tamaño.
  ['extermin', 'deterfull', 'oxycolor', 'varsol', 'jacuzzi', 'cera'].forEach(q => {
    verOpciones(q).forEach(o => assert.doesNotMatch(o, TAMANO_EN_EL_NOMBRE,
      'la etiqueta "' + o + '" esta ofreciendo un TAMAÑO (busqueda: ' + q + ')'));
  });
});

test('combos, recargas, muestras y envases no son etiquetas', () => {
  const { verOpciones } = cargarEtiquetas();
  ['extermin', 'deterfull', 'ecovarsol'].forEach(q => {
    verOpciones(q).forEach(o => assert.doesNotMatch(o, /combo|kit|recarga|muestra|envase/i,
      '"' + o + '" no se etiqueta nunca (busqueda: ' + q + ')'));
  });
});

test('el producto de una sola presentacion se asigna solo; el que tiene varias, por SU tamaño', () => {
  const { buscarEnSiigo } = cargarEtiquetas();
  // UNA sola variacion (el caso que Oscar nombro): el gotero existe solo en 50 ml.
  const gotero = buscarEnSiigo('Gotero eliminador de olores', 'Frasco 50 ml');
  assert.equal(gotero.sku, 'NUE696');
  // VARIAS presentaciones de verdad: cada una por la suya, sin preguntar.
  assert.equal(buscarEnSiigo('Shoefull', 'Galón 4 L').sku, 'FUL77777');
  assert.equal(buscarEnSiigo('Shoefull', 'Botella 500 ml').sku, 'FUL54545');
  assert.equal(buscarEnSiigo('Shoefull', 'Tarro 1 L').sku, 'FUL7777');
  assert.equal(buscarEnSiigo('Oxycolor', 'Pimpina 20 L').sku, 'FUL185-8');
  assert.equal(buscarEnSiigo('Extermin', 'Galón 4 L').sku, 'FUL8875');
  // Deterfull: los cinco se llaman "Desengrasante Industrial", y esa palabra los dejaba a
  // todos en negativo. Antes del 16-sep la app no proponia NADA para ninguno de ellos.
  assert.equal(buscarEnSiigo('Deterfull', 'Galón 4 L').sku, '111235');
  assert.equal(buscarEnSiigo('Deterfull', 'Pimpina 20 L').sku, '1352');
  assert.equal(buscarEnSiigo('Deterfull', 'Litro transparente 1 L').sku, '222222');
  // Y la regla que Oscar dicto el 18-ago sigue en pie: la etiqueta sin aroma no se lleva
  // el producto con aroma.
  assert.equal(buscarEnSiigo('Extermin con aroma a limón', 'Galón 4 L').sku, 'FUL03652');
});

test('el tamaño NUNCA trae el producto de otra familia', () => {
  const { buscarEnSiigo } = cargarEtiquetas();
  // Los cuatro cruces medidos el 16-sep con el codigo viejo: el tamaño filtraba antes que
  // el nombre y el SKU de otro producto entraba callado.
  const cruces = [
    ['Full desincrustante', 'Tarro 1 L', /shoefull/i],
    ['Full desincrustante', 'Frasco 250 ml', /shoefull/i],
    ['Varsol transparente', 'Frasco 250 ml', /envase/i],
    ['Gotero eliminador de olores', 'Galón 4 L', /spray/i]
  ];
  cruces.forEach(([etiqueta, presentacion, prohibido]) => {
    const r = buscarEnSiigo(etiqueta, presentacion) || {};
    const nombres = r.sku ? [r.nombre] : (r.varios || []).map(p => p.nombre);
    nombres.forEach(n => assert.doesNotMatch(n, prohibido,
      etiqueta + ' + ' + presentacion + ' no puede terminar en "' + n + '"'));
  });
  // Y el galon del desincrustante, que SI es suyo, se sigue resolviendo solo.
  assert.equal(buscarEnSiigo('Full desincrustante', 'Galón 4 L').sku, 'LIM076');
});

test('el nombre del rollo nace del mismo sitio: no se crean etiquetas por tamaño', () => {
  // La casilla "Variante" de una entrada de Etiquetas es donde NACE el nombre del rollo.
  // Ofrecia el catalogo de producto terminado (producto + envase) y por ahi entraron los
  // rollos con tamaño en el nombre que hoy arrastra el inventario.
  assert.match(source, /function getVarianteOptions\(\)[\s\S]*getEtiquetaOptions\(\)/);
  assert.doesNotMatch(source, /function getVarianteOptions\(\)[\s\S]{0,400}\['Genérica'\]\.concat\(getCatalog\('productos'\)\)/);
});

// EL VINAGRE LLEVA SAL (16-sep-2026). Se CORRE buildPreparacion de verdad, con un formulario
// de mentiras: la pregunta tiene que salir cuando falta la sal, agregar la cantidad de la
// receta al aceptar, y no tocar lo que el ingeniero ya escribio.
function cargarPreparacion(form, mps) {
  const ctx = { console, Math, String, Number, parseFloat, isFinite, Array, Object };
  vm.createContext(ctx);
  const tomar = (firma, hasta) => {
    const i = source.indexOf(firma);
    assert.ok(i >= 0, 'no se encontro ' + firma);
    const fin = hasta ? source.indexOf(hasta, i) : source.indexOf('\n    }', i) + 6;
    assert.ok(fin > i, 'no se encontro el final de ' + firma);
    return source.slice(i, fin);
  };
  const codigo = [
    tomar('function normalize'), tomar('function unique'), tomar('function similarityScore'),
    tomar('function resolverEnCatalogo'), tomar('function textoVariosCatalogo'),
    tomar('function conPunto'), tomar('function esNumero'),
    tomar('var _confirmoSoloConsumo'),
    tomar('function buildPreparacion()', '\n    function buildEmpaque()'),
  ].join('\n');
  vm.runInContext(codigo, ctx);
  Object.assign(ctx, {
    valueOf: k => (form[k] == null ? '' : form[k]),
    leerFilasMp: () => mps.map(m => Object.assign({ variante: '' }, m)),
    infoTanque: () => null,
    baseRecord: tipo => ({ TipoRegistro: tipo }),
    getCatalog: () => ['Acético', 'Agua', 'Sal', 'Salicilato'],
    invItems: () => [],
    state: { catalogos: {} },
    document: { getElementById: () => ({ checked: true }) },
  });
  return ctx;
}

test('preparar vinagre sin sal PREGUNTA y al aceptar agrega la de la receta', () => {
  const form = { Destino: 'tanque', TamborID: '11', Producto: 'Vinagre para consumo y limpieza', LitrosPreparados: '119' };
  const ctx = cargarPreparacion(form, [{ item: 'Acético', cantidad: '3', unidad: 'L' }, { item: 'Agua', cantidad: '116', unidad: 'L' }]);
  const r = ctx.buildPreparacion();
  assert.ok(!r.error, r.error);
  assert.ok(r.confirmar, 'tenia que preguntar por la sal');
  assert.match(r.confirmar, /108 g de sal/);
  const records = r.build();
  assert.equal(records.length, 1);
  const sal = records[0].Componentes.filter(c => c.Item === 'Sal');
  assert.equal(sal.length, 1);
  assert.equal(sal[0].Cantidad, '108');
  assert.equal(sal[0].Unidad, 'g');
  // y la bandera no se queda prendida para la siguiente preparacion
  assert.ok(ctx.buildPreparacion().confirmar);
});

test('si el ingeniero ya puso la sal, vale la suya y no se pregunta', () => {
  const form = { Destino: 'tanque', TamborID: '11', Producto: 'Vinagre para consumo y limpieza', LitrosPreparados: '110' };
  const ctx = cargarPreparacion(form, [{ item: 'Acético', cantidad: '3', unidad: 'L' },
    { item: 'Agua', cantidad: '107', unidad: 'L' }, { item: 'sal', cantidad: '150', unidad: 'g' }]);
  const r = ctx.buildPreparacion();
  assert.ok(!r.error && !r.confirmar, r.error || r.confirmar);
  const sal = r.records[0].Componentes.filter(c => c.Item === 'Sal');
  assert.equal(sal.length, 1);
  assert.equal(sal[0].Cantidad, '150');
});

test('otro producto no pide sal, y la pregunta no tapa las demas validaciones', () => {
  const ctx = cargarPreparacion({ Destino: 'tanque', TamborID: '12', Producto: 'Deterfull', LitrosPreparados: '110' },
    [{ item: 'Agua', cantidad: '109', unidad: 'L' }, { item: 'Acético', cantidad: '1', unidad: 'L' }]);
  const r = ctx.buildPreparacion();
  assert.ok(!r.error && !r.confirmar && r.records.length === 1);
  // vinagre con la formula corta: primero el error de la formula, no la sal
  const ctx2 = cargarPreparacion({ Destino: 'tanque', TamborID: '11', Producto: 'Vinagre para consumo y limpieza', LitrosPreparados: '119' },
    [{ item: 'Acético', cantidad: '3', unidad: 'L' }, { item: 'Agua', cantidad: '50', unidad: 'L' }]);
  const r2 = ctx2.buildPreparacion();
  assert.match(r2.error || '', /incompleta/);
});
