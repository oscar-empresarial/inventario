#!/usr/bin/env node
/**
 * PROBAR TODO — la app del laboratorio, de punta a punta, contra el sistema de verdad.
 *
 * POR QUE EXISTE. El 8-sep-2026 el ingeniero lleno un tanque y el registro no quedo. En la
 * hoja no habia fila y en _API_ERRORES tampoco: o sea, nadie podia siquiera saber POR QUE.
 * Oscar: *"esto no puede seguir sucediendo"*. Las pruebas de `npm test` miran el codigo en
 * frio; esto mira el SISTEMA: Google, el Worker, el espejo, la escritura de verdad y la
 * anulacion que la limpia.
 *
 * COMO SE USA
 *   node probar_todo.mjs              -> solo lectura (no escribe nada). Seguro siempre.
 *   node probar_todo.mjs --escribir   -> ademas guarda de verdad y luego se limpia solo.
 *   node probar_todo.mjs --escribir --sin-limpiar  -> deja lo escrito (para mirarlo a mano)
 *
 * QUE ESCRIBE cuando se le dice --escribir: SOLO tanques que empiezan por ZZ-PRUEBA y
 * productos que empiezan por "Prueba tecnica". El Apps Script los reconoce (esDePrueba_) y
 * los deja fuera de la lista de tanques y de la auditoria. Al final los anula. Las materias
 * primas son cantidades ridiculas (0,001 L) para que aunque algo quedara sin anular no
 * mueva ningun saldo real.
 *
 * SALE CON CODIGO 1 si algo falla, para poder colgarlo de un cron.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ESCRIBIR = process.argv.includes('--escribir');
const SIN_LIMPIAR = process.argv.includes('--sin-limpiar');
const LLAVE_DIAG = 'diag-2026';

// ================== LAS CONSTANTES SALEN DE LA APP, NO DE AQUI ==================
// A proposito: si alguien cambia la URL en index.html y no aqui, la prueba tiene que
// probar la URL NUEVA. Copiarlas seria probar un sistema que ya no existe.
const HTML = readFileSync(join(AQUI, 'index.html'), 'utf8');
const sacar = (re, nombre) => {
  const m = HTML.match(re);
  if (!m) { console.error('No se pudo leer ' + nombre + ' de index.html'); process.exit(1); }
  return m[1];
};
const APPS_SCRIPT_URL = sacar(/var APPS_SCRIPT_URL = '([^']+)'/, 'APPS_SCRIPT_URL');
const LAB_API = sacar(/var LAB_API = '([^']+)'/, 'LAB_API');
const LAB_LLAVE = sacar(/var LAB_LLAVE = '([^']+)'/, 'LAB_LLAVE');
const VERSION_MINIMA = sacar(/var BACKEND_VERSION_REQUERIDA = '([^']+)'/, 'BACKEND_VERSION_REQUERIDA');

// ================== EL MARCADOR ==================
const resultados = [];
let seccionActual = '';
const seccion = t => { seccionActual = t; console.log('\n\x1b[1m── ' + t + ' ──\x1b[0m'); };

async function probar(nombre, fn) {
  const t0 = Date.now();
  try {
    const detalle = await fn();
    const ms = Date.now() - t0;
    resultados.push({ seccion: seccionActual, nombre, ok: true, ms });
    console.log('  \x1b[32mOK\x1b[0m  ' + nombre + (detalle ? '  \x1b[2m' + detalle + '\x1b[0m' : '') + ' \x1b[2m(' + ms + ' ms)\x1b[0m');
  } catch (e) {
    const ms = Date.now() - t0;
    resultados.push({ seccion: seccionActual, nombre, ok: false, ms, error: String(e && e.message || e) });
    console.log('  \x1b[31mFALLA\x1b[0m ' + nombre);
    console.log('        \x1b[31m' + String(e && e.message || e).split('\n').join('\n        ') + '\x1b[0m');
  }
}
const exigir = (cond, mensaje) => { if (!cond) throw new Error(mensaje); };

// ================== HABLAR CON LOS DOS SERVIDORES ==================
const nuevaClave = p => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// CON REINTENTOS, IGUAL QUE LA APP. Apps Script contesta paginas HTML de error 404 al azar
// (medido el 2-sep: 2 de cada 8 llamadas) y tarda de 3 a 39 s. Sin reintentar, esta prueba
// daria falsas alarmas todo el tiempo y en dos dias nadie le creeria — que es peor que no
// tenerla. El jsonp() de la app reintenta dos veces; aqui igual, y al final se dice cuantas
// veces hubo que hacerlo, porque eso mismo es un dato de salud.
let reintentosGoogle = 0;
async function google(params, { timeout = 120000, intentos = 3 } = {}) {
  const url = new URL(APPS_SCRIPT_URL);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  let ultimo = null;
  for (let i = 0; i < intentos; i++) {
    if (i) { reintentosGoogle++; await new Promise(r => setTimeout(r, 1500 * i)); }
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      const txt = await r.text();
      if (!r.ok) { ultimo = new Error('Google contesto HTTP ' + r.status + ' (pagina de error, no JSON)'); continue; }
      try { return JSON.parse(txt); }
      catch { ultimo = new Error('Google contesto algo que no es JSON (' + r.status + '): ' + txt.slice(0, 120)); }
    } catch (e) { ultimo = e; }
  }
  throw new Error('Google fallo ' + intentos + ' veces seguidas. Ultimo: ' + (ultimo && ultimo.message || ultimo));
}

/**
 * El POST al Apps Script contesta con un 302 hacia googleusercontent, y ESE es el resultado.
 * Con redirect:'follow' el runtime lo sigue como GET y a veces vuelve a caer en /exec (o sea,
 * en doGet) y contesta cualquier cosa. Por eso se hace a mano.
 */
