/**
 * ============================================================
 * FULL COMPANY · API v2 para GitHub Pages (Google Apps Script)
 * ============================================================
 *
 * NOVEDAD PRINCIPAL: el inventario YA NO depende de la hoja INVENTARIO.
 * Se calcula automáticamente leyendo todos los movimientos de REGISTRO_APP:
 *  - "Entrada mercancía"        → suma
 *  - "Consumo materia prima"    → resta
 *  - "Preparar tambor"          → crea tambor enumerado (Tambor 1…) o balde; si el nombre ya existe, ADICIONA litros
 *  - "Empacar desde tambor"     → resta envases, etiquetas y accesorios; suma producto terminado; descuenta litros del tambor
 *  - "Empacar materia prima"    → resta la materia prima (por tamaño del envase), el envase, etiqueta y accesorio
 *  - "Empacar sólido/polvo"     → resta bolsas/tarros, etiquetas y el polvo (por peso); suma producto terminado
 *  - "Salida directa/Baja"      → resta
 *  - "Fabricar palos"           → suma palos y resta materiales (ver BOM_PALOS abajo)
 *  - "Conteo inventario"        → FIJA la existencia en lo que se contó físicamente
 *  - "Novedad/Corrección"       → NO cambia stock, solo queda en la trazabilidad
 *
 * CÓMO INSTALARLO:
 * 1. Abre tu proyecto de Apps Script.
 * 2. Borra TODO el contenido de Código.gs y pega este archivo completo.
 * 3. Verifica el ID_HOJA de abajo (el que está en la URL de tu hoja de cálculo).
 * 4. Guarda. Ejecuta una vez la función "probarConfiguracion" (botón Ejecutar)
 *    y acepta los permisos. En "Registro de ejecución" debe listar tus pestañas.
 * 5. Implementar → Administrar implementaciones → lápiz (editar) →
 *    Versión: "Nueva versión" → Implementar.
 *    ⚠️ NO crees una implementación nueva: edita la existente para que
 *    la URL /exec no cambie. Y debe decir "Quién tiene acceso: Cualquier usuario".
 *
 * QUÉ RESPONDE:
 * - GET ?action=init&callback=fn                    → catálogos (hoja CATALOGOS)
 * - GET ?action=inventario&callback=fn              → existencias calculadas
 * - GET ?action=registros&desde=...&hasta=...&callback=fn → movimientos (trazabilidad/exportar)
 * - POST (JSON)                                     → guarda fila en REGISTRO_APP
 *
 * ------------------------------------------------------------------
 * RECUPERADO 2026-07-21 por Claude: este archivo se sobreescribió por
 * error con el script de automatización de Whatsfy entre el 17 de julio
 * 10:57am (Versión 12, buena) y el 18 de julio 3:58pm (Versión 13, ya
 * con el código equivocado). Se restauró desde el historial de versiones
 * del proyecto de Apps Script ("Inventario"). Se guarda aquí una copia
 * en el repositorio para que nunca vuelva a perderse en silencio.
 * ------------------------------------------------------------------
 */

// ⚠️ ID de tu hoja de cálculo (está en la URL: docs.google.com/spreadsheets/d/ESTE_ID/edit)
var ID_HOJA = '12ESQ1wlLeLpfbpfCzjFrxip-M4AC58y4iIXbjOO1Rqk';

var HOJA_REGISTRO = 'REGISTRO_APP';
var HOJA_CATALOGOS = 'CATALOGOS';
var HOJA_MINIMOS = 'MINIMOS'; // opcional: columnas Item | Minimo (para alertas de "poco stock")

// Materiales que se descuentan por cada palo fabricado. Ajusta si tu receta es otra.
var BOM_PALOS = {
  rosca: ['Tubo aluminio {largo}', 'Mango', 'Caucho', 'Rosca', 'Etiqueta'],
  mariposa: ['Tubo aluminio {largo}', 'Mango', 'Caucho', 'Cabezote mariposa', 'Etiqueta', 'Lámina', 'Tornillo']
};

function getHoja() {
  return SpreadsheetApp.openById(ID_HOJA);
}

