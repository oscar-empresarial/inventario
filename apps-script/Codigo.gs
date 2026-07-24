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
// Se conserva la versión compatible para que el despliegue del script y la
// página web pueda hacerse en cualquier orden sin bloquear los registros.
var API_VERSION = '2.2.0-revisiones';

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
    } else if (p.action === 'conciliacion') {
      data = getConciliacion();
    } else if (p.action === 'revision') {
      data = getRevision();
    } else if (p.action === 'operacion') {
      data = getEstadoOperacion_(p.requestId || p.idempotencyKey);
    } else {
      data = { ok: true, version: API_VERSION, mensaje: 'API Full Company activa' };
    }
  } catch (err) {
    data = { ok: false, error: String(err) };
  }
  return salida(data, p.callback);
}

// Confirma desde la interfaz si un POST opaco se guardó o fue rechazado.
// Es importante porque Apps Script no siempre permite leer directamente la
// respuesta de un POST hecho desde GitHub Pages.
function getEstadoOperacion_(requestId) {
  requestId = String(requestId || '').trim();
  if (requestId.length < 8) return {ok:false,encontrada:false,version:API_VERSION,error:'RequestId inválido.'};
  var libro = getHoja();
  var hoja = libro.getSheetByName(HOJA_REGISTRO);
  if (hoja && hoja.getLastRow() > 1) {
    var encabezados = hoja.getRange(1,1,1,hoja.getLastColumn()).getDisplayValues()[0];
    var iReq = indiceEncabezado_(encabezados,'IdempotencyKey');
    var iOp = indiceEncabezado_(encabezados,'OperacionID');
    if (iReq >= 0) {
      var valores = hoja.getRange(2,1,hoja.getLastRow()-1,hoja.getLastColumn()).getDisplayValues();
      var movimientos = 0;
      var operacionId = '';
      valores.forEach(function(fila) {
        if (String(fila[iReq] || '').trim() === requestId) {
          movimientos++;
          if (iOp >= 0 && !operacionId) operacionId = String(fila[iOp] || '');
        }
      });
      if (movimientos) return {ok:true,encontrada:true,version:API_VERSION,requestId:requestId,operacionId:operacionId,movimientos:movimientos};
    }
  }
  var errores = libro.getSheetByName('_API_ERRORES');
  if (errores && errores.getLastRow() > 1) {
    var datos = errores.getRange(2,1,errores.getLastRow()-1,errores.getLastColumn()).getDisplayValues();
    for (var i=datos.length-1;i>=0;i--) {
      if (String(datos[i][0] || '').trim() === requestId) {
        return {ok:false,encontrada:true,version:API_VERSION,requestId:requestId,error:String(datos[i][2] || 'Movimiento rechazado.')};
      }
    }
  }
  return {ok:false,encontrada:false,version:API_VERSION,requestId:requestId,mensaje:'La operación aún no aparece.'};
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
  // El libro de movimientos es la fuente de verdad. Si una aprobación quedó
  // registrada pero la columna física de CATALOGOS falló al actualizarse, el
  // ítem sigue apareciendo como oficial y puede repararse sin perder el cambio.
  try {
    var claveCategoria={
      'materia prima':'materiasPrimas','fragancia':'fragancias','fragancia / color':'fragancias',
      'color':'colores','envase':'envases','accesorio':'accesorios','etiqueta':'etiquetas',
      'material palo':'materialesPalos','producto terminado':'productos'
    };
    leerRegistros().filas.forEach(function(r) {
      if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('aprobacion item')!==0) return;
      if (normalizar(campo(r,['motivo']))!=='aprobado') return;
      var clave=claveCategoria[normalizar(campo(r,['categoria']))];
      var valor=String(campo(r,['item'])||'').trim();
      var variante=String(campo(r,['variante'])||'').trim();
      if ((normalizar(valor)==='fragancia'||normalizar(valor)==='color')&&variante) valor=variante;
      if (!clave||!valor) return;
      if (!out[clave]) out[clave]=[];
      if (!out[clave].some(function(x){return normalizar(x)===normalizar(valor);})) out[clave].push(valor);
    });
  } catch (ignoreCatalogoLedger) {}
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
    if (!vacia) {
      obj._FilaOrigen = f + 1;
      filas.push(obj);
    }
  }
  return { encabezados: encabezados, filas: filas };
}

function campo(obj, nombres) {
  // Respeta la prioridad de los alias y no deja que una columna vacía
  // (por ejemplo Cantidad) oculte otra con el valor real (LitrosPreparados).
  var vacio = '';
  for (var i = 0; i < nombres.length; i++) {
    var buscado = normalizar(nombres[i]).replace(/[ _]/g, '');
    for (var k in obj) {
      if (normalizar(k).replace(/[ _]/g, '') !== buscado) continue;
      var valor = obj[k] == null ? '' : obj[k];
      if (String(valor).trim() !== '') return valor;
      vacio = valor;
    }
  }
  return vacio;
}