async function googlePost(payload, { timeout = 180000 } = {}) {
  const r = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  let txt;
  if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
    const r2 = await fetch(r.headers.get('location'), { signal: AbortSignal.timeout(timeout) });
    txt = await r2.text();
  } else {
    txt = await r.text();
  }
  let d;
  try { d = JSON.parse(txt); }
  catch { throw new Error('La respuesta del POST (HTTP ' + r.status + ') no es JSON: ' + txt.slice(0, 200)); }
  // Si vuelve el saludo de doGet, el POST se convirtio en GET por el camino y NO se ejecuto
  // doPost. Decirlo claro: si no, parece que el servidor acepto algo que nunca vio.
  if (d && d.mensaje === 'API Full Company activa') {
    throw new Error('el POST llego como GET (HTTP ' + r.status + '): doPost no se ejecuto');
  }
  return d;
}

async function worker(params, { timeout = 30000 } = {}) {
  const url = new URL(LAB_API);
  url.searchParams.set('llave', LAB_LLAVE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch { throw new Error('El Worker contesto algo que no es JSON (' + r.status + '): ' + txt.slice(0, 160)); }
}

const numeroDeVersion = v => {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
};

// ================== 1. LO QUE SE PUEDE MIRAR SIN RED ==================
async function seccionEstatica() {
  seccion('1. El codigo de la app (sin tocar la red)');

  await probar('el JavaScript de la pantalla no tiene errores de sintaxis', () => {
    // wrangler y GitHub Pages publican HTML roto sin quejarse: si esto revienta, la app
    // sale en blanco y el ingeniero no puede registrar NADA.
    const trozos = [...HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    exigir(trozos.length, 'no se encontro ningun <script> en index.html');
    // eslint-disable-next-line no-new-func
    new Function(trozos.join('\n'));
    return trozos.length + ' bloques';
  });

  await probar('las pruebas de `npm test` pasan todas', () => {
    // TODAS las de tests/, no una lista a mano: con la lista, un archivo de pruebas nuevo
    // (tests/preparar_tanque.test.js, 21-sep-2026) se quedaba por fuera sin que nadie lo notara.
    const archivos = readdirSync(join(AQUI, 'tests')).filter(f => f.endsWith('.test.js')).sort().map(f => 'tests/' + f);
    const salida = execFileSync(process.execPath, ['--test', ...archivos],
      { cwd: AQUI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const fallos = (salida.match(/^ℹ fail (\d+)/m) || [])[1];
    exigir(fallos === '0', 'hay ' + fallos + ' prueba(s) en rojo. Corre `npm test` para verlas.');
    return (salida.match(/^ℹ pass (\d+)/m) || [])[1] + ' pruebas';
  });

  await probar('cada campo de cantidad acepta la coma decimal', () => {
    // type="number" BORRA "165,5" en el navegador: el campo queda vacio, la app dice "pon
    // los litros" y no manda nada. Ni fila en la hoja, ni rastro en ningun lado.
    const malos = [...HTML.matchAll(/<input[^>]*type="number"[^>]*>/gi)].map(m => m[0]);
    exigir(malos.length === 0, 'quedan ' + malos.length + ' campo(s) con type="number":\n' + malos.join('\n'));
    return 'ninguno con type="number"';
  });

  await probar('la app REENVIA lo que no se confirmo (no solo pregunta)', () => {
    exigir(/for \(var envioN = 0; envioN < ENVIOS; envioN\+\+\)/.test(HTML),
      'enviarRegistro ya no reenvia: volvio a quedar en preguntar y rendirse');
    exigir(/el pendiente se vuelve a MANDAR|await fetch\(APPS_SCRIPT_URL[\s\S]{0,400}?JSON\.stringify\(payload\)/.test(HTML),
      'recuperarOperacionesPendientes ya no reenvia el payload guardado');
    return 'hasta 3 envios con la misma clave';
  });

  await probar('lo que quedo sin confirmar se VE en la pantalla', () => {
    exigir(/id="avisoPendientes"/.test(HTML), 'falta la franja #avisoPendientes');
    exigir(/function pintarPendientes/.test(HTML), 'falta pintarPendientes()');
    return 'franja + repintado';
  });

  await probar('el comprobante se pinta DESPUES del reset y no lo borra nadie', () => {
    // El '✔ Guardado y confirmado' se pintaba y, en el mismo tick, resetForm() y
    // selectType() llamaban a clearStatus() y lo borraban. Un guardado bueno y un "no paso
    // nada" se veian igual, y la propia pantalla decia que ese mensaje era la unica prueba.
    exigir(/id="comprobante"/.test(HTML), 'falta el recuadro #comprobante');
    exigir(/function mostrarComprobante/.test(HTML), 'falta mostrarComprobante()');
    const mReset = /resetForm\(false\);\s*selectType\(keepType\);/.exec(HTML);
    const iReset = mReset ? mReset.index : -1;
    const iComp = HTML.indexOf("mostrarComprobante(textoOk, 'ok')");
    exigir(iReset > 0 && iComp > iReset,
      'el comprobante se pinta ANTES del reset: clearStatus() lo va a borrar otra vez');
    return 'se pinta al final';
  });

  await probar('la app recuerda quien esta trabajando', () => {
    // De los 5 frenos reales del primer dia del registro, LOS 5 fueron "Selecciona
    // responsable" con el formulario ya lleno.
    exigir(/RESPONSABLE_KEY/.test(HTML), 'ya no se guarda el ultimo responsable');
    exigir(/function recordarResponsable/.test(HTML), 'falta recordarResponsable()');
    return 'se guarda y se repone';
  });

  await probar('el puente a Siigo aplica la fila COMPLETA o no aplica nada', () => {
    // Una fila da varias lineas (envase, tapa, producto terminado) y todas comparten la
    // misma ref. Si una se apartaba y las otras se escribian, la fila quedaba marcada como
    // hecha y la linea que falto NO se reintentaba jamas: se gastaba el envase y el
    // producto terminado nunca entraba.
    const src = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'fabrica_sync.js'), 'utf8');
    exigir(/const faltan = lineas\.filter\(l => !conocidas\.has\(l\.clave\)\)/.test(src),
      'fabrica_sync volvio a aplicar las lineas una por una');
    exigir(/filasEnEspera\+\+/.test(src), 'ya no se cuenta cuantas filas quedaron esperando');
    return 'todo o nada';
  });

  await probar('el catalogo del conteo no se borra por lo que no llego', () => {
    const src = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'conteo.js'), 'utf8');
    exigir(!/DELETE FROM conteo_items WHERE origen IN \('siigo','app'\)/.test(src),
      'volvio el DELETE incondicional: si Siigo no contesta, se borra su catalogo entero');
    exigir(/reemplazar\.push\(origen\)/.test(src), 'ya no se reemplaza por origen');
    return 'solo el origen que llego, y con minimo del 70%';
  });

  await probar('un espejo atrasado no se contesta como si fuera bueno', () => {
    const src = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'lab_api.js'), 'utf8');
    exigir(/function exigirEspejoFresco/.test(src), 'falta el candado de frescura del espejo');
    exigir(/MINUTOS_ESPEJO_VIEJO/.test(src), 'falta el tope de minutos');
    return 'pasa a Google si lleva mas de 15 min';
  });

  // LAS ETIQUETAS VAN POR PRODUCTO (21-sep-2026, la tercera vez que Oscar lo pide). La
  // lista vive en TRES sitios —la app, el Apps Script y el Worker— y el arreglo del 16-sep
  // fallo justamente por arreglar uno solo. Si se separan, la app ofrece una lista y el
  // servidor le junta el saldo a otra.
  await probar('la lista de etiquetas es la MISMA en la app y en los DOS motores', () => {
    const fuentes = {
      'index.html': HTML,
      'Código.js': readFileSync(join(AQUI, '..', '..', '3-INVENTARIO', 'app-ingeniero', 'Código.js'), 'utf8'),
      'lab_motor.js': readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'lab_motor.js'), 'utf8'),
    };
    const sacarDe = (src, nombre, dueno) => {
      const m = src.match(new RegExp('(?:var|const) ' + nombre + ' = ([\\[{][\\s\\S]*?\\n\\s*[\\]}]);'));
      exigir(m, dueno + ' no tiene ' + nombre);
      return JSON.stringify(new Function('return ' + m[1])());
    };
    const malos = [];
    for (const nombre of ['ETIQUETAS_POR_PRODUCTO', 'ETIQUETA_ALIAS']) {
      const base = sacarDe(fuentes['lab_motor.js'], nombre, 'lab_motor.js');
      for (const dueno of ['index.html', 'Código.js']) {
        if (sacarDe(fuentes[dueno], nombre, dueno) !== base) malos.push(dueno + ': ' + nombre + ' distinta a la del Worker');
      }
    }
    exigir(!malos.length, malos.join(' · '));
    const n = JSON.parse(sacarDe(fuentes['lab_motor.js'], 'ETIQUETAS_POR_PRODUCTO', 'lab_motor.js')).length;
    return n + ' etiquetas, iguales en los tres';
  });

  await probar('la regla de la pimpina (19 L) esta en los DOS motores', () => {
    const apps = readFileSync(join(AQUI, '..', '..', '3-INVENTARIO', 'app-ingeniero', 'Código.js'), 'utf8');
    const motor = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'lab_motor.js'), 'utf8');
    exigir(/pimpina/i.test(apps), 'Código.js perdio la regla de la pimpina');
    exigir(/pimpina/i.test(motor), 'lab_motor.js perdio la regla de la pimpina');
    return 'Apps Script y Worker';
  });

  await probar('una fila SIN FECHA no cuenta como empaque posterior (los DOS motores)', () => {
    // 10-sep-2026: el candado de anular hacia `if (fechaOp && f && f < fechaOp) return;`.
    // Con la fila sin fecha, `f` es '' y ese `f &&` volvia la condicion FALSA: la fila NO se
    // saltaba y contaba como empaque POSTERIOR. Las primeras 80 filas de la hoja son de
    // cuando se llevaba a mano y no tienen fecha, asi que dejaban 12 tanques imposibles de
    // anular PARA SIEMPRE, con un aviso que ni decia cuales eran.
    const apps = readFileSync(join(AQUI, '..', '..', '3-INVENTARIO', 'app-ingeniero', 'Código.js'), 'utf8');
    const extra = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'lab_motor_extra.js'), 'utf8');
    const malos = [];
    for (const [nombre, src, arranque] of [
      ['Código.js', apps, 'function empaquesQueDependenDe_('],
      ['lab_motor_extra.js', extra, 'export function empaquesQueDependenDe('],
    ]) {
      // DENTRO de la funcion, no la primera fecha que aparezca en todo el archivo.
      const desde = src.indexOf(arranque);
      if (desde < 0) { malos.push(nombre + ': no se encontro empaquesQueDependenDe'); continue; }
      // SIN LOS COMENTARIOS: el comentario que explica este mismo bug CITA el codigo viejo,
      // y sin quitarlo la prueba se acusa a si misma de haberlo devuelto.
      const cuerpo = src.slice(desde, desde + 3500)
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      if (!/if \(!f\) return;/.test(cuerpo)) malos.push(nombre + ': la fila sin fecha vuelve a contar como posterior');
      if (/if \(fechaOp && f && f < fechaOp\)/.test(cuerpo)) malos.push(nombre + ': volvio el `f &&` que causaba el bloqueo');
    }
    exigir(!malos.length, malos.join(' · '));
    return 'Apps Script y Worker';
  });

  await probar('la regla de unidad esta en los DOS motores', () => {
    const apps = readFileSync(join(AQUI, '..', '..', '3-INVENTARIO', 'app-ingeniero', 'Código.js'), 'utf8');
    const motor = readFileSync(join(AQUI, '..', '..', '_cloudflare', 'full', 'src', 'lab_motor.js'), 'utf8');
    exigir(/reglasUnidad_/.test(apps), 'Código.js no tiene reglasUnidad_');
    exigir(/reglasUnidad/.test(motor), 'lab_motor.js no tiene reglasUnidad');
    return 'Apps Script y Worker';
  });
}

