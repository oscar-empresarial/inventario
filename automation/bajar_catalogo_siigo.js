/**
 * Baja el catálogo de productos de Siigo y lo deja en catalogo_siigo.json, que es lo que
 * lee la pantalla "Primer inventario" de la app.
 *
 * Por qué existe: la app corre en GitHub Pages y no puede llamar a Siigo (las credenciales
 * no pueden vivir en un repo público, y Siigo no permite CORS desde el navegador). Así que
 * el catálogo se baja desde el PC y se publica como un archivo estático.
 *
 * SE GUARDA A PROPÓSITO SIN PRECIOS NI EXISTENCIAS: el repo es público y para contar solo
 * hace falta el SKU y el nombre. Las existencias de Siigo se comparan aparte, en el PC,
 * con comparar_con_siigo.js.
 *
 * Uso:  node automation/bajar_catalogo_siigo.js
 */
const fs = require('fs');
const path = require('path');

const ENV = path.join('C:', 'Users', 'USUARIO', 'Desktop', 'Sistema Automatizado - Claude',
  '1-FINANZAS', 'full-company-control', '.env');

for (const linea of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const m = linea.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const BASE = process.env.SIIGO_API_BASE;
const PARTNER_ID = process.env.SIIGO_PARTNER_ID;

async function autenticar() {
  const r = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Partner-Id': PARTNER_ID },
    body: JSON.stringify({ username: process.env.SIIGO_USERNAME, access_key: process.env.SIIGO_ACCESS_KEY }),
  });
  if (!r.ok) throw new Error('Siigo no autenticó (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

async function bajarTodo(token) {
  const H = { Authorization: `Bearer ${token}`, 'Partner-Id': PARTNER_ID };
  const productos = [];
  let pagina = 1;
  for (;;) {
    const r = await fetch(`${BASE}/v1/products?page=${pagina}&page_size=100`, { headers: H });
    if (!r.ok) throw new Error('Página ' + pagina + ' falló (' + r.status + ')');
    const d = await r.json();
    const lote = d.results || [];
    productos.push(...lote);
    const total = (d.pagination && d.pagination.total_results) || productos.length;
    process.stdout.write(`\r  ${productos.length} de ${total} productos...`);
    if (productos.length >= total || !lote.length) break;
    pagina++;
  }
  process.stdout.write('\n');
  return productos;
}

(async () => {
  console.log('Autenticando con Siigo...');
  const token = await autenticar();
  console.log('Bajando productos...');
  const crudos = await bajarTodo(token);

  const activos = crudos.filter(p => p.active !== false);
  const salida = {
    generado: new Date().toISOString(),
    total: activos.length,
    // Solo lo necesario para contar. Nada de precios ni existencias: el repo es público.
    productos: activos.map(p => ({
      sku: String(p.code || '').trim(),
      nombre: String(p.name || '').trim(),
      unidad: (p.unit && p.unit_label) || (p.unit && p.unit.name) || 'unidad',
      grupo: (p.account_group && p.account_group.name) || '',
      controlaStock: p.stock_control !== false,
    })).filter(p => p.sku && p.nombre)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  };

  const destino = path.join(__dirname, '..', 'catalogo_siigo.json');
  fs.writeFileSync(destino, JSON.stringify(salida, null, 0), 'utf8');

  const sinControl = salida.productos.filter(p => !p.controlaStock).length;
  const skusRepetidos = {};
  salida.productos.forEach(p => { skusRepetidos[p.sku] = (skusRepetidos[p.sku] || 0) + 1; });
  const repetidos = Object.entries(skusRepetidos).filter(([, n]) => n > 1);

  console.log('\nListo: ' + salida.productos.length + ' productos en ' + destino);
  console.log('  inactivos descartados : ' + (crudos.length - activos.length));
  console.log('  sin control de stock  : ' + sinControl);
  console.log('  SKU repetidos         : ' + repetidos.length + (repetidos.length ? ' -> ' + repetidos.slice(0, 8).map(r => r[0]).join(', ') : ''));
})().catch(e => { console.error('FALLÓ:', e.message); process.exit(1); });
