# Conteo total del viernes — cómo funciona y qué NO se puede hacer

## Lo primero, y es importante: **Siigo no recibe existencias por API**

Lo verifiqué contra la API real de Siigo con las credenciales de la empresa:

| Lo que se probó | Resultado |
|---|---|
| `GET /v1/products` | **200 OK** — 1.912 productos, con `code` (SKU), nombre, unidad y `available_quantity` |
| `POST/PUT` de existencias | **no existe** |
| `/v1/stock` | **404** |
| `/v1/inventory` | **404** |
| `/v1/inventory-adjustments` | **404** |
| `/v1/warehouses` | 200 pero vacío |

En Siigo las existencias **solo se mueven con documentos** (facturas de venta, facturas de
compra). La API expone facturas, compras, comprobantes y notas — pero **ningún documento de
ajuste de inventario**. Se podría inflar el stock creando facturas de compra falsas: **eso
no se hace**, son documentos contables y tributarios.

**Entonces el puente es:** la app cuenta y genera un archivo, y ese archivo se carga en
Siigo desde el computador (Siigo tiene importación de ajuste de inventario en su pantalla).
Es un paso manual, pero es el único camino honesto.

## Lo que sí quedó listo

### Pestaña nueva: **"Conteo total"** (verde, arriba a la derecha)

- Trae los **1.245 productos activos de Siigo** con su SKU. Los inactivos (667) se
  descartaron solos.
- Se busca por **nombre o por código**: escribir "FUL362" o "alcohol" lleva al producto.
- Filtros: **Falta contar** (el que sale por defecto), Ya contados, Con problema, Todos.
- Arriba siempre se ve: *Contados X de 1.245 · N sin enviar · N con problema*.

### Pensado para que no se pierda nada un día de locos

1. **Lo que se escribe se guarda en el teléfono en el instante**, antes de intentar
   mandarlo. Si se cae el internet, si cierran la app o si se apaga el celular, el conteo
   sigue ahí.
2. **Se envía solo**, en lotes de 20, uno detrás de otro (el Apps Script atiende de a una
   petición). También hay un reintento automático cada minuto.
3. Si la app se cerró **en mitad de un envío**, al volver a abrirla esos conteos regresan
   solos a la cola. (Sin esto se quedaban colgados para siempre.)
4. Cada producto muestra su estado: *Anotado, falta enviarlo* → *Enviando…* → **Guardado ✓**.

### Si digitan mal (que va a pasar)

- **Letras o basura** ("ocho", "12kg", "-3"): la ficha se pone roja y dice *"Eso no es un
  número. Escribe solo cifras, por ejemplo 12 o 12,5"*. **No se envía** hasta que se
  arregle, y no bloquea a los demás productos.
- **Coma o punto**: `12,5` y `12.5` valen lo mismo. Los espacios sobrantes se ignoran.
- **Se equivocaron y ya se había guardado**: se escribe el número nuevo encima. Vuelve a la
  cola y al guardarse muestra **"Guardado ✓ — corregido: antes habías puesto 30"**. En la
  hoja quedan los dos conteos (nada se borra) y **manda el último**.
- **El servidor rechaza algo**: la ficha queda roja con el motivo exacto y el mensaje *"No
  los vuelvas a escribir, se reintentan solos"* — para que nadie cuente dos veces.
- **Se perdió la respuesta pero pudo haberse guardado**: NO se marca como error, se deja en
  cola y se reintenta. Como un conteo fija el saldo, repetirlo no hace daño.
- **Sin nombre de quien cuenta**: no envía y lo dice. El nombre queda guardado en el
  teléfono para no repetirlo.

### El detalle que casi rompe todo

Hay **7 productos en Siigo con el mismo nombre y distinto código** (`DOMICILIO`/`AA36`,
`RINDEX 2KG` `SUQ632`/`CAJ221`, dos `GUANTE ROJO T:8`…). Si el saldo se guardara por
nombre, **el conteo de uno le pisaría el del otro**. Por eso el SKU va como *Variante* y
cada código es su propia línea. Probado en real: los dos DOMICILIO quedaron separados.

## Cómo se probó (no es teoría)

- **Rechazo real:** se mandó a propósito un lote sin observación → el backend respondió
  *"El conteo requiere una observación"* y **no escribió nada** en el libro mayor.
- **Guardado real:** se mandó un lote válido con los dos DOMICILIO en 0 → quedó
  `OP-95BDA646-6C9`, 2 movimientos, **columna SKU creada sola**, y en el inventario
  aparecen como dos líneas separadas.
- **Simulado sin tocar la hoja:** 25 productos digitados (uno con coma, uno mal escrito) →
  se enviaron en lotes de **20 y 4**, el mal escrito se quedó fuera, la corrección se
  reenvió sola, y todo sobrevivió a recargar la página.

## Paso a paso del viernes

1. **Antes de empezar** (desde el computador), para traer el catálogo fresco de Siigo:
   ```bash
   node "automation/bajar_catalogo_siigo.js"
   ```
   Luego subir el `catalogo_siigo.json` a GitHub. Si no se hace, se usa el del 3-ago.
2. Cada persona abre la app, entra a **Conteo total** y escribe su nombre.
3. Cuenta y digita. **Puede haber varias personas contando al tiempo**, cada una en su
   teléfono; cada quien manda lo suyo.
4. Al final, botón **"Bajar el conteo (Excel/CSV)"** → archivo con SKU, producto, cantidad,
   unidad, nota, quién y cuándo.
5. Ese archivo se carga en Siigo desde el computador.

## Advertencias honestas

- **Los conteos entran con categoría "Producto Siigo"**, aparte de las materias primas y
  los productos que la app ya calcula por empaque. Se hizo así para no mezclar el conteo
  físico del viernes con los saldos que la app calcula sola. Si un producto aparece en las
  dos partes, son dos vistas distintas del mismo producto — hay que decidir después cuál
  manda.
- **Mandar 1.245 conteos toma unos minutos** (63 lotes). Corre en segundo plano mientras
  siguen contando; no hay que esperar mirando la pantalla.
- **157 productos no controlan existencias en Siigo** (servicios como domicilio). Salen
  marcados *"sin control de stock"*: se pueden contar, pero Siigo no les lleva saldo.
- El catálogo publicado en el repo **no lleva precios ni existencias** a propósito: el
  repositorio es público y para contar solo hace falta el SKU y el nombre.