// ================== 2. LOS DOS SERVIDORES ESTAN VIVOS ==================
let versionBackend = '';
async function seccionServidores() {
  seccion('2. Los servidores');

  await probar('el Apps Script contesta', async () => {
    const d = await google({ action: 'ping' });
    exigir(d.ok === true, 'ping no contesto ok:true → ' + JSON.stringify(d).slice(0, 160));
    versionBackend = d.version;
    return 'version ' + d.version;
  });

  await probar('la version publicada es >= la que exige la app', () => {
    exigir(numeroDeVersion(versionBackend) >= numeroDeVersion(VERSION_MINIMA),
      'publicado ' + versionBackend + ', la app exige por lo menos ' + VERSION_MINIMA +
      '. Falta `clasp deploy -i <ID>` o la app quedo pidiendo una version que no existe.');
    return versionBackend + ' >= ' + VERSION_MINIMA;
  });

  await probar('el Worker contesta y dice de que fuente sale', async () => {
    const d = await worker({ action: 'ping' });
    exigir(d.ok === true, 'el Worker no contesto ok:true → ' + JSON.stringify(d).slice(0, 200));
    exigir(d.fuente === 'worker', 'la respuesta no viene marcada como del Worker');
    return 'espejo hasta la fila ' + (d.espejo && d.espejo.hasta);
  });

  await probar('el espejo esta al dia (menos de 20 minutos)', async () => {
    const d = await worker({ action: 'ping' });
    const cuando = d.espejo && (d.espejo.ultimoOk || d.espejo.catalogosEn);
    exigir(cuando, 'el espejo no dice cuando se refresco por ultima vez');
    const minutos = (Date.now() - new Date(cuando).getTime()) / 60000;
    exigir(minutos < 20, 'el espejo lleva ' + minutos.toFixed(1) + ' min sin refrescarse. ' +
      'Revisa la regla espejo_laboratorio_vivo en /salud.');
    exigir(!d.espejo.error, 'el espejo trae error: ' + d.espejo.error);
    return 'hace ' + minutos.toFixed(1) + ' min';
  });

  await probar('la hoja tiene filas libres para seguir escribiendo', async () => {
    const d = await google({ action: 'diag', llave: LLAVE_DIAG });
    exigir(d.ok === true, 'la accion diag no contesto (version publicada vieja?): ' + JSON.stringify(d).slice(0, 160));
    const reg = (d.hojas || []).find(h => h.nombre === 'REGISTRO_APP');
    exigir(reg, 'no aparece la pestaña REGISTRO_APP');
    exigir(d.celdasTotales < d.limiteCeldas * 0.9,
      'el libro va en ' + d.celdasTotales + ' celdas de ' + d.limiteCeldas + ': se acerca al tope de Google');
    return reg.ultimaFila + ' filas · ' + d.celdasTotales.toLocaleString('es') + ' celdas usadas';
  });
}

