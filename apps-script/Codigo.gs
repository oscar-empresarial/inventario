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
    } else if (p.action === 'auditoria') {
      data = getAuditoriaDiaria();
    } else if (p.action === 'preguntas') {
      data = getPreguntasPendientes();
    } else if (p.action === 'repararlitros') {
      // Sin ?aplicar=si solo informa qué haría; nunca escribe por accidente.
      data = repararLitrosConFecha_(String(p.aplicar||'') !== 'si');
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
// Cuántas filas del final se revisan para buscar un RequestId. Un reintento real ocurre
// en segundos o minutos, nunca semanas después, así que esta ventana lo cubre de sobra y
// evita que el costo crezca para siempre con el tamaño de la hoja.
var VENTANA_BUSQUEDA_FILAS = 500;

// Marca los registros de prueba técnica para que no ensucien la auditoría ni las listas.
// Deliberadamente estricto: solo el prefijo ZZ-PRUEBA de los tanques de prueba y los
// productos que empiezan por "prueba ". Un producto real jamás se llama así.
function esDePrueba_(tanque, producto) {
  var t = normalizar(tanque), p = normalizar(producto);
  return t.indexOf('zz-prueba') === 0 || p.indexOf('prueba tecnica') === 0 ||
         p.indexOf('prueba formato') === 0 || p.indexOf('prueba sobrante') === 0 ||
         p.indexOf('prueba mensaje') === 0;
}

function ventanaFinal_(hoja, filas) {
  var ultima = hoja.getLastRow();
  if (ultima < 2) return null;
  var inicio = Math.max(2, ultima - filas + 1);
  return hoja.getRange(inicio, 1, ultima - inicio + 1, hoja.getLastColumn());
}

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
      // La app consulta esto hasta 12 veces por cada guardado. Leer TODA la hoja cada vez
      // era lo que ponía lento al Apps Script y hacía que las peticiones se encolaran.
      // El movimiento que se está confirmando acaba de escribirse: está al final.
      var rango = ventanaFinal_(hoja, VENTANA_BUSQUEDA_FILAS);
      var valores = rango ? rango.getDisplayValues() : [];
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
      var esResta = mot.indexOf('faltante') >= 0 || mot.indexOf('merma') >= 0 || mot.indexOf('registro de mas') >= 0;
      // La resta manda si el motivo menciona las dos cosas: "merma - sobrante devuelto" debe
      // restar, no sumar. Antes ganaba la suma y un ajuste terminaba inflando el saldo.
      var esSuma = !esResta && (mot.indexOf('sobrante') >= 0 || mot.indexOf('desempaque') >= 0);
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

  // Los tanques vacíos NO desaparecen: quedan marcados "Vacío" para volverlos a usar.
  // OJO: aquí había un .slice(-30) que ocultaba los tanques más viejos; cuando el
  // conteo de IDs pasó de 30, el tanque 1 desapareció de la app y del validador de
  // empaque ("Tambor no encontrado") aunque su preparación SÍ estaba guardada.
  var tamboresDisponibles = tambores
    // Los tanques de prueba técnica (ZZ-PRUEBA-*) no son producción: ensucian la lista que
    // ve el operario y disparan alertas falsas en la auditoría. Nunca tienen producto real.
    .filter(function (t) { return !esDePrueba_(t.id, t.producto); })
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

// Repara las celdas `LitrosPreparados` que quedaron guardadas como fecha.
// NO inventa números: usa la suma de los componentes de esa misma producción, que es dato
// real ya registrado (la app exige que expliquen entre el 80% y el 105% del volumen).
// Si algún componente también está dañado, no toca esa fila y la devuelve como pendiente.
// Con `soloVer=true` no escribe nada: solo dice qué haría.
function repararLitrosConFecha_(soloVer) {
  var hoja = getHoja().getSheetByName(HOJA_REGISTRO);
  var encabezados = hoja.getRange(1,1,1,hoja.getLastColumn()).getDisplayValues()[0];
  var iLitros = indiceEncabezado_(encabezados,'LitrosPreparados');
  if (iLitros < 0) throw new Error('No existe la columna LitrosPreparados.');
  var datos = leerRegistros();

  // Componentes sanos por operación
  var comps = {};
  datos.filas.forEach(function(r) {
    if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('consumo') !== 0) return;
    var op = String(campo(r,['operacionid'])||'').trim();
    if (!op) return;
    var crudo = r['Cantidad'];
    var textoCrudo = String(crudo == null ? '' : crudo);
    var danado = /^\d{4}-\d{2}-\d{2}T/.test(textoCrudo) || num(textoCrudo) > 100000;
    var conv = aBase(num(crudo), String(campo(r,['unidad'])||''));
    (comps[op] = comps[op] || {litros:0, danado:false});
    if (danado) comps[op].danado = true;
    else if (conv.u === 'L') comps[op].litros += conv.v;
  });

  var arreglados = [], pendientes = [];
  datos.filas.forEach(function(r) {
    if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('preparar tambor') !== 0) return;
    var crudo = String(r['LitrosPreparados'] == null ? '' : r['LitrosPreparados']);
    // Dos formas del mismo daño: la celda sigue siendo fecha, o ya se destapó como el
    // número interno de esa fecha (46144 = 2-may-2026). Ningún tanque pasa de 1.000 L.
    var esFecha = /^\d{4}-\d{2}-\d{2}T/.test(crudo);
    var esAbsurdo = num(crudo) > 1000;
    if (!esFecha && !esAbsurdo) return;   // esta fila está sana
    var op = String(campo(r,['operacionid'])||'').trim();
    var info = comps[op];
    var etiqueta = 'fila '+r._FilaOrigen+' · tanque '+String(campo(r,['tamborid','tambor'])||'')+' · '+String(campo(r,['producto'])||'');
    if (!info || info.danado || !(info.litros > 0)) {
      pendientes.push(etiqueta + ' — sus componentes también están dañados o no suman volumen; necesita el dato real');
      return;
    }
    var litros = redondear_(info.litros,3);
    if (!soloVer) {
      var celda = hoja.getRange(r._FilaOrigen, iLitros + 1);
      celda.setNumberFormat('0.######');
      celda.setValue(litros);
    }
    arreglados.push(etiqueta + ' → ' + litros + ' L (suma de sus materias primas)');
  });
  if (!soloVer) { try { SpreadsheetApp.flush(); } catch (e) {} }
  return {ok:true, soloVer: !!soloVer, arreglados:arreglados, pendientes:pendientes};
}