// Ejecuta esta función una vez desde el editor para verificar que todo conecta.
function probarConfiguracion() {
  var ss = getHoja();
  Logger.log('Archivo: ' + ss.getName());
  ss.getSheets().forEach(function (h) {
    Logger.log('Pestaña: ' + h.getName() + ' (' + h.getLastRow() + ' filas)');
  });
  var reg = ss.getSheetByName(HOJA_REGISTRO);
  if (!reg) {
    Logger.log('⚠️ NO existe la pestaña ' + HOJA_REGISTRO + '. El guardado y el inventario no funcionarán.');
  } else {
    Logger.log('Encabezados de ' + HOJA_REGISTRO + ': ' + reg.getRange(1, 1, 1, reg.getLastColumn()).getValues()[0].join(' | '));
  }
  var inv = getInventario();
  Logger.log('Inventario calculado: ' + inv.items.length + ' ítems.');
}

// ================== ENTRADA GET ==================
function doGet(e) {
  var p = (e && e.parameter) || {};
  var data;
  try {
    if (p.action === 'init') {
      data = getInit();
    } else if (p.action === 'inventario') {
      data = getInventario();
    } else if (p.action === 'registros') {
      data = getRegistros(p.desde, p.hasta);
    } else {
      data = { ok: true, mensaje: 'API Full Company v2 activa' };
    }
  } catch (err) {
    data = { ok: false, error: String(err) };
  }
  return salida(data, p.callback);
}