// ================== 3. LAS DOS CUENTAS DAN LO MISMO ==================
async function seccionIgualdad() {
  seccion('3. El Worker y Google cuentan lo mismo');

  let invW, invG;
  await probar('el inventario del Worker y el de Google coinciden', async () => {
    [invW, invG] = await Promise.all([worker({ action: 'inventario' }), google({ action: 'inventario' })]);
    exigir(invW.items && invG.items, 'alguno de los dos no trajo items');
    exigir(invW.items.length === invG.items.length,
      'items: Worker ' + invW.items.length + ' vs Google ' + invG.items.length);

    const clave = i => String(i.Item || '').trim().toLowerCase() + '|' + String(i.Variante || '').trim().toLowerCase();
    const mapaG = new Map(invG.items.map(i => [clave(i), i]));
    const dif = [];
    for (const i of invW.items) {
      const g = mapaG.get(clave(i));
      if (!g) { dif.push(i.Item + ': no esta en Google'); continue; }
      if (Math.abs((Number(i.Stock) || 0) - (Number(g.Stock) || 0)) > 0.001) {
        dif.push(i.Item + ': Worker ' + i.Stock + ' vs Google ' + g.Stock);
      }
    }
    exigir(dif.length === 0, dif.length + ' diferencia(s):\n  ' + dif.slice(0, 10).join('\n  '));
    return invW.items.length + ' items iguales';
  });

  await probar('los tanques del Worker y los de Google coinciden', async () => {
    exigir(invW && invG, 'la prueba anterior no dejo los inventarios');
    const tW = invW.tambores || [], tG = invG.tambores || [];
    exigir(tW.length === tG.length, 'tanques: Worker ' + tW.length + ' vs Google ' + tG.length);
    const mapaG = new Map(tG.map(t => [String(t.id).toLowerCase(), t]));
    const dif = [];
    for (const t of tW) {
      const g = mapaG.get(String(t.id).toLowerCase());
      if (!g) { dif.push('tanque ' + t.id + ': no esta en Google'); continue; }
      if (Math.abs((Number(t.disponible) || 0) - (Number(g.disponible) || 0)) > 0.001) {
        dif.push('tanque ' + t.id + ': Worker ' + t.disponible + ' L vs Google ' + g.disponible + ' L');
      }
      if (String(t.producto || '') !== String(g.producto || '')) {
        dif.push('tanque ' + t.id + ': producto "' + t.producto + '" vs "' + g.producto + '"');
      }
    }
    exigir(dif.length === 0, dif.length + ' diferencia(s):\n  ' + dif.join('\n  '));
    return tW.length + ' tanques iguales';
  });

  await probar('ningun tanque queda imposible de anular por filas viejas', async () => {
    // Se le pregunta al motor DE VERDAD (action=anulable) por la ultima preparacion de cada
    // tanque: si algun "empaque posterior" viene SIN FECHA, es una fila vieja de la hoja
    // haciendo de fantasma y ese tanque no se podria anular nunca.
    const d = await worker({ action: 'registros', limite: 99999 }, { timeout: 60000 });
    const filas = d.registros || [];
    const ultima = new Map();
    for (const r of filas) {
      if (!/^preparar tambor/i.test(String(r.TipoRegistro || ''))) continue;
      const t = String(r.TamborID || '').trim();
      const op = String(r.OperacionID || '').trim();
      if (t && op) ultima.set(t, op);
    }
    const fantasmas = [];
    // No se preguntan los 38: con una muestra amplia basta y la prueba no se vuelve eterna.
    const aMirar = [...ultima.entries()].slice(-14);
    for (const [tanque, op] of aMirar) {
      const a = await worker({ action: 'anulable', op }, { timeout: 60000 });
      const sinFecha = ((a && a.dependen) || []).filter((x) => !x.fecha);
      if (sinFecha.length) fantasmas.push('tanque ' + tanque + ' (' + op + '): ' + sinFecha.length);
    }
    exigir(!fantasmas.length, 'bloqueados por filas sin fecha: ' + fantasmas.join(' · '));
    return aMirar.length + ' tanques mirados, ninguno con fantasmas';
  });

  await probar('las listas de la pantalla (init) traen lo mismo', async () => {
    const [w, g] = await Promise.all([worker({ action: 'init' }), google({ action: 'init' })]);
    const cuenta = d => ['materiasPrimas', 'productos', 'presentaciones', 'accesorios', 'etiquetas', 'envases']
      .map(k => k + '=' + ((d[k] || (d.catalogos || {})[k] || []).length)).join(' ');
    const cw = cuenta(w), cg = cuenta(g);
    exigir(cw === cg, 'Worker [' + cw + '] vs Google [' + cg + ']');
    return cw;
  });

  // LO QUE DE VERDAD VE CARLOS EN LA CASILLA DE LA ETIQUETA (21-sep-2026). Oscar: *"las
  // etiquetas van por PRODUCTO, no por tamaño... Tampoco hay etiquetas de recarga"*. Se le
  // pregunta a los DOS servidores, con los datos de hoy: ningun tamaño, ninguna recarga,
  // ningun nombre viejo, nada repetido, y el saldo de los rollos viejos ya junto.
  await probar('las etiquetas que ofrecen los DOS servidores: una por producto', async () => {
    const [w, g] = await Promise.all([worker({ action: 'init' }), google({ action: 'init' })]);
    const ew = w.etiquetas || [], eg = g.etiquetas || [];
    exigir(ew.length, 'el Worker no mando etiquetas');
    exigir(JSON.stringify(ew) === JSON.stringify(eg), 'Worker y Google ofrecen listas distintas:\n  W: ' +
      ew.join(' | ') + '\n  G: ' + eg.join(' | '));
    const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    const m = HTML.match(/var ETIQUETA_ALIAS = (\{[\s\S]*?\n\s*\});/);
    exigir(m, 'index.html no tiene ETIQUETA_ALIAS');
    const alias = new Function('return ' + m[1])();
    const TAMANO = /\d\s*(cc|ml|l|lt|lts|litros?|g|gr|kg|lb)\b|\bgalon\b|\bpimpina\b|\blitro\b|\s\d{3,5}$/;
    const problemas = [];
    ew.forEach(n => {
      const k = norm(n);
      if (TAMANO.test(k)) problemas.push('"' + n + '" dice un tamaño');
      if (/recarga/.test(k)) problemas.push('"' + n + '" es de recarga');
      if (alias[k] || /^etiqueta\b/.test(k)) problemas.push('"' + n + '" es un nombre viejo');
      if (/ropa color/.test(k)) problemas.push('"' + n + '" ya se llama Oxycolor');
    });
    if (new Set(ew.map(norm)).size !== ew.length) problemas.push('hay etiquetas repetidas');
    ['Oxycolor normal', 'Oxycolor troquelado', 'Deterfull'].forEach(n => { if (ew.indexOf(n) < 0) problemas.push('falta "' + n + '"'); });
    // El saldo: ningun rollo del inventario puede seguir llamandose con el nombre viejo.
    (w.items || []).filter(i => norm(i.Categoria) === 'etiqueta').forEach(i => {
      if (alias[norm(i.Variante)]) problemas.push('el rollo "' + i.Variante + '" sigue aparte en el inventario');
    });
    exigir(!problemas.length, problemas.join('\n  '));
    return ew.length + ' etiquetas, iguales en los dos, ninguna por tamaño ni de recarga';
  });
}