// ================== CENTRO DE REVISIONES (action=revision) ==================
function getRevision() {
  var filas = leerRegistros().filas;
  var inventario = getInventario().items || [];
  var solicitudes = {};
  var resueltas = {};

  function clave(categoria,item,variante) {
    return [categoria,item,variante].map(normalizar).join('|');
  }
  function fechaDe(r) {
    return String(campo(r,['fechaservidor','fecha','timestamp','fechacliente']) || '');
  }
  function saldoDe(item,variante) {
    var total = 0;
    inventario.forEach(function(i) {
      if (normalizar(i.Item) === normalizar(item) && normalizar(i.Variante || '') === normalizar(variante || '')) total += Number(i.Stock) || 0;
    });
    return redondear_(total,3);
  }

  filas.forEach(function(r, indice) {
    var tipo = normalizar(campo(r,['tiporegistro','tipo']));
    var categoria = String(campo(r,['categoria']) || '').trim();
    var item = String(campo(r,['item']) || '').trim();
    var variante = String(campo(r,['variante']) || '').trim();
    if (!item) return;
    var k = clave(categoria,item,variante);
    var esNuevo = /^(si|sí|true|1)$/i.test(String(campo(r,['nuevoitem','pendienteaprobacion']) || '').trim());
    if (esNuevo && !solicitudes[k]) {
      solicitudes[k] = {
        clave:k, categoria:categoria, item:item, variante:variante,
        creadoPor:String(campo(r,['responsable']) || ''),
        primeraFecha:fechaDe(r), ultimaFecha:fechaDe(r), movimientos:0,
        referencia:String(campo(r,['operacionid','id']) || ('FILA-' + (indice + 2)))
      };
    }
    if (esNuevo) {
      solicitudes[k].movimientos++;
      solicitudes[k].ultimaFecha = fechaDe(r) || solicitudes[k].ultimaFecha;
    }
    if (tipo.indexOf('aprobacion item') === 0) {
      var motivo = normalizar(campo(r,['motivo']));
      var estado = motivo === 'aprobado' ? 'APROBADO' :
        (motivo === 'relacionado' ? 'RELACIONADO' :
        (motivo === 'renombrado' ? 'RENOMBRADO' :
        (motivo === 'rechazado' || motivo === 'archivado' ? 'ARCHIVADO' : 'RESUELTO')));
      resueltas[k] = {
        estado:estado, motivo:String(campo(r,['motivo']) || ''),
        por:String(campo(r,['responsable']) || ''), fecha:fechaDe(r),
        observacion:String(campo(r,['observacion']) || ''), categoria:categoria,
        item:item,variante:variante,referencia:String(campo(r,['referenciaoriginal','operacionid','id'])||'')
      };
    }
  });

  var pendientes = [];
  var historial = [];
  Object.keys(solicitudes).forEach(function(k) {
    var s = solicitudes[k];
    s.saldo = saldoDe(s.item,s.variante);
    if (resueltas[k]) {
      s.resolucion = resueltas[k];
      historial.push(s);
    } else {
      pendientes.push(s);
    }
  });
  Object.keys(resueltas).forEach(function(k) {
    if (solicitudes[k] || resueltas[k].estado==='APROBADO') return;
    var r=resueltas[k];
    historial.push({
      clave:k,categoria:r.categoria,item:r.item,variante:r.variante,creadoPor:r.por,
      primeraFecha:r.fecha,ultimaFecha:r.fecha,movimientos:1,referencia:r.referencia,
      saldo:saldoDe(r.item,r.variante),resolucion:r
    });
  });
  pendientes.sort(function(a,b){return String(a.primeraFecha).localeCompare(String(b.primeraFecha));});
  historial.sort(function(a,b){return String(b.resolucion.fecha).localeCompare(String(a.resolucion.fecha));});
  return {
    ok:true, fecha:new Date().toISOString(),
    resumen:{pendientes:pendientes.length,resueltas:historial.length},
    pendientes:pendientes, historial:historial.slice(0,200)
  };
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

// ================== CONCILIACIÓN (action=conciliacion) ==================
function getConciliacion() {
  var filas = leerRegistros().filas;
  var hallazgos = [];
  var lotes = {};
  var filasLegacy = 0;
  function lote(id) {
    if (!lotes[id]) lotes[id]={producciones:[],componentes:[],preparado:0,empacado:0,consumidoBase:0};
    return lotes[id];
  }
  function add(codigo,prioridad,entidad,detalle,esperado,real,meta) {
    var h={codigo:codigo,prioridad:prioridad,entidad:entidad,detalle:detalle,esperado:esperado,real:real};
    if (isFinite(Number(esperado)) && isFinite(Number(real))) h.diferencia=redondear_(Number(real)-Number(esperado),3);
    if (meta) for (var mk in meta) h[mk]=meta[mk];
    hallazgos.push(h);
  }
  filas.forEach(function(r,indice) {
    var tipo=normalizar(campo(r,['tiporegistro','tipo']));
    var tambor=String(campo(r,['tamborid','tambor'])||'').trim();
    if (tambor) {
      if (tipo.indexOf('preparar tambor')===0) {
        lote(tambor).producciones.push({fila:r,indice:indice});
        lote(tambor).preparado += num(campo(r,['litrospreparados','cantidad']));
      } else if (tipo.indexOf('consumo materia prima')===0) {
        lote(tambor).componentes.push({fila:r,indice:indice});
      } else if (tipo.indexOf('empacar desde tambor')===0 || tipo.indexOf('empacar producto')===0) {
        lote(tambor).empacado += litrosPresentacion_(String(campo(r,['presentacion'])||''),num(campo(r,['cantidadpresentacion'])));
      }
    }
    if (tipo.indexOf('consumo base')===0) {
      var fuenteBase=String(campo(r,['tamborid','tambor'])||'').trim();
      var destinoBase=String(campo(r,['destinotambor'])||'').trim();
      if (destinoBase) lote(destinoBase).componentes.push({fila:r,indice:indice});
      if (fuenteBase) lote(fuenteBase).consumidoBase += aBase(num(campo(r,['cantidad'])),String(campo(r,['unidad'])||'L')).v;
    }
    var id=campo(r,['id']); var fecha=campo(r,['fecha','timestamp','fechaservidor','fechahora']); var usuario=campo(r,['usuario']);
    if (!id || !fecha || !usuario) filasLegacy++;
  });
  for (var idTambor in lotes) {
    var l=lotes[idTambor];
    // El número identifica al tanque físico y puede reutilizarse. Se informa,
    // pero no se acusa como lote duplicado ni se propone ajustar inventario.
    if (l.producciones.length>1) add('TANQUE-REUTILIZADO','Media',idTambor,'El tanque físico tiene varias preparaciones históricas. Conviene asignar un lote único a cada preparación.',1,l.producciones.length);
    var salidasLote=l.empacado+l.consumidoBase;
    if (salidasLote>l.preparado+0.001) add('SALDO-TAMBOR-NEGATIVO','Alta',idTambor,'Las salidas empacadas o usadas como base superan lo preparado.',l.preparado,salidasLote);
    l.producciones.forEach(function(prod,pos) {
      var p=prod.fila;
      var op=String(campo(p,['operacionid'])||'').trim();
      var idMovimiento=String(campo(p,['id'])||'').trim();
      var referenciaProduccion=op||idMovimiento||('FILA-'+(prod.indice+2));
      var siguiente=pos+1<l.producciones.length ? l.producciones[pos+1].indice : Number.MAX_SAFE_INTEGER;
      var comps=l.componentes.filter(function(comp){
        var c=comp.fila;
        var oc=String(campo(c,['operacionid'])||'').trim();
        var refCorreccion=String(campo(c,['referenciaoriginal'])||'').trim();
        if (op) return oc===op || refCorreccion===op || (idMovimiento && refCorreccion===idMovimiento);
        // Para legado sin OperacionID, solo usa componentes contiguos de esa
        // preparación, salvo una corrección que la enlace explícitamente.
        return (!oc && comp.indice>prod.indice && comp.indice<siguiente) ||
          refCorreccion===referenciaProduccion;
      }).map(function(comp){return comp.fila;});
      var volumen=0;
      comps.forEach(function(c){var conv=aBase(num(campo(c,['cantidad'])),String(campo(c,['unidad'])||''));if(conv.u==='L')volumen+=conv.v;});
      var litros=num(campo(p,['litrospreparados','cantidad']));
      var etiqueta=[idTambor,String(campo(p,['producto'])||''),String(campo(p,['fecha','fechaservidor','fechacliente'])||'').slice(0,10)].filter(Boolean).join(' · ');
      var metaProduccion={
        referencia:referenciaProduccion,tamborId:idTambor,
        producto:String(campo(p,['producto'])||''),operacionId:op
      };
      if(comps.length<2) add('BOM-INCOMPLETA','Alta',etiqueta,'Preparación histórica con menos de dos componentes trazados. Debe revisarse la fórmula; no se ajusta stock automáticamente.',2,comps.length,metaProduccion);
      if(litros>0 && comps.length>=2 && volumen/litros<0.80) {
        add(op?'RENDIMIENTO-IMPOSIBLE':'VOLUMEN-HISTORICO-INCOMPLETO',op?'Alta':'Media',etiqueta,'Los componentes líquidos registrados no explican el volumen preparado.',litros,volumen,metaProduccion);
      }
    });
  }
  if (filasLegacy) add('AUDITORIA-LEGACY','Media','Historial anterior a la auditoría',filasLegacy+' filas antiguas no tienen todos los campos nuevos de ID, fecha de servidor y usuario. Se conservan como historial; no equivalen a descuadres.',0,filasLegacy);
  var inv=getInventario();
  (inv.items||[]).filter(function(i){return Number(i.Stock)<-0.000001;}).forEach(function(i){add('INVENTARIO-NEGATIVO','Alta',i.Item+(i.Variante?' · '+i.Variante:''),'Saldo negativo.',0,i.Stock);});
  var porCodigo={};
  var lotesPrioritarios=[];
  hallazgos.forEach(function(h){
    porCodigo[h.codigo]=(porCodigo[h.codigo]||0)+1;
    if (h.prioridad==='Alta' && lotesPrioritarios.indexOf(h.entidad)<0) lotesPrioritarios.push(h.entidad);
  });
  var altos=hallazgos.filter(function(h){return h.prioridad==='Alta';}).length;
  return {ok:true,fecha:new Date().toISOString(),resumen:{
    total:hallazgos.length,altos:altos,accionables:altos,filasLegacy:filasLegacy,
    porCodigo:porCodigo,lotesPrioritarios:lotesPrioritarios
  },hallazgos:hallazgos};
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
        // Los IDs deben coincidir completos: el tanque 1 nunca puede tocar el 12.
        if (idBase && normalizar(tbb.id) === normalizar(idBase)) {
          var qb = Math.min(tbb.disponible, litrosBase);
          tbb.disponible -= qb;
          litrosBase -= qb;
        }
      }

    } else if (tipo.indexOf('estado tambor') === 0) {
      var idEstado = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      var nuevoEstado = String(campo(r, ['motivo']) || '').trim();
      for (var et = 0; et < tambores.length; et++) {
        if (normalizar(tambores[et].id) === normalizar(idEstado)) {
          tambores[et].estado = nuevoEstado || tambores[et].estado;
          break;
        }
      }

    } else if (tipo.indexOf('correccion tanque') === 0) {
      // Corrige el nombre del contenido sin reescribir la preparación original
      // ni sumar/restar litros. Las existencias empacadas se trasladan mediante
      // movimientos separados creados por construirCorreccionTanque_.
      var idCorreccion = String(campo(r, ['tamborid', 'tambor']) || '').trim();
      var productoCorregido = String(campo(r, ['producto']) || '').trim();
      for (var ct = 0; ct < tambores.length; ct++) {
        if (normalizar(tambores[ct].id) === normalizar(idCorreccion)) {
          if (productoCorregido) tambores[ct].producto = productoCorregido;
          break;
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
      var indiceTanque = -1;
      for (var pm = 0; pm < tambores.length; pm++) {
        var tp = tambores[pm];
        if (tp.id && normalizar(tp.id) === nTamb) { indiceTanque=pm; break; }
      }
      // Compatibilidad con registros viejos que guardaron el nombre del producto
      // en vez del ID: solo se acepta si identifica exactamente un único tanque.
      if (indiceTanque < 0) {
        var candidatos=[];
        for (var pc=0;pc<tambores.length;pc++) if (tambores[pc].producto && normalizar(tambores[pc].producto)===nTamb) candidatos.push(pc);
        if (candidatos.length===1) indiceTanque=candidatos[0];
      }
      if (indiceTanque >= 0) {
        if (tambores[indiceTanque].producto) prodTanque=tambores[indiceTanque].producto;
        if (tambores[indiceTanque].id) idLote=tambores[indiceTanque].id;
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
      if (litrosCalc > 0 && indiceTanque >= 0) {
        // Nunca repartir un empaque entre lotes parecidos. Si no alcanza, la
        // conciliación lo reporta y los POST nuevos ya se bloquean antes.
        tambores[indiceTanque].disponible -= litrosCalc;
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

  // El producto preparado también es inventario disponible. Antes solo vivía
  // en la lista de tambores y por eso la vista general podía mostrar 40 L
  // aunque existiera un lote de 120 L.
  tambores.forEach(function (t) {
    if (t.producto && t.disponible > 0.0001) {
      mover(t.producto, 'A granel · ' + (t.id || 'sin lote'), 'Producto preparado', t.disponible, 'L');
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
  var lock = LockService.getScriptLock();
  var payload;
  var requestId = '';
  try {
    payload = JSON.parse(e.postData.contents);
    requestId = String(payload.RequestId || payload.requestId || payload.IdempotencyKey || payload.idempotencyKey || '').trim();
    if (requestId.length < 8) throw new Error('Falta RequestId. Actualiza la app: cada envío debe llevar una clave de idempotencia.');
    if (!lock.tryLock(30000)) throw new Error('Hay otro movimiento en proceso. Espera unos segundos e intenta nuevamente.');
    var hoja = getHoja().getSheetByName(HOJA_REGISTRO);
    if (!hoja) throw new Error('No existe la pestaña ' + HOJA_REGISTRO);
    var encabezados = asegurarColumnasAuditoria_(hoja);
    var requestHash = hashPayload_(payload);
    var idxRequest = indiceEncabezado_(encabezados, 'IdempotencyKey');
    var idxRequestHash = indiceEncabezado_(encabezados, 'RequestHash');
    if (idxRequest >= 0 && hoja.getLastRow() > 1) {
      var anteriores = hoja.getRange(2, 1, hoja.getLastRow() - 1, encabezados.length).getDisplayValues();
      for (var a = 0; a < anteriores.length; a++) {
        if (String(anteriores[a][idxRequest] || '').trim() !== requestId) continue;
        var hashAnterior = idxRequestHash >= 0 ? String(anteriores[a][idxRequestHash] || '').trim() : '';
        if (hashAnterior && hashAnterior !== requestHash) {
          throw new Error('Conflicto de idempotencia: el RequestId ya fue usado con un payload distinto. No se guardó el segundo movimiento.');
        }
        return salida({ok:true,duplicado:true,mensaje:'La operación ya estaba guardada; no se duplicó.'});
      }
    }

    var tipo = String(payload.TipoRegistro || payload.tipoRegistro || '').trim();
    var responsable = String(payload.Responsable || payload.responsable || '').trim();
    if (!tipo) throw new Error('TipoRegistro es obligatorio.');
    if (!responsable) throw new Error('Responsable es obligatorio.');
    validarTipoPermitido_(tipo);
    var operacionId = 'OP-' + Utilities.getUuid().slice(0, 12).toUpperCase();
    var ahora = new Date();
    var usuario = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'no-identificado';
    var filasPayload = [];

    if (normalizar(tipo) === 'movimiento compuesto') {
      var movimientos=payload.Movimientos||payload.movimientos;
      if (!Array.isArray(movimientos)||!movimientos.length||movimientos.length>25) throw new Error('El movimiento compuesto requiere entre 1 y 25 líneas.');
      movimientos.forEach(function(m) {
        m=m||{};
        if (!m.Responsable) m.Responsable=responsable;
        var tipoHijo=String(m.TipoRegistro||'').trim();
        validarTipoPermitido_(tipoHijo);
        var nHijo=normalizar(tipoHijo);
        if (nHijo==='movimiento compuesto'||nHijo==='revision item') throw new Error('No se permiten operaciones compuestas anidadas.');
        if (nHijo.indexOf('preparar tambor')===0) filasPayload=filasPayload.concat(expandirProduccion_(m,m.Responsable,operacionId));
        else if (nHijo==='correccion produccion') filasPayload=filasPayload.concat(construirCorreccionProduccion_(m,m.Responsable));
        else if (nHijo==='correccion tanque') filasPayload=filasPayload.concat(construirCorreccionTanque_(m,m.Responsable));
        else { validarMovimientoPost_(m,tipoHijo); filasPayload.push(m); }
      });
    } else if (normalizar(tipo) === 'revision item') {
      filasPayload = construirRevisionItem_(payload,responsable);
    } else if (normalizar(tipo) === 'correccion produccion') {
      filasPayload = construirCorreccionProduccion_(payload,responsable);
    } else if (normalizar(tipo) === 'correccion tanque') {
      filasPayload = construirCorreccionTanque_(payload,responsable);
    } else if (normalizar(tipo).indexOf('preparar tambor') === 0) {
      filasPayload = expandirProduccion_(payload,responsable,operacionId);
    } else {
      validarMovimientoPost_(payload, tipo);
      filasPayload.push(payload);
    }

    var filas = filasPayload.map(function (p, i) {
      return filaDesdePayload_(encabezados, p, {
        fecha:ahora, usuario:usuario, operacionId:operacionId, requestId:requestId,
        requestHash:requestHash,
        movimientoId:operacionId + '-' + ('0' + (i + 1)).slice(-2),
        estadoMovimiento:'ACTIVO', versionBOM:normalizar(p.TipoRegistro||'').indexOf('preparar tambor') === 0 ? 'MANUAL-v1' : ''
      });
    });
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, encabezados.length).setValues(filas);

    // Si es una APROBACIÓN de ítem nuevo: agregarlo también a la hoja CATALOGOS (queda oficial)
    // (Los "Relacionado", "Renombrado" y "Eliminado" NO se agregan al catálogo)
    filasPayload.forEach(function(p) {
      if (normalizar(p.TipoRegistro || '').indexOf('aprobacion') !== 0) return;
      var motA = normalizar(p.Motivo || '');
      if (!motA || motA === 'aprobado') {
        try { agregarACatalogo(p.Categoria,p.Item,p.Variante); } catch (e2) {}
      }
    });
    return salida({ ok: true, operacionId:operacionId, requestId:requestId, movimientos:filas.length });
  } catch (err) {
    try { registrarErrorPost_(payload, requestId, err); } catch (errorAuditoria) {}
    return salida({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function registrarErrorPost_(payload, requestId, err) {
  requestId = String(requestId || (payload && (payload.RequestId || payload.requestId)) || '').trim();
  if (requestId.length < 8) return;
  var libro = getHoja();
  var hoja = libro.getSheetByName('_API_ERRORES');
  if (!hoja) {
    hoja = libro.insertSheet('_API_ERRORES');
    hoja.getRange(1,1,1,6).setValues([['RequestId','FechaServidor','Error','TipoRegistro','Responsable','Estado']]);
    try { hoja.hideSheet(); } catch (ignore) {}
  }
  hoja.appendRow([
    requestId,new Date(),String(err),String((payload && payload.TipoRegistro) || ''),
    String((payload && payload.Responsable) || ''),'RECHAZADO'
  ]);
}

function asegurarColumnasAuditoria_(hoja) {
  var encabezados = hoja.getRange(1,1,1,Math.max(hoja.getLastColumn(),1)).getValues()[0].map(String);
  ['OperacionID','IdempotencyKey','RequestHash','EstadoMovimiento','FechaServidor','Usuario','VersionBOM','HashIntegridad','DestinoTambor','ReferenciaOriginal'].forEach(function (nombre) {
    if (indiceEncabezado_(encabezados,nombre) < 0) {
      encabezados.push(nombre);
      hoja.getRange(1,encabezados.length).setValue(nombre);
    }
  });
  return encabezados;
}

function indiceEncabezado_(encabezados, nombre) {
  var objetivo = normalizar(nombre).replace(/[ _]/g,'');
  for (var i=0;i<encabezados.length;i++) if (normalizar(encabezados[i]).replace(/[ _]/g,'') === objetivo) return i;
  return -1;
}

function filaDesdePayload_(encabezados, payload, meta) {
  var campos = {};
  for (var k in payload) campos[normalizar(k).replace(/[ _]/g,'')] = payload[k];
  campos.operacionid = meta.operacionId;
  if (!campos.id) campos.id = meta.movimientoId;
  campos.idempotencykey = meta.requestId;
  campos.requesthash = meta.requestHash;
  campos.estadomovimiento = meta.estadoMovimiento;
  campos.fechaservidor = meta.fecha;
  campos.usuario = meta.usuario;
  campos.versionbom = meta.versionBOM;
  var fila = encabezados.map(function (titulo) {
    var n = normalizar(titulo).replace(/[ _]/g,'');
    if ((n === 'fecha' || n === 'timestamp' || n === 'fechaservidor' || n === 'fechahora') && campos[n] == null) return meta.fecha;
    if (n === 'hashintegridad') return '';
    return campos[n] != null ? campos[n] : '';
  });
  var idxHash = indiceEncabezado_(encabezados,'HashIntegridad');
  if (idxHash >= 0) fila[idxHash] = hashFila_(fila.slice(0,idxHash));
  return fila;
}

function validarProduccionPost_(payload) {
  var producto = String(payload.Producto || payload.producto || '').trim();
  var litros = positivo_(payload.LitrosPreparados || payload.litrosPreparados, 'LitrosPreparados debe ser mayor que cero.');
  var tamborId = String(payload.TamborID || payload.tamborId || payload.Tambor || '').trim();
  if (!producto) throw new Error('Producto es obligatorio al preparar un tambor.');
  if (!tamborId) throw new Error('TamborID es obligatorio y debe ser único por lote.');
  var confirmada = payload.FormulaCompleta === true || payload.formulaCompleta === true || /^(si|sí|true|1)$/i.test(String(payload.FormulaCompleta || payload.formulaCompleta || ''));
  if (!confirmada) throw new Error('Debes confirmar FormulaCompleta y registrar todas las materias primas, incluida el agua.');
  var componentes = payload.Componentes || payload.componentes || payload.MateriasPrimas || payload.materiasPrimas || [];
  if (!Array.isArray(componentes)) throw new Error('Componentes debe ser una lista de materias primas.');
  var vistos = {};
  var volumenL = 0;
  componentes = componentes.map(function (c) {
    var item = String(c.Item || c.item || '').trim();
    var variante = String(c.Variante || c.variante || '').trim();
    var cantidad = positivo_(c.Cantidad || c.cantidad, 'Cada materia prima debe tener cantidad mayor que cero.');
    var unidad = String(c.Unidad || c.unidad || '').trim();
    if (!item || !unidad) throw new Error('Cada materia prima requiere Item y Unidad.');
    var clave = normalizar(item) + '|' + normalizar(variante);
    if (vistos[clave]) throw new Error('Materia prima duplicada: ' + item + '. Unifica las cantidades.');
    vistos[clave] = true;
    var conv = aBase(cantidad,unidad);
    if (conv.u === 'L') volumenL += conv.v;
    return {item:item,variante:variante,cantidad:cantidad,unidad:unidad};
  });
  var baseTanque = String(payload.BaseTanque || payload.baseTanque || '').trim();
  var baseLitros = 0;
  if (baseTanque || payload.BaseLitros || payload.baseLitros) {
    if (!baseTanque) throw new Error('Debes indicar BaseTanque cuando registras litros de base.');
    baseLitros = positivo_(payload.BaseLitros || payload.baseLitros,'BaseLitros debe ser mayor que cero.');
    if (normalizar(baseTanque) === normalizar(tamborId)) throw new Error('El tanque de base no puede ser el mismo tanque de destino.');
    validarBaseDisponible_(baseTanque,baseLitros);
    volumenL += baseLitros;
  }
  if (componentes.length + (baseLitros > 0 ? 1 : 0) < 2) throw new Error('Producción incompleta: se requieren al menos dos componentes, incluida el agua o una base.');
  var cobertura = volumenL / litros;
  if (cobertura < 0.80) throw new Error('Fórmula incompleta: solo se explican ' + redondear_(volumenL,3) + ' L de ' + litros + ' L (' + redondear_(cobertura*100,1) + '%).');
  if (cobertura > 1.05) throw new Error('La fórmula declara más volumen que la producción. Revisa cantidades y unidades.');
  validarStockComponentes_(componentes);
  return {producto:producto,litros:litros,tamborId:tamborId,componentes:componentes,baseTanque:baseTanque,baseLitros:baseLitros};
}

function expandirProduccion_(payload,responsable,operacionId) {
  var produccion=validarProduccionPost_(payload);
  var filas=[payload];
  produccion.componentes.forEach(function(c,i) {
    filas.push({
      TipoRegistro:'Consumo materia prima',Categoria:'Materia prima',Item:c.item,Variante:c.variante||'',
      Cantidad:c.cantidad,Unidad:c.unidad,Movimiento:'Consumo',Motivo:'Producción',Producto:produccion.producto,
      TamborID:produccion.tamborId,Responsable:responsable,Observacion:'Componente '+(i+1)+' de '+operacionId
    });
  });
  if (produccion.baseLitros>0) filas.push({
    TipoRegistro:'Consumo base',Categoria:'Producto preparado',Cantidad:produccion.baseLitros,
    Unidad:'L',Movimiento:'Consumo',Motivo:'Producción',Producto:produccion.producto,
    TamborID:produccion.baseTanque,DestinoTambor:produccion.tamborId,Responsable:responsable,
    Observacion:'Base consumida en '+produccion.tamborId+' · '+operacionId
  });
  return filas;
}

function buscarPreparacionOriginal_(referencia,tamborId,exigirActual) {
  referencia=String(referencia||'').trim();
  tamborId=String(tamborId||'').trim();
  if (!referencia) throw new Error('La corrección requiere ReferenciaOriginal.');
  var filas=leerRegistros().filas;
  var encontrada=null;
  var ultimaDelTanque=null;
  filas.forEach(function(r,indice) {
    var tipo=normalizar(campo(r,['tiporegistro','tipo']));
    if (tipo.indexOf('preparar tambor')!==0) return;
    var tambor=String(campo(r,['tamborid','tambor'])||'').trim();
    var op=String(campo(r,['operacionid'])||'').trim();
    var id=String(campo(r,['id'])||'').trim();
    var refFila='FILA-'+(indice+2);
    var candidato={fila:r,indice:indice,tamborId:tambor,referencia:op||id||refFila};
    if (tamborId && normalizar(tambor)===normalizar(tamborId)) ultimaDelTanque=candidato;
    if (normalizar(referencia)===normalizar(op) ||
        normalizar(referencia)===normalizar(id) ||
        normalizar(referencia)===normalizar(refFila)) encontrada=candidato;
  });
  if (!encontrada && tamborId && /^TANQUE:/i.test(referencia)) encontrada=ultimaDelTanque;
  if (!encontrada) throw new Error('No se encontró la preparación original indicada. Abre el historial del tanque y selecciónala de nuevo.');
  if (tamborId && normalizar(encontrada.tamborId)!==normalizar(tamborId)) {
    throw new Error('La referencia original pertenece a otro tanque.');
  }
  if (exigirActual && ultimaDelTanque && ultimaDelTanque.indice>encontrada.indice) {
    throw new Error('Ese movimiento no corresponde al lote actual: el tanque tiene una preparación posterior.');
  }
  return encontrada;
}

function validarComponentesCorreccion_(componentes) {
  if (!Array.isArray(componentes) || !componentes.length) {
    throw new Error('Agrega al menos una materia prima faltante.');
  }
  if (componentes.length>25) throw new Error('Una corrección admite máximo 25 materias primas.');
  var vistos={};
  return componentes.map(function(c) {
    c=c||{};
    var item=String(c.Item||c.item||'').trim();
    var variante=String(c.Variante||c.variante||'').trim();
    var cantidad=positivo_(c.Cantidad||c.cantidad,'Cada materia prima debe tener cantidad mayor que cero.');
    var unidad=String(c.Unidad||c.unidad||'').trim();
    if (!item || !unidad) throw new Error('Cada materia prima requiere Item y Unidad.');
    var clave=normalizar(item)+'|'+normalizar(variante);
    if (vistos[clave]) throw new Error('Materia prima duplicada en la corrección: '+item+'.');
    vistos[clave]=true;
    aBase(cantidad,unidad);
    return {item:item,variante:variante,cantidad:cantidad,unidad:unidad};
  });
}

function construirCorreccionProduccion_(payload,responsable) {
  var motivo=String(payload.Motivo||payload.motivo||'').trim();
  var referencia=String(payload.ReferenciaOriginal||payload.referenciaOriginal||'').trim();
  var tamborSolicitado=String(payload.TamborID||payload.tamborId||'').trim();
  if (motivo.length<8) throw new Error('Explica por qué se completa la producción (mínimo 8 caracteres).');
  var original=buscarPreparacionOriginal_(referencia,tamborSolicitado,false);
  var filaOriginal=original.fila;
  var producto=String(campo(filaOriginal,['producto'])||payload.Producto||'').trim();
  var tambor=original.tamborId;
  var componentes=validarComponentesCorreccion_(payload.Componentes||payload.componentes);
  var refReal=original.referencia;
  var filas=[{
    TipoRegistro:'Novedad/Corrección',Responsable:responsable,Categoria:'Producción',
    Producto:producto,TamborID:tambor,Motivo:'Completar materias primas',
    ReferenciaOriginal:refReal,Observacion:motivo,Origen:'Centro de correcciones'
  }];
  componentes.forEach(function(c,i) {
    filas.push({
      TipoRegistro:'Consumo materia prima',Responsable:responsable,Categoria:'Materia prima',
      Item:c.item,Variante:c.variante||'',Cantidad:c.cantidad,Unidad:c.unidad,
      Movimiento:'Consumo',Motivo:'Corrección de producción',Producto:producto,TamborID:tambor,
      ReferenciaOriginal:refReal,
      Observacion:'Componente faltante '+(i+1)+' · '+motivo,Origen:'Centro de correcciones'
    });
  });
  return filas;
}

function empiezaConProducto_(item,producto) {
  var ni=normalizar(item);
  var np=normalizar(producto);
  return ni===np || ni.indexOf(np+' ')===0;
}

function construirCorreccionTanque_(payload,responsable) {
  var motivo=String(payload.Motivo||payload.motivo||'').trim();
  var referencia=String(payload.ReferenciaOriginal||payload.referenciaOriginal||'').trim();
  var tamborId=String(payload.TamborID||payload.tamborId||'').trim();
  var productoNuevo=String(payload.Producto||payload.producto||'').trim();
  if (!tamborId) throw new Error('Selecciona el tanque que vas a corregir.');
  if (!productoNuevo) throw new Error('Escribe el nombre correcto del producto.');
  if (motivo.length<8) throw new Error('Explica el motivo de la corrección (mínimo 8 caracteres).');
  var original=buscarPreparacionOriginal_(referencia,tamborId,true);
  var inventario=getInventario();
  var tanqueActual=null;
  (inventario.tambores||[]).forEach(function(t) {
    if (normalizar(t.id)===normalizar(tamborId)) tanqueActual=t;
  });
  var productoAnterior=String((tanqueActual&&tanqueActual.producto)||campo(original.fila,['producto'])||'').trim();
  if (!productoAnterior) throw new Error('El tanque no tiene un producto anterior identificable.');
  if (normalizar(productoAnterior)===normalizar(productoNuevo)) {
    throw new Error('El nombre correcto es igual al nombre actual; no hay nada que cambiar.');
  }
  var refReal=original.referencia;
  var filas=[{
    TipoRegistro:'Corrección tanque',Responsable:responsable,Categoria:'Producción',
    Item:productoAnterior,Producto:productoNuevo,TamborID:tamborId,
    Motivo:'Corrección de nombre de tanque',ReferenciaOriginal:refReal,
    Observacion:motivo,Origen:'Centro de correcciones'
  }];
  var trasladar=payload.TrasladarEmpacados===true ||
    /^(si|sí|true|1)$/i.test(String(payload.TrasladarEmpacados||''));
  if (trasladar) {
    (inventario.items||[]).forEach(function(i) {
      var categoria=normalizar(i.Categoria||i.categoria||'');
      var variante=String(i.Variante||i.variante||'').trim();
      var item=String(i.Item||i.item||'').trim();
      var stock=Number(i.Stock!=null?i.Stock:i.stock);
      var unidad=String(i.Unidad||i.unidad||'und').trim();
      if (categoria!=='producto terminado' || normalizar(variante)!==normalizar(tamborId)) return;
      if (!(stock>0) || !empiezaConProducto_(item,productoAnterior)) return;
      var sufijo=item.slice(productoAnterior.length);
      var traslado={
        TipoRegistro:'Traslado inventario',Responsable:responsable,Categoria:'Producto terminado',
        Item:item,Variante:variante,Producto:(productoNuevo+sufijo).trim(),
        Cantidad:stock,Unidad:unidad,Motivo:'Corrección de producto del tanque',
        ReferenciaOriginal:refReal,Observacion:motivo,Origen:'Centro de correcciones'
      };
      validarTrasladoPost_(traslado);
      filas.push(traslado);
    });
  }
  return filas;
}

function validarMovimientoPost_(payload, tipo) {
  var nTipo = normalizar(tipo);
  if (nTipo.indexOf('empacar desde tambor') === 0 || nTipo.indexOf('empacar producto') === 0) validarEmpaquePost_(payload);
  if (nTipo.indexOf('consumo') === 0 || nTipo.indexOf('salida') === 0 || nTipo.indexOf('baja') >= 0) {
    validarStockItem_(payload.Item || payload.item,payload.Variante || payload.variante,payload.Cantidad || payload.cantidad,payload.Unidad || payload.unidad);
  }
  if (nTipo.indexOf('novedad') === 0) {
    var motivo = normalizar(payload.Motivo || payload.motivo);
    if (!motivo) throw new Error('La corrección debe indicar un Motivo explícito.');
    if (!String(payload.ReferenciaOriginal || payload.referenciaOriginal || '').trim()) throw new Error('La corrección requiere ReferenciaOriginal.');
  }
  if (nTipo.indexOf('estado tambor') === 0) {
    var tanqueEstado = String(payload.TamborID || payload.tamborId || '').trim();
    var estado = normalizar(payload.Motivo || payload.motivo);
    if (!tanqueEstado) throw new Error('TamborID es obligatorio para cambiar el estado.');
    if (['en proceso','listo'].indexOf(estado) < 0) throw new Error('El estado debe ser En proceso o Listo.');
    var listaTanques = getInventario().tambores || [];
    var existeTanque = listaTanques.some(function(t){return normalizar(t.id) === normalizar(tanqueEstado);});
    if (!existeTanque) throw new Error('No existe el tanque ' + tanqueEstado + '.');
  }
  if (nTipo === 'traslado inventario') validarTrasladoPost_(payload);
  if (nTipo === 'conteo inventario') {
    if (!String(payload.Item || '').trim()) throw new Error('El conteo requiere Item.');
    if (!String(payload.Unidad || '').trim()) throw new Error('El conteo requiere Unidad.');
    var contado=Number(String(payload.Cantidad == null ? '' : payload.Cantidad).replace(',','.'));
    if (!isFinite(contado) || contado<0) throw new Error('La cantidad contada debe ser cero o mayor.');
    if (!String(payload.Observacion || '').trim()) throw new Error('El conteo requiere una observación.');
  }
}

function validarTipoPermitido_(tipo) {
  var permitidos = [
    'entrada mercancia','preparar tambor','consumo materia prima','consumo base','estado tambor',
    'correccion tanque','correccion produccion',
    'empacar desde tambor','empacar producto','empacar materia prima','empacar solido/polvo',
    'salida directa/baja','fabricar palos','novedad/correccion','traslado inventario',
    'conteo inventario','revision item','movimiento compuesto'
  ];
  var n=normalizar(tipo);
  if (permitidos.indexOf(n)<0) throw new Error('Tipo de movimiento no permitido: '+tipo+'.');
}

function saldoItem_(item,variante) {
  var total=0;
  (getInventario().items||[]).forEach(function(i) {
    if (normalizar(i.Item)===normalizar(item) && normalizar(i.Variante||'')===normalizar(variante||'')) total+=Number(i.Stock)||0;
  });
  return redondear_(total,6);
}

function itemExisteOficial_(item) {
  var objetivo=normalizar(item);
  if (!objetivo) return false;
  var hoja=getHoja().getSheetByName(HOJA_CATALOGOS);
  if (!hoja) return false;
  var valores=hoja.getDataRange().getValues();
  for (var f=1;f<valores.length;f++) for (var c=0;c<valores[f].length;c++) if (normalizar(valores[f][c])===objetivo) return true;
  return false;
}

function validarTrasladoPost_(payload) {
  var origen=String(payload.Item||'').trim();
  var destino=String(payload.Producto||payload.ItemDestino||'').trim();
  if (!origen || !destino) throw new Error('El traslado requiere ítem de origen y destino.');
  if (normalizar(origen)===normalizar(destino)) throw new Error('El origen y el destino del traslado no pueden ser iguales.');
  if (!String(payload.Motivo||'').trim()) throw new Error('El traslado requiere un motivo.');
  if (!String(payload.ReferenciaOriginal||'').trim()) throw new Error('El traslado requiere ReferenciaOriginal.');
  var disponible=saldoItem_(origen,payload.Variante||'');
  if (disponible< -0.000001) throw new Error('No se puede trasladar un ítem con saldo negativo. Primero debe conciliarse.');
  if (payload.Cantidad !== '' && payload.Cantidad != null) {
    var solicitado=positivo_(payload.Cantidad,'La cantidad a trasladar debe ser mayor que cero.');
    if (solicitado>disponible+0.000001) throw new Error('El traslado supera el saldo disponible del ítem de origen.');
  }
}

function construirRevisionItem_(payload,responsable) {
  var accion=normalizar(payload.Accion||'').toUpperCase();
  var categoria=String(payload.Categoria||'').trim();
  var item=String(payload.Item||'').trim();
  var variante=String(payload.Variante||'').trim();
  var destino=String(payload.ItemDestino||payload.Producto||'').trim();
  var motivo=String(payload.Motivo||'').trim();
  var referencia=String(payload.ReferenciaOriginal||'').trim();
  if (['APROBAR','RENOMBRAR','RELACIONAR','ARCHIVAR'].indexOf(accion)<0) throw new Error('Acción de revisión no permitida.');
  if (!categoria || !item) throw new Error('La revisión requiere categoría e ítem de origen.');
  if (motivo.length<8) throw new Error('Explica el motivo de la decisión (mínimo 8 caracteres).');
  if (!referencia) throw new Error('La revisión requiere la referencia original.');
  var saldo=saldoItem_(item,variante);
  if (saldo< -0.000001) throw new Error('El ítem tiene saldo negativo y debe conciliarse antes de resolverlo.');
  if ((payload.OrigenManual===true || /^(si|sí|true|1)$/i.test(String(payload.OrigenManual||''))) && !itemExisteOficial_(item)) throw new Error('El nombre actual no existe en el catálogo oficial. Selecciónalo de la lista.');
  function aprobacion(itemA,motivoA,observacionA) {
    return {
      TipoRegistro:'Aprobación item',Responsable:responsable,Categoria:categoria,
      Item:itemA,Variante:variante,NuevoItem:'No',PendienteAprobacion:'No',
      Motivo:motivoA,ReferenciaOriginal:referencia,Observacion:observacionA,Origen:'Centro de revisiones'
    };
  }
  function traslado() {
    return {
      TipoRegistro:'Traslado inventario',Responsable:responsable,Categoria:categoria,
      Item:item,Variante:variante,Producto:destino,Cantidad:'',Unidad:'',
      Motivo:'Corrección de maestro',ReferenciaOriginal:referencia,
      Observacion:'Traslado total aprobado desde Revisiones: '+motivo,Origen:'Centro de revisiones'
    };
  }
  if (accion==='APROBAR') return [aprobacion(item,'Aprobado','Ítem validado como nombre oficial. Motivo: '+motivo)];
  if (accion==='ARCHIVAR') {
    if (Math.abs(saldo)>0.000001) throw new Error('No se puede archivar porque el ítem tiene saldo '+saldo+'. Debes renombrarlo o relacionarlo.');
    return [aprobacion(item,'Archivado','Solicitud archivada sin borrar historial. Motivo: '+motivo)];
  }
  if (!destino) throw new Error('Escribe el ítem destino.');
  if (normalizar(destino)===normalizar(item)) throw new Error('El nombre destino debe ser diferente al origen.');
  if (accion==='RELACIONAR' && !itemExisteOficial_(destino)) throw new Error('Para relacionar, el destino debe existir en el catálogo oficial.');
  if (accion==='RENOMBRAR' && itemExisteOficial_(destino)) throw new Error('Ese nombre ya existe. Usa Relacionar para evitar duplicados.');
  if (accion==='RELACIONAR') return [
    aprobacion(item,'Relacionado','Relacionado con el ítem oficial '+destino+'. Motivo: '+motivo),
    traslado()
  ];
  return [
    aprobacion(item,'Renombrado','Nombre corregido a '+destino+'. Motivo: '+motivo),
    traslado(),
    aprobacion(destino,'Aprobado','Nombre corregido y aprobado. Motivo: '+motivo)
  ];
}

function validarBaseDisponible_(tamborId,litros) {
  var tambores = getInventario().tambores || [];
  for (var i=0;i<tambores.length;i++) {
    if (normalizar(tambores[i].id) === normalizar(tamborId)) {
      if (litros > Number(tambores[i].disponible) + 0.001) {
        throw new Error('Base insuficiente en ' + tamborId + ': disponible ' + tambores[i].disponible + ' L, solicitado ' + redondear_(litros,3) + ' L.');
      }
      return;
    }
  }
  throw new Error('Tanque de base no encontrado: ' + tamborId + '.');
}

function validarEmpaquePost_(payload) {
  var tamborId = String(payload.TamborID || payload.tamborId || payload.Tambor || '').trim();
  var presentacion = String(payload.Presentacion || payload.presentacion || '').trim();
  var cantidad = positivo_(payload.CantidadPresentacion || payload.cantidadPresentacion,'CantidadPresentacion debe ser mayor que cero.');
  var litros = litrosPresentacion_(presentacion,cantidad);
  if (litros <= 0) throw new Error('La presentación no tiene conversión de volumen configurada.');
  var tambores = getInventario().tambores || [];
  var encontrado = null;
  for (var i=0;i<tambores.length;i++) if (normalizar(tambores[i].id) === normalizar(tamborId)) encontrado = tambores[i];
  if (!encontrado) throw new Error('Tambor no encontrado: ' + tamborId + '.');
  if (litros > Number(encontrado.disponible) + 0.001) throw new Error('Inventario insuficiente en ' + tamborId + ': disponible ' + encontrado.disponible + ' L, solicitado ' + redondear_(litros,3) + ' L.');
}

function litrosPresentacion_(presentacion,cantidad) {
  var t = tamanoDe(presentacion);
  if (t && t.u === 'L') return t.v * cantidad;
  if (/recarga/i.test(presentacion)) return /mililitro|\bml\b/i.test(presentacion) ? cantidad/1000 : cantidad;
  return 0;
}

function validarStockComponentes_(componentes) {
  var acumulado = {};
  componentes.forEach(function (c) {
    if (normalizar(c.item) === 'agua') return;
    var conv = aBase(c.cantidad,c.unidad);
    var key = normalizar(c.item)+'|'+normalizar(c.variante)+'|'+conv.u;
    if (!acumulado[key]) acumulado[key] = {item:c.item,variante:c.variante,cantidad:0,unidad:conv.u};
    acumulado[key].cantidad += conv.v;
  });
  for (var k in acumulado) validarStockItem_(acumulado[k].item,acumulado[k].variante,acumulado[k].cantidad,acumulado[k].unidad);
}

function validarStockItem_(item,variante,cantidad,unidad) {
  item = String(item || '').trim();
  if (!item || normalizar(item) === 'agua') return;
  var solicitado = aBase(positivo_(cantidad,'Cantidad debe ser mayor que cero.'),unidad).v;
  var base = aBase(1,unidad).u;
  var items = getInventario().items || [];
  var disponible = 0;
  for (var i=0;i<items.length;i++) {
    if (normalizar(items[i].Item) === normalizar(item) && normalizar(items[i].Variante) === normalizar(variante || '')) {
      var conv = aBase(items[i].Stock,items[i].Unidad);
      if (conv.u === base) disponible += conv.v;
    }
  }
  if (solicitado > disponible + 0.000001) throw new Error('Inventario insuficiente de ' + item + ': disponible ' + redondear_(disponible,3) + ' ' + base + ', solicitado ' + redondear_(solicitado,3) + ' ' + base + '.');
}

function positivo_(valor,mensaje) {
  var n = Number(String(valor == null ? '' : valor).replace(',','.'));
  if (!isFinite(n) || n <= 0) throw new Error(mensaje || 'Cantidad inválida.');
  return n;
}

function redondear_(n,d) { var p=Math.pow(10,d||2); return Math.round((Number(n)+Number.EPSILON)*p)/p; }

function hashFila_(fila) {
  var bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(fila),Utilities.Charset.UTF_8);
  return bytes.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
}

// La huella permite distinguir un reintento idéntico de la reutilización
// accidental (o maliciosa) del mismo RequestId con otro movimiento.
function hashPayload_(payload) {
  return hashFila_([serializarEstable_(payload)]);
}

function serializarEstable_(valor) {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return '[' + valor.map(serializarEstable_).join(',') + ']';
  if (typeof valor === 'object') {
    var partes=[];
    Object.keys(valor).sort().forEach(function(k) {
      if (valor[k] === undefined) return;
      partes.push(JSON.stringify(k)+':'+serializarEstable_(valor[k]));
    });
    return '{'+partes.join(',')+'}';
  }
  return JSON.stringify(valor);
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