// ================== AUDITORÍA DIARIA ==================
// Controles elegidos por lo que REALMENTE falló en esta operación (jul-2026), no por teoría:
// duplicados, negativos, conteos que pisan el saldo, números imposibles y unidades mezcladas.
// Práctica estándar de la industria que se respeta aquí: conteo cíclico + análisis de la causa
// de cada variación, no solo corregir el número.
// ================== PREGUNTAS AL OPERARIO (action=preguntas) ==================
// Devuelve SOLO lo que ningún cálculo puede resolver: hay que preguntárselo a quien está
// en la planta. Cada pregunta se responde con un Conteo inventario normal, así que en
// cuanto se responde el saldo deja de ser absurdo y la pregunta desaparece sola. No hay
// estado que mantener ni lista que actualizar a mano.
function getPreguntasPendientes() {
  var inv = getInventario();
  var datos = leerRegistros();
  var preguntas = [];

  // Unidades que ha usado cada ítem a lo largo de su historia, para sugerir la correcta.
  var unidadesDe = {};
  datos.filas.forEach(function(r) {
    var it = normalizar(String(campo(r,['item'])||'').trim());
    var uni = String(campo(r,['unidad'])||'').trim();
    if (!it || !uni) return;
    unidadesDe[it] = unidadesDe[it] || {};
    unidadesDe[it][uni] = (unidadesDe[it][uni] || 0) + 1;
  });
  function unidadesUsadas(item) {
    var m = unidadesDe[normalizar(item)] || {};
    return Object.keys(m).sort(function(a,b){return m[b]-m[a];});
  }

  (inv.items||[]).forEach(function(i) {
    if (normalizar(i.Categoria) !== 'materia prima') return;
    var usadas = unidadesUsadas(i.Item);
    var saldo = Number(i.Stock);

    // 1) Saldo imposible: casi siempre una celda de conteo que quedó con formato de fecha.
    if (Math.abs(saldo) > 1000) {
      preguntas.push({
        id: 'saldo_imposible|' + normalizar(i.Item) + '|' + normalizar(i.Variante),
        item: i.Item, variante: i.Variante || '', categoria: i.Categoria,
        titulo: i.Item + ' marca ' + redondear_(saldo,1) + ' ' + i.Unidad,
        detalle: 'Eso es imposible en planta. Pasó porque la celda de un conteo viejo quedó con formato de fecha y Sheets convirtió el número en una fecha. Nunca se ha vuelto a contar, así que el saldo sigue mal desde entonces.',
        pregunta: '¿Cuánto hay HOY de ' + i.Item + '?',
        unidades: usadas.length ? usadas : [i.Unidad],
        unidadSugerida: usadas[0] || i.Unidad
      });
      return;
    }

    // 2) El saldo quedó en "und" pero el ítem siempre se movió a granel (L o kg): un conteo
    //    en "und" borra los litros y deja un saldo que no dice nada.
    var baseSaldo = aBase(1, i.Unidad).u;
    if (baseSaldo !== 'L' && baseSaldo !== 'kg') {
      var granel = usadas.filter(function(u){ var b = aBase(1,u).u; return b === 'L' || b === 'kg'; });
      if (granel.length) {
        preguntas.push({
          id: 'unidad_saldo|' + normalizar(i.Item) + '|' + normalizar(i.Variante),
          item: i.Item, variante: i.Variante || '', categoria: i.Categoria,
          titulo: i.Item + ' marca ' + i.Stock + ' ' + i.Unidad + ', pero siempre se ha movido en ' + granel[0],
          detalle: 'El último conteo se registró en "' + i.Unidad + '" y eso borró los ' + granel[0] + ' que traía. Así el saldo no sirve para saber si alcanza para producir.',
          pregunta: '¿Cuánto hay HOY de ' + i.Item + ', en ' + granel[0] + '?',
          unidades: granel,
          unidadSugerida: granel[0]
        });
      }
    }
  });

  return { ok:true, version:API_VERSION, generado:new Date().toISOString(), preguntas:preguntas };
}