// ================== 4. GUARDAR DE VERDAD ==================
const escritas = [];   // operaciones que hay que anular al final

async function confirmar(requestId, vueltas = 25) {
  for (let i = 0; i < vueltas; i++) {
    const d = await google({ action: 'operacion', requestId });
    if (d && d.encontrada) return d;
    await new Promise(r => setTimeout(r, 2000));
  }
  return { encontrada: false };
}

async function seccionEscritura() {
  seccion('4. Guardar de verdad (tanques ZZ-PRUEBA)');
  // Un tanque DISTINTO en cada corrida: si se reusara, el guardarrail anti-duplicado de
  // las ultimas 24 h frenaria la prueba y estariamos midiendo el guardarrail, no el guardado.
  const TANQUE = 'ZZ-PRUEBA-' + Date.now().toString(36).toUpperCase();
  const base = () => ({
    FechaCliente: new Date().toISOString(), Responsable: 'Prueba automatica',
    Origen: 'probar_todo.mjs', NuevoItem: 'No', PendienteAprobacion: 'No',
  });

  let clavePrep = nuevaClave('probar-prep');
  let opPrep = '';

  await probar('llenar un tanque queda guardado y se puede confirmar', async () => {
    const r = await googlePost({
      ...base(), RequestId: clavePrep, TipoRegistro: 'Preparar tambor',
      TamborID: TANQUE, Producto: 'Prueba tecnica llenado', Tanque: 'Balde',
      LitrosPreparados: '0,002',   // CON COMA a proposito: es como teclea el ingeniero
      FormulaCompleta: true,
      Observacion: 'prueba automatica, se anula al terminar',
      Componentes: [
        { Item: 'Agua', Cantidad: '0,001', Unidad: 'L' },
        { Item: 'Glicerina', Cantidad: '0.001', Unidad: 'L' },
      ],
    });
    exigir(r.ok === true, 'el servidor rechazo el llenado: ' + (r.error || JSON.stringify(r).slice(0, 200)));
    const est = await confirmar(clavePrep);
    exigir(est.encontrada && est.ok, 'se guardo pero no se pudo confirmar por RequestId');
    exigir(est.movimientos === 3, 'esperaba 3 renglones (produccion + 2 materias primas), llegaron ' + est.movimientos);
    opPrep = est.operacionId;
    escritas.push(opPrep);
    return opPrep + ' · ' + est.movimientos + ' renglones';
  });

  await probar('la coma decimal NO se convierte en cero', async () => {
    exigir(opPrep, 'no hay operacion que mirar');
    const d = await google({ action: 'registros', limite: 40 });
    const fila = (d.registros || []).find(r => String(r.OperacionID || '') === opPrep &&
      /preparar tambor/i.test(String(r.TipoRegistro || '')));
    exigir(fila, 'no aparece la fila de la preparacion en los ultimos registros');
    const litros = Number(String(fila.LitrosPreparados).replace(',', '.'));
    exigir(Math.abs(litros - 0.002) < 1e-9,
      'se mando "0,002" y la hoja guardo ' + JSON.stringify(fila.LitrosPreparados) +
      '. La coma esta valiendo cero o se volvio fecha.');
    return 'la hoja guardo ' + fila.LitrosPreparados;
  });

  await probar('reenviar la MISMA clave no duplica (idempotencia)', async () => {
    const r = await googlePost({
      ...base(), RequestId: clavePrep, TipoRegistro: 'Preparar tambor',
      TamborID: TANQUE, Producto: 'Prueba tecnica llenado', Tanque: 'Balde',
      LitrosPreparados: '0,002', FormulaCompleta: true,
      Observacion: 'prueba automatica, se anula al terminar',
      Componentes: [
        { Item: 'Agua', Cantidad: '0,001', Unidad: 'L' },
        { Item: 'Glicerina', Cantidad: '0.001', Unidad: 'L' },
      ],
    });
    exigir(r.duplicado === true, 'el reenvio NO se reconocio como duplicado: ' + JSON.stringify(r).slice(0, 200));
    const est = await confirmar(clavePrep, 3);
    exigir(est.movimientos === 3, 'despues del reenvio hay ' + est.movimientos + ' renglones: SE DUPLICO');
    return 'sigue en 3 renglones';
  });

  await probar('un rechazo SIEMPRE deja rastro consultable', async () => {
    const clave = nuevaClave('probar-malo');
    const r = await googlePost({
      ...base(), RequestId: clave, TipoRegistro: 'Preparar tambor',
      TamborID: TANQUE, Producto: 'Prueba tecnica rechazo',
      LitrosPreparados: 5, FormulaCompleta: true,
      Componentes: [{ Item: 'Agua', Cantidad: 1, Unidad: 'L' }],   // una sola: se rechaza
    });
    exigir(r.ok === false, 'esperaba un rechazo y contesto ok:true');
    const est = await confirmar(clave, 3);
    exigir(est.encontrada === true && est.ok === false,
      'el rechazo NO quedo anotado: la app no puede decirle al ingeniero por que no se guardo');
    return String(est.error || '').slice(0, 70);
  });

  await probar('el SKU con ceros a la izquierda se guarda como texto', async () => {
    const d = await google({ action: 'errores', llave: LLAVE_DIAG, limite: 5 });
    exigir(d.ok === true, 'no se pudo leer _API_ERRORES (version publicada vieja?)');
    // La comprobacion de verdad: buscar en los registros un SKU que empiece por 0 y que no
    // se haya vuelto numero. Si no hay ninguno hoy, la prueba no aplica.
    const reg = await google({ action: 'registros', limite: 200 });
    const conCero = (reg.registros || []).filter(r => /^0\d/.test(String(r.SKU || '')));
    if (!conCero.length) return 'no hubo SKU con cero a la izquierda en las ultimas 200 filas';
    return conCero.length + ' SKU con cero intactos (ej. ' + conCero[0].SKU + ')';
  });

  await probar('anular y volver a hacer el MISMO lote no se toma como duplicado', async () => {
    // Es para lo que existe el boton de anular ("anular y volver a hacerlo", Oscar 1-sep).
    // Si el lote anulado sigue contando como preparacion reciente, el guardarrail bloquea
    // el rehacer y el ingeniero se queda sin poder registrar lo que SI hizo.
    exigir(opPrep, 'no hay preparacion previa que anular');
    const rAnula = await googlePost({
      RequestId: nuevaClave('probar-anular-rehacer'), FechaCliente: new Date().toISOString(),
      TipoRegistro: 'Anulación operación', Responsable: 'Prueba automatica',
      ReferenciaOriginal: opPrep, AprobadoPor: 'Prueba automatica',
      Motivo: 'Prueba: anular para volver a hacer el mismo lote',
    });
    exigir(rAnula.ok === true, 'no se pudo anular: ' + (rAnula.error || ''));
    escritas.length = 0;   // ya quedo anulada; no hay que volver a anularla al final

    const clave2 = nuevaClave('probar-rehacer');
    const r = await googlePost({
      ...base(), RequestId: clave2, TipoRegistro: 'Preparar tambor',
      TamborID: TANQUE, Producto: 'Prueba tecnica llenado', Tanque: 'Balde',
      LitrosPreparados: '0,002', FormulaCompleta: true,
      Observacion: 'prueba automatica: rehacer despues de anular',
      Componentes: [
        { Item: 'Agua', Cantidad: '0,001', Unidad: 'L' },
        { Item: 'Glicerina', Cantidad: '0.001', Unidad: 'L' },
      ],
    });
    exigir(r.ok === true, 'el rehacer se rechazo: ' + (r.error || JSON.stringify(r).slice(0, 220)));
    const est = await confirmar(clave2);
    exigir(est.encontrada && est.ok, 'el rehacer no se pudo confirmar');
    opPrep = est.operacionId;
    escritas.push(opPrep);
    return 'rehecho como ' + opPrep;
  });

  await probar('el espejo trae la fila nueva al pedirselo', async () => {
    const r = await worker({ action: 'refrescar' }, { timeout: 60000 });
    exigir(r.ok === true, 'refrescar fallo: ' + (r.error || JSON.stringify(r).slice(0, 160)));
    const d = await worker({ action: 'registros', limite: 40 });
    const hay = (d.registros || []).some(x => String(x.OperacionID || '') === opPrep);
    exigir(hay, 'la fila recien escrita no llego al espejo');
    return 'la fila esta en D1';
  });
}