function salida(data, callback) {
  var json = JSON.stringify(data);
  if (callback) {
    var nombre = String(callback).replace(/[^\w.]/g, '');
    return ContentService
      .createTextOutput(nombre + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ================== CATÁLOGOS (action=init) ==================
function getInit() {
  var mapa = {
    'materia prima': 'materiasPrimas',
    'materias primas': 'materiasPrimas',
    'fragancia': 'fragancias',
    'fragancias': 'fragancias',
    'variantes': 'fragancias',
    'variantes fragancia': 'fragancias',
    'color': 'colores',
    'colores': 'colores',
    'envase': 'envases',
    'envases': 'envases',
    'accesorio': 'accesorios',
    'accesorios': 'accesorios',
    'etiqueta': 'etiquetas',
    'etiquetas': 'etiquetas',
    'material palo': 'materialesPalos',
    'materiales palos': 'materialesPalos',
    'solidos': 'solidos',
    'solidos / polvos': 'solidos',
    'producto terminado': 'productos',
    'productos': 'productos',
    'productos terminados': 'productos',
    'presentacion': 'presentaciones',
    'presentaciones': 'presentaciones'
  };
  var out = {};
  var hoja = getHoja().getSheetByName(HOJA_CATALOGOS);
  if (hoja) {
    var valores = hoja.getDataRange().getValues();
    if (valores.length >= 2) {
      var titulos = valores[0];
      for (var c = 0; c < titulos.length; c++) {
        var clave = mapa[normalizar(titulos[c])];
        if (!clave) continue;
        var lista = [];
        for (var f = 1; f < valores.length; f++) {
          var v = String(valores[f][c] || '').trim();
          if (v) lista.push(v);
        }
        if (lista.length) out[clave] = lista;
      }
    }
  }
  // tambores disponibles calculados desde los movimientos
  try {
    out.tambores = getInventario().tambores || [];
  } catch (err) {
    out.tambores = [];
  }
  return out;
}

// ================== LECTURA DE REGISTRO_APP ==================
function leerRegistros() {
  var hoja = getHoja().getSheetByName(HOJA_REGISTRO);
  if (!hoja) throw new Error('No existe la pestaña ' + HOJA_REGISTRO);
  var valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return { encabezados: [], filas: [] };
  var encabezados = valores[0].map(function (t) { return String(t || '').trim(); });
  var filas = [];
  for (var f = 1; f < valores.length; f++) {
    var obj = {};
    var vacia = true;
    for (var c = 0; c < encabezados.length; c++) {
      if (!encabezados[c]) continue;
      var v = valores[f][c];
      obj[encabezados[c]] = (v instanceof Date) ? v.toISOString() : v;
      if (v !== '' && v != null) vacia = false;
    }
    if (!vacia) filas.push(obj);
  }
  return { encabezados: encabezados, filas: filas };
}

function campo(obj, nombres) {
  for (var k in obj) {
    var nk = normalizar(k).replace(/[ _]/g, '');
    if (nombres.indexOf(nk) >= 0) return obj[k] == null ? '' : obj[k];
  }
  return '';
}

// ================== REGISTROS (action=registros) ==================
function getRegistros(desde, hasta) {
  var datos = leerRegistros();
  var filas = datos.filas;
  if (desde || hasta) {
    filas = filas.filter(function (r) {
      var f = String(campo(r, ['fecha', 'timestamp', 'fechaservidor', 'fechacliente']) || '');
      var dia = f.slice(0, 10); // YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}/.test(dia)) return true; // sin fecha legible: incluir
      if (desde && dia < desde) return false;
      if (hasta && dia > hasta) return false;
      return true;
    });
  }
  if (filas.length > 1000) filas = filas.slice(filas.length - 1000);
  return { registros: filas };
}

// ================== INVENTARIO CALCULADO (action=inventario) ==================
function getInventario() {
  var datos = leerRegistros();
  var stock = {}; // clave item|variante → {Item, Variante, Categoria, Stock, Unidad}
  var tambores = [];

  function mover(item, variante, categoria, delta, unidad) {
    item = String(item || '').trim();
    if (!item) return;
    variante = String(variante || '').trim();
    var conv = aBase(delta, unidad);
    var clave = normalizar(item) + '|' + normalizar(variante);
    if (!stock[clave]) {
      stock[clave] = { Item: item, Variante: variante, Categoria: categoria || '', Stock: 0, Unidad: conv.u, Referencia: 0 };
    }
    if (!stock[clave].Categoria && categoria) stock[clave].Categoria = categoria;
    stock[clave].Stock += conv.v;
    // Referencia = nivel más alto que ha tenido: sirve para las alertas de compra (1/3 y 10%)
    if (stock[clave].Stock > (stock[clave].Referencia || 0)) stock[clave].Referencia = stock[clave].Stock;
  }
  function fijar(item, variante, categoria, cantidad, unidad) {
    item = String(item || '').trim();
    if (!item) return;
    variante = String(variante || '').trim();
    var conv = aBase(cantidad, unidad);
    var clave = normalizar(item) + '|' + normalizar(variante);
    var refAnt = stock[clave] ? (stock[clave].Referencia || 0) : 0;
    stock[clave] = { Item: item, Variante: variante, Categoria: categoria || (stock[clave] ? stock[clave].Categoria : ''), Stock: conv.v, Unidad: conv.u, Referencia: Math.max(refAnt, conv.v) };
  }

  datos.filas.forEach(function (r) {
    var tipo = normalizar(campo(r, ['tiporegistro', 'tipo']));
    var item = String(campo(r, ['item']) || '').trim();
    var variante = String(campo(r, ['variante']) || '').trim();
    var cat = String(campo(r, ['categoria']) || '').trim();
    var cant = num(campo(r, ['cantidad']));
    var uni = String(campo(r, ['unidad']) || '').trim();
    var pres = String(campo(r, ['presentacion']) || '').trim();
    var nPres = num(campo(r, ['cantidadpresentacion']));
    var etiq = String(campo(r, ['etiqueta']) || '').trim();
    var acc = String(campo(r, ['accesorio']) || '').trim();

    // Compatibilidad con registros viejos: Item="Fragancia" + Variante="Citrux" → Item="Citrux", Categoría="Fragancia"
    if ((normalizar(item) === 'fragancia' || normalizar(item) === 'color') && variante) {
      cat = normalizar(item) === 'color' ? 'Color' : 'Fragancia';
      item = variante;
      variante = '';
    }
    if (normalizar(cat) === 'fragancia / color') cat = 'Fragancia';

    if (tipo.indexOf('entrada') === 0) {
      mover(item, variante, cat, cant, uni);

    } else if (tipo.indexOf('consumo base') === 0) {
      // Sacar litros de una base que está en otro tanque (CMC preparado, Genapol preparado…)
      var idBase = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      var litrosBase = aBase(cant, uni || 'L').v;
      for (var b = 0; b < tambores.length && litrosBase > 0; b++) {
        var tbb = tambores[b];
        if (tbb.disponible <= 0) continue;
        var nb = normalizar(idBase);
        if (!idBase || normalizar(tbb.id) === nb || normalizar(tbb.id).indexOf(nb) >= 0 || nb.indexOf(normalizar(tbb.id)) >= 0) {
          var qb = Math.min(tbb.disponible, litrosBase);
          tbb.disponible -= qb;
          litrosBase -= qb;
        }
      }

    } else if (tipo.indexOf('consumo') === 0) {
      var catCons = cat;
      if (!catCons) {
        catCons = (normalizar(item) === 'fragancia' || normalizar(item) === 'color') ? 'Fragancia / Color' : 'Materia prima';
      }
      mover(item, variante, catCons, -cant, uni);

    } else if (tipo.indexOf('traslado') === 0) {
      // Traslado de inventario de un ítem a otro (ej: envase mal creado). No borra el historial.
      var claveO = normalizar(item) + '|' + normalizar(variante);
      var destinoT = String(campo(r, ['producto']) || '').trim();
      if (stock[claveO] && destinoT) {
        var cuanto = cant > 0 ? aBase(cant, uni || stock[claveO].Unidad).v : stock[claveO].Stock;
        stock[claveO].Stock -= cuanto;
        var claveD = normalizar(destinoT) + '|' + normalizar(variante);
        if (!stock[claveD]) {
          stock[claveD] = { Item: destinoT, Variante: variante, Categoria: stock[claveO].Categoria, Stock: 0, Unidad: stock[claveO].Unidad, Referencia: 0 };
        }
        stock[claveD].Stock += cuanto;
        if (stock[claveD].Stock > (stock[claveD].Referencia || 0)) stock[claveD].Referencia = stock[claveD].Stock;
      }

    } else if (tipo.indexOf('preparar tambor') === 0) {
      // Tambores enumerados: si ya existe uno con el mismo nombre/número, se le SUMAN los litros (adición)
      var idTambor = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      var litrosPrep = num(campo(r, ['litrospreparados']));
      var existente = null;
      if (idTambor) {
        for (var x = 0; x < tambores.length; x++) {
          if (normalizar(tambores[x].id) === normalizar(idTambor)) { existente = tambores[x]; }
        }
      }
      var estadoTanque = String(campo(r, ['motivo']) || '').trim(); // "En proceso" o "Listo"
      if (existente && existente.disponible <= 0.01 && litrosPrep > 0) {
        // El tanque estaba VACÍO y lo vuelven a llenar: se "re-crea" con el producto nuevo
        existente.producto = String(campo(r, ['producto']) || '').trim() || existente.producto;
        existente.variante = variante || '';
        existente.tanque = String(campo(r, ['tanque']) || '').trim() || existente.tanque;
        existente.litros = litrosPrep;
        existente.disponible = litrosPrep;
        existente.estado = estadoTanque || 'Listo';
      } else if (existente) {
        existente.litros += litrosPrep;
        existente.disponible += litrosPrep;
        if (!existente.producto) existente.producto = String(campo(r, ['producto']) || '').trim();
        if (estadoTanque) existente.estado = estadoTanque;
      } else {
        tambores.push({
          id: idTambor || String(campo(r, ['producto']) || '').trim(),
          producto: String(campo(r, ['producto']) || '').trim(),
          variante: variante,
          tanque: String(campo(r, ['tanque']) || '').trim(),
          litros: litrosPrep,
          disponible: litrosPrep,
          estado: estadoTanque || 'Listo',
          fecha: String(campo(r, ['fecha', 'timestamp', 'fechacliente']) || '')
        });
      }

    } else if (tipo.indexOf('empacar materia prima') === 0) {
      // Empacar materia prima directa (ej: ácido muriático en galones):
      // descuenta la materia prima por el tamaño del envase, más envase/etiqueta/accesorio
      descontarEmpaque(mover, pres, nPres, etiq, acc);
      var tMp = tamanoDe(pres);
      if (tMp && nPres > 0 && item) {
        mover(item, variante, 'Materia prima', -(tMp.v * nPres), tMp.u);
      }
      if (nPres > 0 && item) mover(item + ' ' + pres, '', 'Producto terminado', nPres, 'und');

    } else if (tipo.indexOf('empacar desde tambor') === 0 || tipo.indexOf('empacar producto') === 0) {
      descontarEmpaque(mover, pres, nPres, etiq, acc);
      var tambor = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      // El producto terminado se nombra por el PRODUCTO del tanque (no por el número del tanque)
      var prodTanque = '';
      var idLote = tambor; // el tanque queda como "lote" del producto terminado
      var nTamb = normalizar(tambor);
      for (var pm = 0; pm < tambores.length; pm++) {
        var tp = tambores[pm];
        var idOk = tp.id && (normalizar(tp.id) === nTamb || normalizar(tp.id).indexOf(nTamb) >= 0 || nTamb.indexOf(normalizar(tp.id)) >= 0);
        var prOk = tp.producto && (nTamb.indexOf(normalizar(tp.producto)) >= 0 || normalizar(tp.producto).indexOf(nTamb) >= 0);
        if (idOk || prOk) {
          if (tp.producto) prodTanque = tp.producto;
          if (tp.id) idLote = tp.id;
          break;
        }
      }
      var nombrePT = ((prodTanque || tambor) + ' ' + pres).trim();
      if (nPres > 0) mover(nombrePT, idLote, 'Producto terminado', nPres, 'und');
      // descontar litros del tanque: por tamaño del envase, o directo si es Recarga
      var t = tamanoDe(pres);
      var litrosCalc = 0;
      if (t && t.u === 'L' && nPres > 0) litrosCalc = t.v * nPres;
      else if (/recarga/i.test(pres) && nPres > 0) {
        litrosCalc = /mililitro|\bml\b/i.test(pres) ? nPres / 1000 : nPres; // Recarga litros / Recarga mililitros
      }
      if (litrosCalc > 0) {
        var litrosEmpacados = litrosCalc;
        for (var i = 0; i < tambores.length && litrosEmpacados > 0; i++) {
          var tb = tambores[i];
          if (tb.disponible <= 0) continue;
          var nTam = normalizar(tambor);
          var coincideId = tb.id && (normalizar(tb.id) === nTam || normalizar(tb.id).indexOf(nTam) >= 0 || nTam.indexOf(normalizar(tb.id)) >= 0);
          var coincideProd = tb.producto && (nTam.indexOf(normalizar(tb.producto)) >= 0 || normalizar(tb.producto).indexOf(nTam) >= 0);
          if (coincideId || coincideProd || (!tb.id && !tb.producto)) {
            var quitar = Math.min(tb.disponible, litrosEmpacados);
            tb.disponible -= quitar;
            litrosEmpacados -= quitar;
          }
        }
      }

    } else if (tipo.indexOf('empacar solido') === 0 || tipo.indexOf('empacar sólido') === 0) {
      descontarEmpaque(mover, pres, nPres, etiq, '');
      var tt = tamanoDe(pres);
      if (tt && tt.u === 'kg' && nPres > 0) {
        mover(item, variante, 'Materia prima', -(tt.v * nPres), 'kg'); // descuenta el polvo por peso
      }
      if (nPres > 0 && item) mover(item + ' ' + pres, '', 'Producto terminado', nPres, 'und');

    } else if (tipo.indexOf('salida') === 0 || tipo.indexOf('baja') >= 0) {
      mover(item, variante, cat, -cant, uni);

    } else if (tipo.indexOf('fabricar palo') === 0) {
      mover(item, '', 'Producto terminado', cant, 'und');
      var largo = /1[.,]?5/.test(item) ? '1.50 m' : '1.20 m';
      var receta = /mariposa/i.test(item) ? BOM_PALOS.mariposa : BOM_PALOS.rosca;
      (receta || []).forEach(function (material) {
        mover(material.replace('{largo}', largo), '', 'Material palo', -cant, 'und');
      });

    } else if (tipo.indexOf('conteo') === 0 || tipo.indexOf('ajuste') === 0) {
      fijar(item, variante, cat, cant, uni);

    } else if (tipo.indexOf('eliminar item') === 0) {
      delete stock[normalizar(item) + '|' + normalizar(variante)];

    } else if (tipo.indexOf('novedad') === 0) {
      // Correcciones que SÍ ajustan: Sobrante suma, Faltante/merma y Registro de más restan,
      // Desempaque devuelve. Otros motivos: solo trazabilidad.
      var mot = normalizar(campo(r, ['motivo']));
      var tamborNov = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      var esSuma = mot.indexOf('sobrante') >= 0 || mot.indexOf('desempaque') >= 0;
      var esResta = mot.indexOf('faltante') >= 0 || mot.indexOf('merma') >= 0 || mot.indexOf('registro de mas') >= 0;
      if ((esSuma || esResta) && cant > 0) {
        var signo = esSuma ? 1 : -1;
        if (tamborNov && !item) {
          // ajusta los litros del tanque
          for (var nvi = 0; nvi < tambores.length; nvi++) {
            if (normalizar(tambores[nvi].id) === normalizar(tamborNov)) {
              tambores[nvi].disponible += signo * aBase(cant, uni || 'L').v;
              break;
            }
          }
        } else if (item) {
          mover(item, variante, cat, signo * cant, uni);
        }
      }
    }
  });

  // mínimos para alertas (hoja MINIMOS opcional: Item | Variante | Minimo)
  var minimos = leerMinimos();
  var items = [];
  for (var clave in stock) {
    var s = stock[clave];
    if (normalizar(s.Item) === 'agua') continue; // el agua no se controla en inventario
    var m = minimos[normalizar(s.Item) + '|' + normalizar(s.Variante)];
    if (m == null) m = minimos[normalizar(s.Item) + '|'];
    items.push({
      Item: s.Item,
      Variante: s.Variante,
      Categoria: s.Categoria,
      Stock: Math.round(s.Stock * 100) / 100,
      Unidad: s.Unidad,
      Minimo: (m == null ? '' : m),
      Referencia: Math.round((s.Referencia || 0) * 100) / 100
    });
  }
  items.sort(function (a, b) { return a.Item.localeCompare(b.Item); });

  // Los tanques vacíos NO desaparecen: quedan marcados "Vacío" para volverlos a usar
  var tamboresDisponibles = tambores
    .slice(-30)
    .map(function (t) {
      var vacio = t.disponible <= 0.01;
      return {
        id: t.id,
        producto: t.producto,
        variante: t.variante,
        tanque: t.tanque,
        disponible: Math.max(0, Math.round(t.disponible * 100) / 100),
        estado: vacio ? 'Vacío' : (t.estado || 'Listo')
      };
    });

  return { items: items, tambores: tamboresDisponibles };
}

function descontarEmpaque(mover, pres, nPres, etiq, acc) {
  if (!(nPres > 0)) return;
  if (pres && !/recarga|bulto/i.test(pres)) {
    mover(pres, '', 'Envase', -nPres, 'und');
  }
  if (etiq && !/^sin etiqueta/i.test(etiq)) {
    mover('Etiqueta', etiq, 'Etiqueta', -nPres, 'und');
  }
  if (acc && !/^sin accesorio|^seleccionar/i.test(acc)) {
    mover(acc, '', 'Accesorio', -nPres, 'und');
  }
}

function leerMinimos() {
  var out = {};
  var hoja = getHoja().getSheetByName(HOJA_MINIMOS);
  if (!hoja) return out;
  var valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return out;
  var enc = valores[0].map(function (t) { return normalizar(t).replace(/[ _]/g, ''); });
  var iItem = enc.indexOf('item');
  var iVar = enc.indexOf('variante');
  var iMin = enc.indexOf('minimo');
  if (iItem < 0 || iMin < 0) return out;
  for (var f = 1; f < valores.length; f++) {
    var item = String(valores[f][iItem] || '').trim();
    if (!item) continue;
    var variante = iVar >= 0 ? String(valores[f][iVar] || '').trim() : '';
    var minimo = num(valores[f][iMin]);
    out[normalizar(item) + '|' + normalizar(variante)] = minimo;
  }
  return out;
}

// ================== GUARDAR (POST) ==================
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var hoja = getHoja().getSheetByName(HOJA_REGISTRO);
    if (!hoja) throw new Error('No existe la pestaña ' + HOJA_REGISTRO);

    var encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
    var campos = {};
    for (var k in payload) campos[normalizar(k).replace(/[ _]/g, '')] = payload[k];

    var fila = encabezados.map(function (titulo) {
      var n = normalizar(titulo).replace(/[ _]/g, '');
      if (n === 'fecha' || n === 'timestamp' || n === 'fechaservidor') {
        return new Date();
      }
      return (campos[n] != null) ? campos[n] : '';
    });

    hoja.appendRow(fila);

    // Si es una APROBACIÓN de ítem nuevo: agregarlo también a la hoja CATALOGOS (queda oficial)
    // (Los "Relacionado", "Renombrado" y "Eliminado" NO se agregan al catálogo)
    if (normalizar(payload.TipoRegistro || '').indexOf('aprobacion') === 0) {
      var motA = normalizar(payload.Motivo || '');
      if (!motA || motA === 'aprobado') {
        try { agregarACatalogo(payload.Categoria, payload.Item, payload.Variante); } catch (e2) {}
      }
    }
    return salida({ ok: true });
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  }
}

// Agrega un ítem aprobado a la columna correspondiente de la hoja CATALOGOS
function agregarACatalogo(categoria, item, variante) {
  var hoja = getHoja().getSheetByName(HOJA_CATALOGOS);
  if (!hoja) return;
  var cat = normalizar(categoria);
  var candidatos = {
    'materia prima': ['materia prima', 'materias primas'],
    'fragancia': ['fragancia', 'fragancias', 'variantes', 'variantes fragancia'],
    'fragancia / color': ['fragancia', 'fragancias', 'variantes', 'variantes fragancia'],
    'color': ['color', 'colores'],
    'envase': ['envase', 'envases'],
    'accesorio': ['accesorio', 'accesorios'],
    'etiqueta': ['etiqueta', 'etiquetas'],
    'material palo': ['material palo', 'materiales palos'],
    'producto terminado': ['producto terminado', 'productos', 'productos terminados'],
    'otro': []
  };
  var buscados = candidatos[cat] || [];
  var valor = String(item || '').trim();
  // Compatibilidad con registros viejos (Item=Fragancia + Variante=nombre)
  if ((normalizar(valor) === 'fragancia' || normalizar(valor) === 'color') && String(variante || '').trim()) {
    valor = String(variante).trim();
  }
  if (!valor || !buscados.length) return;
  var valores = hoja.getDataRange().getValues();
  var titulos = valores[0] || [];
  for (var c = 0; c < titulos.length; c++) {
    if (buscados.indexOf(normalizar(titulos[c])) < 0) continue;
    for (var f = 1; f < valores.length; f++) {
      if (normalizar(valores[f][c]) === normalizar(valor)) return; // ya existe
    }
    var filaLibre = valores.length + 1;
    for (var f2 = 1; f2 < valores.length; f2++) {
      if (!String(valores[f2][c] || '').trim()) { filaLibre = f2 + 1; break; }
    }
    hoja.getRange(filaLibre, c + 1).setValue(valor);
    return;
  }
}

// ================== AYUDAS ==================
function normalizar(texto) {
  return String(texto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}
function num(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
// Convierte a unidad base: ml->L, g->kg, lb->kg. Devuelve {v: valor, u: unidad}
function aBase(valor, unidad) {
  var u = normalizar(unidad);
  var v = Number(valor) || 0;
  if (u === 'ml') return { v: v / 1000, u: 'L' };
  if (u === 'l' || u === 'lt' || u === 'litros' || u === 'litro') return { v: v, u: 'L' };
  if (u === 'g' || u === 'gr') return { v: v / 1000, u: 'kg' };
  if (u === 'kg') return { v: v, u: 'kg' };
  if (u === 'lb' || u === 'libra' || u === 'libras') return { v: v * 0.5, u: 'kg' };
  return { v: v, u: unidad ? String(unidad) : 'und' };
}
// Extrae el tamano de una presentacion: "Galon 4 L" -> {v:4,u:'L'}, "Bolsa 1 lb" -> {v:0.5,u:'kg'}
function tamanoDe(texto) {
  var m = String(texto || '').match(/(\d+(?:[.,]\d+)?)\s*(ml|l|lt|litros?|g|gr|kg|lb|libras?)\b/i);
  if (!m) return null;
  var v = parseFloat(m[1].replace(',', '.'));
  var u = m[2].toLowerCase();
  if (u === 'ml') return { v: v / 1000, u: 'L' };
  if (u === 'g' || u === 'gr') return { v: v / 1000, u: 'kg' };
  if (u === 'kg') return { v: v, u: 'kg' };
  if (u === 'lb' || u === 'libra' || u === 'libras') return { v: v * 0.5, u: 'kg' }; // libra colombiana = 500 g
  return { v: v, u: 'L' };
}