function getAuditoriaDiaria() {
  var inv = getInventario();
  var datos = leerRegistros();
  var hallazgos = [];
  function add(codigo,prioridad,entidad,detalle,accion) {
    hallazgos.push({codigo:codigo,prioridad:prioridad,entidad:entidad,detalle:detalle,accion:accion});
  }

  // 1. Saldos negativos. Se separan porque significan cosas distintas:
  //    materia prima negativa = consumo mal registrado; envase negativo = compra sin registrar.
  var negMp = [], negOtro = [];
  (inv.items||[]).forEach(function(i) {
    if (Number(i.Stock) >= -0.0001) return;
    var linea = i.Item + (i.Variante ? ' / '+i.Variante : '') + ': ' + i.Stock + ' ' + i.Unidad;
    if (normalizar(i.Categoria) === 'materia prima') negMp.push(linea); else negOtro.push(linea);
  });
  if (negMp.length) add('STOCK_NEGATIVO_MP','ALTA','Materia prima',
    negMp.length+' en negativo: '+negMp.slice(0,8).join(' · '),
    'Consumo registrado sin existencia. Revisar la producción que lo causó.');
  if (negOtro.length) add('STOCK_NEGATIVO_ENVASE','MEDIA','Envases/etiquetas/accesorios',
    negOtro.length+' en negativo (el peor: '+negOtro[0]+')',
    'Normalmente es compra sin registrar: registrar la entrada, no ajustar el saldo.');

  // 1b. Materia prima con un saldo imposible HOY. Este control faltaba y por eso la Soda
  //     Cáustica llevaba desde el 25-jul marcando 46.052 kg (46 toneladas) sin que nadie
  //     lo viera: el control viejo solo miraba el saldo ANTERIOR a un conteo, así que un
  //     ítem contado UNA sola vez —y justo esa vez con la celda dañada— no se detectaba.
  (inv.items||[]).forEach(function(i) {
    if (normalizar(i.Categoria) !== 'materia prima') return;
    var s = Number(i.Stock);
    if (!(Math.abs(s) > 1000)) return;
    add('SALDO_IMPOSIBLE','ALTA', i.Item,
      'Marca '+redondear_(s,1)+' '+i.Unidad+' hoy. Ninguna materia prima llega a ese volumen.',
      'Casi seguro un conteo cuya celda quedó con formato de fecha. Hay que preguntar cuánto hay de verdad y registrar un Conteo con el valor real.');
  });

  // 2. Tanques con número imposible (así se detecta el tanque 13 con 2.026 L de una celda-fecha).
  (inv.tambores||[]).forEach(function(t) {
    var d = Number(t.disponible);
    if (!isFinite(d)) add('TANQUE_NO_NUMERICO','ALTA','Tanque '+t.id,'Disponible no numérico: '+t.disponible,'Revisar la celda LitrosPreparados.');
    else if (d > 500) add('TANQUE_VOLUMEN_IMPOSIBLE','ALTA','Tanque '+t.id,
      t.producto+' marca '+d+' L','Ningún tanque llega a ese volumen: casi siempre es una celda con fecha o unidad mal puesta.');
  });

  // 3. Preparaciones duplicadas ya guardadas (las de antes del guardarraíl).
  var prep = {};
  datos.filas.forEach(function(r) {
    var tp = normalizar(campo(r,['tiporegistro','tipo']));
    var op = String(campo(r,['operacionid'])||'').trim();
    if (!op) return;
    if (tp.indexOf('preparar tambor') === 0) {
      prep[op] = {tanque:String(campo(r,['tamborid','tambor'])||'').trim(),
                  producto:String(campo(r,['producto'])||'').trim(),
                  fecha:new Date(campo(r,['fechaservidor','fechahora'])).getTime(), comps:[]};
    }
  });
  datos.filas.forEach(function(r) {
    if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('consumo materia prima') !== 0) return;
    var op = String(campo(r,['operacionid'])||'').trim();
    if (prep[op]) prep[op].comps.push({item:String(campo(r,['item'])||'').trim(),
      cantidad:num(campo(r,['cantidad'])), unidad:String(campo(r,['unidad'])||'').trim()});
  });
  // Salidas de cada tanque (empaque o consumo de base). Sirven para saber si el tanque se
  // vació entre dos preparaciones: preparar, empacar todo y volver a preparar es el trabajo
  // normal, NO un duplicado. Sin esta comprobación el tanque 28 generaba alertas falsas.
  var salidasPorTanque = {};
  datos.filas.forEach(function(r) {
    var tp = normalizar(campo(r,['tiporegistro','tipo']));
    if (tp.indexOf('empacar') !== 0 && tp.indexOf('consumo base') !== 0) return;
    var tq = normalizar(String(campo(r,['tamborid','tambor'])||'').trim());
    if (!tq) return;
    var fch = new Date(campo(r,['fechaservidor','fechahora'])).getTime();
    if (!fch) return;
    (salidasPorTanque[tq] = salidasPorTanque[tq] || []).push(fch);
  });
  function huboSalidaEntre_(tanque, desde, hasta) {
    var lista = salidasPorTanque[normalizar(tanque)] || [];
    for (var s=0;s<lista.length;s++) if (lista[s] > desde && lista[s] < hasta) return true;
    return false;
  }

  var porFirma = {};
  for (var op in prep) {
    var p = prep[op];
    if (!p.comps.length || !p.fecha) continue;
    if (esDePrueba_(p.tanque, p.producto)) continue; // pruebas técnicas, no producción
    var f = firmaProduccion_(p.producto,p.tanque,p.comps);
    (porFirma[f] = porFirma[f] || []).push({op:op, fecha:p.fecha, tanque:p.tanque, producto:p.producto});
  }
  for (var f in porFirma) {
    var lista = porFirma[f].sort(function(a,b){return a.fecha-b.fecha;});
    for (var k=1;k<lista.length;k++) {
      var horas = (lista[k].fecha - lista[k-1].fecha)/3600000;
      if (horas > 24) continue;
      // Si el tanque se vació en el intermedio, la segunda preparación es legítima.
      if (huboSalidaEntre_(lista[k].tanque, lista[k-1].fecha, lista[k].fecha)) continue;
      add('PREPARACION_DUPLICADA','ALTA','Tanque '+lista[k].tanque,
        lista[k].producto+' registrado 2 veces con '+redondear_(horas,1)+' h de diferencia, sin salida del tanque en el intermedio ('+lista[k-1].op+' y '+lista[k].op+')',
        'Si fue error, revertir con Novedad/Corrección; no borrar el movimiento.');
    }
  }

  // 4. Conteos que pisaron fuerte el saldo. NO es un error: es la señal de cuánto se
  //    escapa sin registrar. Es el control que más dice sobre la salud del proceso.
  var saldo = {};
  var desvios = [];
  var corruptosHist = [];
  datos.filas.forEach(function(r) {
    var tp = normalizar(campo(r,['tiporegistro','tipo']));
    var item = String(campo(r,['item'])||'').trim();
    if (!item || normalizar(item)==='agua') return;
    if (normalizar(String(campo(r,['categoria'])||'')) !== 'materia prima') return;
    var clave = normalizar(item);
    var conv = aBase(num(campo(r,['cantidad'])), String(campo(r,['unidad'])||''));
    if (tp.indexOf('entrada') === 0) saldo[clave] = (saldo[clave]||0) + conv.v;
    else if (tp.indexOf('consumo') === 0) saldo[clave] = (saldo[clave]||0) - conv.v;
    else if (tp.indexOf('conteo') === 0) {
      var antes = saldo[clave];
      if (antes != null && Math.abs(antes) > 0.01) {
        var dif = conv.v - antes;
        // Un saldo previo absurdo (miles de litros de una materia prima) no es un desvío de
        // conteo: es una celda dañada, normalmente una fecha leída como número (2017, 2026).
        if (Math.abs(antes) > 1000) {
          // Ya lo tapó el conteo de esta misma línea. Se acumula para informarlo UNA vez
          // como historia; antes salía como ALTA todos los días para siempre, y ese ruido
          // es lo que hace que nadie lea la auditoría.
          corruptosHist.push(item+' ('+String(campo(r,['fechaservidor','fechahora'])||'').slice(0,10)+')');
        } else if (Math.abs(dif)/Math.abs(antes) > 0.5) {
          desvios.push({item:item, antes:redondear_(antes,3), quedo:conv.v,
            unidad:conv.u, fecha:String(campo(r,['fechaservidor','fechahora'])||'').slice(0,10)});
        }
      }
      saldo[clave] = conv.v;
    }
  });
  if (corruptosHist.length) {
    add('DATO_CORRUPTO_HISTORICO','BAJA','Materia prima',
      corruptosHist.length+' conteos viejos quedaron con una fecha en la celda y ya fueron tapados por un conteo posterior: '+corruptosHist.slice(0,6).join(' · '),
      'No hay nada que hacer: el saldo de hoy ya no depende de esos valores. Queda como historia.');
  }
  if (desvios.length) {
    var ultimos = desvios.slice(-6).map(function(d){return d.item+' '+d.antes+'→'+d.quedo+' '+d.unidad+' ('+d.fecha+')';});
    add('CONTEO_DESVIO_ALTO','ALTA','Materia prima',
      desvios.length+' conteos corrigieron el saldo más del 50%. Últimos: '+ultimos.join(' · '),
      'El conteo físico manda. La diferencia es material que se fue sin registrar: buscar la causa (mermas, derrames, consumos no anotados), no solo ajustar.');
  }

  // 5. Unidades mezcladas en un mismo ítem. Solo importa L contra kg: sumar volumen con peso
  //    da un saldo falso. Que un ítem tenga L y "und" es normal (líquido a granel + empacado),
  //    así que ese caso NO se reporta para no llenar de ruido el informe.
  var unidadDe = {};
  var yaAvisado = {};
  datos.filas.forEach(function(r) {
    var item = String(campo(r,['item'])||'').trim();
    var uni = String(campo(r,['unidad'])||'').trim();
    if (!item || !uni) return;
    var clave = normalizar(item), base = aBase(1,uni).u;
    if (base !== 'L' && base !== 'kg') return;
    if (unidadDe[clave] && unidadDe[clave] !== base && !yaAvisado[clave]) {
      yaAvisado[clave] = true;
      add('UNIDAD_MEZCLADA','ALTA',item,'Tiene movimientos en '+unidadDe[clave]+' y en '+base,
        'Sumar volumen con peso da un saldo falso. Unificar la unidad de este ítem.');
    } else if (!unidadDe[clave]) unidadDe[clave] = base;
  });

  // 6. Consumido sin haber entrado nunca: el caso de las etiquetas.
  var entro = {}, consumio = {};
  datos.filas.forEach(function(r) {
    var tp = normalizar(campo(r,['tiporegistro','tipo']));
    var item = String(campo(r,['item'])||'').trim();
    if (!item) return;
    if (tp.indexOf('entrada') === 0 || tp.indexOf('conteo') === 0) entro[normalizar(item)] = true;
    else if (tp.indexOf('consumo') === 0) consumio[normalizar(item)] = item;
  });
  var nuncaEntro = [];
  for (var c in consumio) if (!entro[c] && c !== 'agua') nuncaEntro.push(consumio[c]);
  if (nuncaEntro.length) add('CONSUMO_SIN_ENTRADA','MEDIA','Materia prima',
    nuncaEntro.length+' ítems se consumieron sin registrar nunca una entrada: '+nuncaEntro.slice(0,6).join(', '),
    'Registrar las compras: si nunca entra, el saldo solo puede bajar.');

  // 7. Celdas numéricas que quedaron con formato de fecha. Es la causa raíz de los saldos
  //    absurdos: se listan con la fila exacta de la hoja para poder corregirlas a mano.
  var celdasFecha = [];
  datos.filas.forEach(function(r) {
    ['Cantidad','LitrosPreparados','CantidadPresentacion'].forEach(function(col) {
      var v = String(r[col] == null ? '' : r[col]);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return;
      celdasFecha.push('fila '+r._FilaOrigen+' ('+String(campo(r,['tiporegistro','tipo']))+' · '+
        (String(campo(r,['item']))||String(campo(r,['producto'])))+' · '+col+')');
    });
  });
  if (celdasFecha.length) add('CELDA_CON_FECHA','ALTA','Hoja REGISTRO_APP',
    celdasFecha.length+' celdas numéricas tienen una fecha adentro: '+celdasFecha.slice(0,10).join(' · ')+
    (celdasFecha.length>10 ? ' … y '+(celdasFecha.length-10)+' más' : ''),
    'Poner el valor real en esas celdas y dejar la columna con formato Número. Los movimientos nuevos ya salen forzados a número.');

  var orden = {ALTA:0, MEDIA:1, BAJA:2};
  hallazgos.sort(function(a,b){ return (orden[a.prioridad]||9)-(orden[b.prioridad]||9); });
  return {
    ok: true,
    generado: new Date().toISOString(),
    resumen: {
      hallazgos: hallazgos.length,
      altas: hallazgos.filter(function(h){return h.prioridad==='ALTA';}).length,
      items: (inv.items||[]).length,
      tanques: (inv.tambores||[]).length,
      movimientos: datos.filas.length,
      itemsNegativos: negMp.length + negOtro.length
    },
    hallazgos: hallazgos
  };
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
      // Ventana final en vez de la hoja completa: ver VENTANA_BUSQUEDA_FILAS.
      var rangoPrev = ventanaFinal_(hoja, VENTANA_BUSQUEDA_FILAS);
      var anteriores = rangoPrev ? rangoPrev.getDisplayValues() : [];
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
    var filaInicio = hoja.getLastRow() + 1;
    // Si una columna numérica queda con formato de fecha, Sheets convierte el número a
    // fecha y al leerlo se interpreta como el año: "20 L" pasó a valer 2.026 L (1-ago-2026).
    // Formatear solo las filas nuevas NO alcanzó: sin flush, setNumberFormat y setValues no
    // tienen orden garantizado y el formato viejo llegó a ganar. Por eso ahora son 3 pasos
    // con flush entre ellos, y al final se verifica lo que quedó escrito de verdad.
    var colsNumericas = [];
    ['Cantidad','LitrosPreparados','CantidadPresentacion'].forEach(function(nombreCol) {
      var idx = indiceEncabezado_(encabezados, nombreCol);
      if (idx >= 0) colsNumericas.push({nombre:nombreCol, col:idx + 1});
    });
    colsNumericas.forEach(function(c) {
      // Toda la columna, no solo las filas nuevas: así ninguna escritura futura hereda
      // el formato de fecha que haya quedado en una fila vieja.
      try { hoja.getRange(2, c.col, Math.max(hoja.getMaxRows() - 1, 1), 1).setNumberFormat('0.######'); } catch (eFmt) {}
    });
    try { SpreadsheetApp.flush(); } catch (eF1) {}

    hoja.getRange(filaInicio, 1, filas.length, encabezados.length).setValues(filas);
    try { SpreadsheetApp.flush(); } catch (eF2) {}

    // Red de seguridad: si algo quedó como fecha pese a todo, se reescribe como número.
    colsNumericas.forEach(function(c) {
      try {
        var rango = hoja.getRange(filaInicio, c.col, filas.length, 1);
        var leidos = rango.getValues();
        var hayQueCorregir = false;
        for (var i = 0; i < leidos.length; i++) {
          if (!(leidos[i][0] instanceof Date)) continue;
          var original = filas[i][c.col - 1];
          var comoNumero = Number(String(original == null ? '' : original).replace(',','.'));
          leidos[i][0] = isFinite(comoNumero) && String(original).trim() !== '' ? comoNumero : '';
          hayQueCorregir = true;
        }
        if (hayQueCorregir) { rango.setNumberFormat('0.######'); rango.setValues(leidos); }
      } catch (eFix) {}
    });

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
  ['OperacionID','IdempotencyKey','RequestHash','EstadoMovimiento','FechaServidor','Usuario','VersionBOM','HashIntegridad','DestinoTambor','ReferenciaOriginal','AprobadoPor'].forEach(function (nombre) {
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
  avisarSiPareceDuplicada_(payload,producto,tamborId,componentes);
  var residuo = resolverResiduoTanque_(payload,tamborId);
  return {producto:producto,litros:litros,tamborId:tamborId,componentes:componentes,
          baseTanque:baseTanque,baseLitros:baseLitros,residuoADescartar:residuo};
}

// Cuando se prepara sobre un tanque que "según el sistema" tiene sobras, el saldo viejo se
// sumaba al lote nuevo sin avisar. Eso arrastra fantasmas (al tanque 1 le colgaban 10 L que
// ya no existían) y también infla cuando el sobrante YA venía contado dentro de los litros
// declarados (al tanque 25 lo dejó en 20,5 L siendo un tanque de 20 L).
//
// La pregunta que de verdad importa no es qué hizo con el sobrante, sino qué significan los
// litros que declaró: ¿son el TOTAL que quedó en el tanque, o litros NUEVOS que se suman?
//   'total'    → el tanque queda con lo declarado (el sobrante ya está adentro, o se botó)
//   'adicional'→ el tanque queda con sobrante + lo declarado (rellenó el mismo tanque)
function resolverResiduoTanque_(payload,tamborId) {
  var tambores = getInventario().tambores || [];
  var disponible = 0, existe = false;
  for (var i=0;i<tambores.length;i++) {
    if (normalizar(tambores[i].id) === normalizar(tamborId)) { disponible = Number(tambores[i].disponible)||0; existe = true; break; }
  }
  if (!existe || disponible <= 0.01) return 0;   // tanque nuevo o vacío: nada que preguntar
  var decision = normalizar(payload.ResiduoTanque || payload.residuoTanque || '');
  // 'adicional' = se rellenó encima: se suman, comportamiento histórico.
  if (decision === 'adicional' || decision === 'nuevos') return 0;
  // 'total' cubre las dos formas de que el sobrante NO deba sumarse aparte: lo aprovechó
  // dentro de la mezcla, o vació el tanque. En ambos casos el tanque queda con lo declarado.
  if (decision === 'total' || decision === 'aprovechado' || decision === 'vaciado' || decision === 'descartado') return disponible;
  // El texto muestra CON CUÁNTO QUEDA EL TANQUE en cada opción. Preguntar "¿aprovechaste el
  // sobrante?" se malinterpretó: Carlos preparó 1 L sobre 11 L para llegar a 12, respondió
  // que sí lo aprovechaba, y el tanque quedó en 1 L. Con los números a la vista no hay dudas.
  var nuevos = Number(payload.LitrosPreparados || payload.litrosPreparados) || 0;
  throw new Error(
    'RESIDUO EN EL TANQUE ' + tamborId + ': el sistema dice que ya había ' + redondear_(disponible,2) +
    ' L y estás registrando ' + redondear_(nuevos,2) + ' L. ¿Con cuánto debe quedar el tanque? ' +
    '>>> Si los ' + redondear_(nuevos,2) + ' L son ADICIONALES a lo que había, el tanque queda con ' +
    redondear_(disponible + nuevos,2) + ' L. ' +
    '>>> Si los ' + redondear_(nuevos,2) + ' L son el TOTAL del tanque, queda con ' + redondear_(nuevos,2) + ' L.'
  );
}

// Firma de una preparación: producto + tanque + componentes (sin agua, que varía al ojo).
// Dos preparaciones con la misma firma en pocas horas casi siempre son la misma tecleada dos veces.
function firmaProduccion_(producto,tamborId,componentes) {
  var partes = componentes
    .filter(function(c){ return normalizar(c.item) !== 'agua'; })
    .map(function(c){ var b=aBase(c.cantidad,c.unidad); return normalizar(c.item)+':'+redondear_(b.v,4)+b.u; })
    .sort();
  return normalizar(producto)+'@'+normalizar(tamborId)+'#'+partes.join(',');
}

// Guardarraíl anti-duplicado. AVISA y exige confirmar; no bloquea para siempre,
// porque a veces sí se prepara dos veces el mismo producto el mismo día.
// Para confirmar, la app reenvía el mismo movimiento con ConfirmoNoDuplicado: true.
function avisarSiPareceDuplicada_(payload,producto,tamborId,componentes) {
  var confirmado = payload.ConfirmoNoDuplicado === true || payload.confirmoNoDuplicado === true ||
                   /^(si|sí|true|1)$/i.test(String(payload.ConfirmoNoDuplicado || payload.confirmoNoDuplicado || ''));
  if (confirmado) return;
  var firmaNueva = firmaProduccion_(producto,tamborId,componentes);
  var datos = leerRegistros();
  var VENTANA_MS = 24*60*60*1000;
  var ahora = new Date().getTime();

  // Agrupar las preparaciones recientes de ESTE tanque con sus componentes
  var prepara = {}; // operacionId → {fecha, producto}
  datos.filas.forEach(function(r) {
    if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('preparar tambor') !== 0) return;
    if (normalizar(String(campo(r,['tamborid','tambor'])||'')) !== normalizar(tamborId)) return;
    var f = new Date(campo(r,['fechaservidor','fechahora'])).getTime();
    if (!f || (ahora - f) > VENTANA_MS || f > ahora) return;
    var op = String(campo(r,['operacionid'])||'').trim();
    if (op) prepara[op] = {fecha:f, producto:String(campo(r,['producto'])||'').trim(), comps:[]};
  });
  if (!Object.keys(prepara).length) return;

  datos.filas.forEach(function(r) {
    if (normalizar(campo(r,['tiporegistro','tipo'])).indexOf('consumo materia prima') !== 0) return;
    var op = String(campo(r,['operacionid'])||'').trim();
    if (!prepara[op]) return;
    prepara[op].comps.push({
      item:String(campo(r,['item'])||'').trim(),
      cantidad:num(campo(r,['cantidad'])),
      unidad:String(campo(r,['unidad'])||'').trim()
    });
  });

  for (var op in prepara) {
    var p = prepara[op];
    if (!p.comps.length) continue;
    if (firmaProduccion_(p.producto,tamborId,p.comps) !== firmaNueva) continue;
    var horas = redondear_((ahora - p.fecha)/3600000,1);
    throw new Error(
      'POSIBLE DUPLICADO: hace ' + horas + ' h ya se registró "' + p.producto + '" en el tanque ' +
      tamborId + ' con las mismas materias primas (' + op + '). ' +
      'Si de verdad preparaste otro lote igual, vuelve a guardar confirmando que NO es duplicado. ' +
      'Si no, no lo registres otra vez: el lote anterior ya está en el sistema.'
    );
  }
}