// ================== 5. LIMPIAR LO QUE SE ESCRIBIO ==================
async function seccionLimpieza() {
  seccion('5. Anular lo que escribio la prueba');
  if (!escritas.length) { console.log('  \x1b[2mno hay nada que anular\x1b[0m'); return; }
  for (const op of escritas) {
    await probar('anular ' + op, async () => {
      const previa = await google({ action: 'anulable', op });
      exigir(previa.ok === true, 'no se pudo revisar: ' + (previa.error || ''));
      exigir(previa.sePuede === true, 'el servidor no deja anularla: ' + (previa.bloqueos || []).join(' '));
      const r = await googlePost({
        RequestId: nuevaClave('probar-anular'), FechaCliente: new Date().toISOString(),
        TipoRegistro: 'Anulación operación', Responsable: 'Prueba automatica',
        ReferenciaOriginal: op, AprobadoPor: 'Prueba automatica',
        Motivo: 'Limpieza de la prueba automatica probar_todo.mjs',
      });
      exigir(r.ok === true, 'la anulacion fallo: ' + (r.error || JSON.stringify(r).slice(0, 200)));
      return 'anulada';
    });
  }
  await worker({ action: 'refrescar' }, { timeout: 60000 }).catch(() => {});
}

// ================== 6. LOS RECHAZOS DE HOY ==================
async function seccionRechazos() {
  seccion('6. Que se le esta rechazando al ingeniero');
  await probar('se pueden leer los rechazos del dia', async () => {
    const d = await google({ action: 'errores', llave: LLAVE_DIAG, limite: 120 });
    exigir(d.ok === true, 'no se pudo leer _API_ERRORES: ' + (d.error || ''));
    const hoy = new Date();
    const esDeHoy = f => {
      const m = String(f || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m && Number(m[1]) === hoy.getDate() && Number(m[2]) === hoy.getMonth() + 1 && Number(m[3]) === hoy.getFullYear();
    };
    const deHoy = (d.errores || []).filter(e => esDeHoy(e.FechaServidor) && !/prueba/i.test(String(e.Responsable || '')));
    if (deHoy.length) {
      console.log('\n  \x1b[33mHOY se le rechazaron ' + deHoy.length + ' movimiento(s) a la planta:\x1b[0m');
      for (const e of deHoy.slice(-12)) {
        console.log('    ' + e.FechaServidor + '  ' + (e.Responsable || '?') + '  ' + (e.TipoRegistro || '?'));
        console.log('      \x1b[2m' + String(e.Error || '').slice(0, 150) + '\x1b[0m');
      }
    }
    return deHoy.length + ' rechazos hoy · ' + d.total + ' en total';
  });

  await probar('la app deja escrito lo que ella misma freno', async () => {
    // El agujero del 8-sep: la pantalla frenaba el registro y ese letrero solo existia en el
    // celular del ingeniero. Ahora cada freno va al Worker (tabla lab_rechazos).
    exigir(/function reportarFreno/.test(HTML), 'la app dejo de reportar los frenos');
    exigir(/reportarFreno\(res\.error/.test(HTML), 'el freno de la validacion ya no se reporta');
    const d = await worker({ action: 'rechazos', limite: 50, dias: 1 });
    exigir(d.ok === true, 'el Worker no sabe contestar action=rechazos: ' + (d.error || ''));
    const reales = (d.rechazos || []).filter(r => !/^prueba/i.test(String(r.responsable || '')));
    if (reales.length) {
      console.log('\n  \x1b[33mLa app freno ' + reales.length + ' registro(s) en las ultimas 24 h:\x1b[0m');
      for (const r of reales.slice(0, 12)) {
        console.log('    ' + r.cuando.slice(0, 16).replace('T', ' ') + '  ' + (r.responsable || '?') + '  ' + (r.tipo || '?'));
        console.log('      \x1b[2m' + String(r.motivo).slice(0, 150) + '\x1b[0m');
      }
    }
    return reales.length + ' frenos reales en 24 h';
  });
}

// ================== CORRER ==================
const t0 = Date.now();
console.log('\x1b[1mPROBAR TODO — app del laboratorio\x1b[0m');
console.log('  Apps Script: ' + APPS_SCRIPT_URL.slice(0, 62) + '…');
console.log('  Worker:      ' + LAB_API);
console.log('  Modo:        ' + (ESCRIBIR ? 'ESCRIBE de verdad (y se limpia solo)' : 'solo lectura'));

await seccionEstatica();
await seccionServidores();
await seccionIgualdad();
if (ESCRIBIR) {
  await seccionEscritura();
  if (!SIN_LIMPIAR) await seccionLimpieza();
  else console.log('\n  \x1b[33m--sin-limpiar: quedan sin anular ' + escritas.join(', ') + '\x1b[0m');
}
await seccionRechazos();

const fallas = resultados.filter(r => !r.ok);
console.log('\n' + '─'.repeat(70));
console.log('\x1b[1m' + (resultados.length - fallas.length) + ' de ' + resultados.length + ' pruebas bien\x1b[0m' +
  '  \x1b[2m(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)\x1b[0m' +
  (reintentosGoogle ? '  \x1b[33m· Google fallo y hubo que reintentar ' + reintentosGoogle + ' vez(ces)\x1b[0m' : ''));
if (fallas.length) {
  console.log('\n\x1b[31m\x1b[1mLO QUE ESTA MAL:\x1b[0m');
  for (const f of fallas) console.log('  · [' + f.seccion.split('.')[0] + '] ' + f.nombre + '\n    ' + f.error.split('\n')[0]);
  if (!ESCRIBIR) console.log('\n\x1b[2mOjo: sin --escribir no se probo el guardado de verdad.\x1b[0m');
  process.exit(1);
}
if (!ESCRIBIR) console.log('\x1b[2mOjo: sin --escribir no se probo el guardado de verdad. Corre `node probar_todo.mjs --escribir` una vez al dia.\x1b[0m');
console.log('\x1b[32mTodo bien.\x1b[0m');