function expandirProduccion_(payload,responsable,operacionId) {
  var produccion=validarProduccionPost_(payload);
  var filas=[];
  // Si el operario dice que vació el tanque, el saldo viejo se descarta ANTES de la
  // preparación. Va como movimiento propio para que quede a la vista por qué se fue,
  // en vez de desaparecer sin rastro.
  if (produccion.residuoADescartar > 0) {
    filas.push({
      TipoRegistro:'Novedad/Corrección',Responsable:responsable,
      TamborID:produccion.tamborId,Producto:produccion.producto,
      Cantidad:redondear_(produccion.residuoADescartar,3),Unidad:'L',
      // CUIDADO con el texto del motivo: getInventario decide el signo buscando palabras
      // sueltas, y "sobrante" significa SUMAR. Un motivo como "merma - sobrante…" sumaba en
      // vez de restar. Este texto solo lleva "merma", que es lo que resta.
      Motivo:'Merma - saldo previo del tanque, no se suma aparte',
      ReferenciaOriginal:operacionId,
      Observacion:'El sistema traía '+redondear_(produccion.residuoADescartar,2)+' L en el tanque '+
                  produccion.tamborId+' y el operario confirmó que los litros registrados son el total del tanque.'
    });
  }
  filas.push(payload);
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
  var aprobadoPor=String(payload.AprobadoPor||payload.aprobadoPor||'').trim();
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
    ReferenciaOriginal:refReal,AprobadoPor:aprobadoPor,
    Observacion:motivo+(aprobadoPor?' · Aprobado por '+aprobadoPor:''),
    Origen:'Centro de correcciones'
  }];
  componentes.forEach(function(c,i) {
    filas.push({
      TipoRegistro:'Consumo materia prima',Responsable:responsable,Categoria:'Materia prima',
      Item:c.item,Variante:c.variante||'',Cantidad:c.cantidad,Unidad:c.unidad,
      Movimiento:'Consumo',Motivo:'Corrección de producción',Producto:producto,TamborID:tambor,
      ReferenciaOriginal:refReal,AprobadoPor:aprobadoPor,
      Observacion:'Componente faltante '+(i+1)+' · '+motivo+
        (aprobadoPor?' · Aprobado por '+aprobadoPor:''),
      Origen:'Centro de correcciones'
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
  var aprobadoPor=String(payload.AprobadoPor||payload.aprobadoPor||'').trim();
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
    AprobadoPor:aprobadoPor,
    Observacion:motivo+(aprobadoPor?' · Aprobado por '+aprobadoPor:''),
    Origen:'Centro de correcciones'
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
        ReferenciaOriginal:refReal,AprobadoPor:aprobadoPor,
        Observacion:motivo+(aprobadoPor?' · Aprobado por '+aprobadoPor:''),
        Origen:'Centro de correcciones'
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
