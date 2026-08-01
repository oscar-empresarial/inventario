# Por qué el inventario queda en negativo — diagnóstico

Hecho 2026-07-31 leyendo el código y **los datos reales de la app en vivo**
(`?action=inventario` y `?action=registros`: 199 ítems, 629 movimientos).

**Resumen en una línea:** hay **dos cosas distintas** pasando, y el ingeniero está
describiendo una sola. Una es un bug del código. La otra es cómo se está usando el conteo.

---

## Foto actual: 41 ítems en negativo

| Categoría | Cuántos en negativo |
|---|---|
| Envases | 13 |
| Etiquetas | 21 |
| Accesorios (tapas, pull push, gatillos) | 3 |
| Otros envases/varios | 3 |
| **Materia prima** | **1** (Carbopol, −1,89 kg) |

Los peores: `Tapa normal` **−349**, `Galon transparente 4 L` **−161**,
`Envase transparente 500 ml` **−88**, `Pull push` **−74**.

**El dato que lo explica todo:** en 629 movimientos hay **120 empaques**, pero solo
**4 entradas de envase, 4 de accesorio y CERO entradas de etiqueta**.

---

## Problema 1 — BUG DEL CÓDIGO: el empaque no valida envase, tapa ni etiqueta

En `apps-script/Codigo.gs`:

- `validarEmpaquePost_()` (línea ~1293) valida **solo los litros del tanque**. Nada más.
- `descontarEmpaque()` (línea ~764) descuenta envase, etiqueta y accesorio **a ciegas**:

```js
mover(pres, '', 'Envase', -nPres, 'und');       // sin validar que exista
mover('Etiqueta', etiq, 'Etiqueta', -nPres, 'und');
mover(acc, '', 'Accesorio', -nPres, 'und');
```

Compáralo con la materia prima, que **sí** se valida (`validarStockComponentes_` →
`validarStockItem_`, que lanza *"Inventario insuficiente"*).

**Conclusión:** para materia prima la app bloquea; para envases/tapas/etiquetas **no
bloquea nada**. Por eso 40 de los 41 negativos son de esas tres categorías. Esto **sí es
error de la plataforma**, tal como sospechaba Oscar.

### ⚠️ Ojo antes de "arreglarlo"

Si simplemente se agrega la validación, **la app deja de dejar empacar mañana mismo**,
porque las etiquetas nunca se han registrado como entrada (cero movimientos). Se pararía
la producción.

Corrección correcta, en dos tiempos:
1. **Ahora:** avisar sin bloquear ("vas a dejar Tapa normal en −350, ¿registraste la
   compra?") + un tablero de negativos.
2. **Cuando ya se registren las compras de envases/etiquetas:** ahí sí bloquear igual que
   la materia prima.

---

## Problema 2 — NO es bug: el "Conteo inventario" borra el saldo

Esto es lo que el ingeniero está viviendo como *"registré la materia prima y después dice
que no hay"*.

`Conteo inventario` no suma ni resta: **sobrescribe** (función `fijar()`, línea 490).
Lo que se escriba ahí **pasa a ser el saldo, y se borra todo lo anterior**.

**93 de los 204 conteos cambiaron el saldo.** Los que más lo bajaron (todos de Carlos):

| Fecha | Ítem | Tenía | Quedó |
|---|---|---|---|
| 25-jul | Fosfato Trisódico | 19,83 kg | **1,5 kg** |
| 25-jul | Soda Líquida | 19 L | **2,63 L** |
| 25-jul | CMC Chino | 15 kg | **1 kg** |
| 23-jul | Formol | 11,99 L | **0,03 L** |
| 25-jul | Trietanolamina (TEA) | 9,72 L | **1 L** |
| 25-jul | Genapol | 9,40 L | **1 L** |
| 27-jul | Creolina 3*1 | 12 L | **8 L** |

Y el 24-jul un conteo puso **`Galon transparente 4 L` y `Tapa normal` en CERO** — por eso
el galón está en −161 y no en −59 (que es lo que dan las entradas menos los consumos).

**Esto explica el ejemplo del alcohol tal cual:** registra 50, usa 20, deberían quedar 30,
pero un conteo posterior fija el saldo en 1 o 2 → *"no hay materia prima"*. **No es que la
app pierda el registro: es que el conteo lo pisa.**

### Las dos lecturas posibles (esto es lo que hay que preguntarle)

- **A)** El conteo está bien y el saldo calculado venía inflado, porque no se registran
  todos los consumos. **Hay evidencia a favor:** la auditoría del 30-jul reporta
  `COBERTURA_VOLUMETRICA_BAJA` — varias producciones registran **solo el 10% del volumen**
  en componentes (Deterfull, entre otros).
- **B)** El conteo se hace mal: se cuenta solo el garrafón abierto y no lo de bodega. Los
  valores finales (1 · 1,5 · 0,3 · 0,6) son sospechosamente pequeños y redondos.

Muy probablemente **están pasando las dos a la vez**. No se puede decidir sin preguntarle.

---

## Problema 3 — bug menor, pero real: unidades mezcladas

`mover()` suma sin comprobar que la unidad base coincida:

```js
stock[clave].Stock += conv.v;   // suma L con kg sin avisar
```

Encontrado **1 caso**: `CMC CHINO` el 24-jul tenía saldo en **L** y le entró un movimiento
en **kg**. Impacto bajo hoy, pero es una bomba de tiempo. Arreglo: rechazar el movimiento
si la unidad base no coincide con la que ya tiene el ítem.

---

## PREGUNTAS PARA EL INGENIERO (copiar y mandar)

> 1. Cuando haces **Conteo inventario** de un líquido (alcohol, formol, soda), ¿qué cuentas
>    exactamente: solo la garrafa que está abierta y en uso, o también lo que está sin
>    abrir en bodega?
> 2. El 25 de julio contaste **Soda Líquida en 2,63 L** cuando el sistema traía 19 L, y
>    **Fosfato Trisódico en 1,5 kg** cuando traía 19,8 kg. ¿Eso era lo que había de verdad
>    en total, o era lo que tenías a la mano en ese momento?
> 3. El caso del alcohol que le contaste a Oscar: **¿qué día fue y cuál era el tanque?**
>    Con eso lo rastreo movimiento por movimiento.
> 4. Cuando preparas un tanque, ¿registras **todas** las materias primas que le echas, o
>    solo algunas? (Lo pregunto porque hay producciones de Deterfull donde lo registrado
>    da apenas el 10% del volumen del tanque.)
> 5. **Envases, tapas y etiquetas: ¿alguna vez registras la compra?** En 3 meses hay 120
>    empaques y solo 4 entradas de envase y **ninguna** de etiqueta. Si nunca se registran
>    las compras, el negativo es inevitable.
> 6. ¿Hay stock físico de tapas y galones en bodega ahora mismo? Si sí, el sistema está
>    marcando −349 tapas que sí existen.

---

## Qué haría yo, en orden

1. **Mandar las 6 preguntas.** Sin la respuesta a la 1 y la 5 no se sabe si los números
   del sistema o los del conteo son los buenos.
2. **Arreglar el bug 1** con aviso (no bloqueo) + pantalla de negativos.
3. **Arreglar el bug 3** (unidades), que es chico y sin riesgo.
4. **Registrar de una vez las compras de envases/tapas/etiquetas** y hacer un conteo físico
   completo de esas 3 categorías para partir de cero limpio.
5. Recién ahí, activar el bloqueo duro.

**No tocar los saldos de materia prima todavía** — mientras no se sepa si los conteos
estaban bien hechos, cualquier ajuste sería inventar datos.

---

## ACTUALIZACIÓN 2026-07-31 — respuestas del ingeniero y tanque 1 ARREGLADO

### Respuestas de Carlos (vía Oscar)

1. En los conteos cuenta **también lo sin abrir** — el conteo es total.
2. Lo contado era **todo lo que había** → **los conteos son confiables; el saldo
   calculado por la app venía inflado.**
3. No recuerda el día del caso del alcohol.
4. Registra **todas** las materias primas, hasta el agua.
5. **No se registran compras** de envases/tapas/etiquetas → los negativos de esas
   categorías son consecuencia directa, no bug de cálculo.
6. Sí hay tapas y galones físicos → el −349 de tapas es solo falta de registro de compras.

**Lectura:** si 2 y 4 son ciertas a la vez, entre la entrada de mercancía y el consumo hay
plata/material que se va sin registro (mermas, derrames, muestras, o entradas apuntadas
más grandes de lo real). Eso ya no es bug: es proceso. Los conteos periódicos de Carlos
son justamente lo que lo corrige — dejarlos como práctica oficial.

### Tanque 1: era un BUG y quedó corregido y desplegado

**Síntoma:** "preparo el tanque 1 y no se guarda, no me sale en Empacar."
**Realidad:** SÍ se guardaba (preparación del 29-jul, 160 L, está en el registro). Lo que
pasaba: `getInventario()` recortaba la lista con `.slice(-30)` — solo los últimos 30
tanques creados. Al crearse el ID número 31, el tanque más viejo (el 1) desapareció de la
lista, del selector de Empacar **y del validador** (`validarEmpaquePost_` → "Tambor no
encontrado"). Los litros seguían visibles como "A granel · 1", por eso el inventario no
cuadraba con la pantalla.

**Arreglo:** se quitó el límite de 30 (los tanques vacíos ya quedaban marcados "Vacío",
el recorte no aportaba nada). Desplegado vía clasp como versión **@19** del deployment
`AKfycbxAWuJv…` (2026-07-31). Verificado contra la app en vivo: el tanque 1 aparece con
300 L "Listo". `apps-script/Codigo.gs` del repo quedó igual al remoto.

### Preparación duplicada del tanque 1 — REVERTIDA 2026-07-31

**Qué pasó:** como el tanque 1 no aparecía en la app (bug del `.slice(-30)`), Carlos volvió
a registrar la misma preparación. Quedó dos veces:

| | 29-jul 21:21 (buena) | 31-jul 19:46 (duplicada) |
|---|---|---|
| Operación | `OP-3C3EECD0…` | **`OP-A70483CF-1B4`** |
| Litros | 160 L | 170 L |
| CMC Chino | 400 g | 400 g |
| TEA | 300 ml | 300 ml |
| Genapol | 600 ml | 600 ml |
| Formol | 45 ml | 45 ml |
| Agua | 159 L | 169 L |

Componentes idénticos = misma receta tecleada dos veces. El tanque quedó marcando **300 L**
cuando lo real son **130 L** (160 preparados + 10 que quedaban − 40 empacados).

**Cómo se revirtió — sin borrar nada.** `REGISTRO_APP` es libro mayor, así que se usó el
mecanismo propio del sistema: un `Movimiento compuesto` con 5 `Novedad/Corrección`
(operación **`OP-698E1EED-D0C`**, RequestId `rev-dup-tanque1-A70483CF-1B4`):

- tanque 1 → −170 L (motivo *Registro de más*)
- CMC Chino +400 g · TEA +300 ml · Genapol +600 ml · Formol +45 ml (motivo *Sobrante*)

El agua no se revirtió porque la app no la controla como inventario (se ignora a propósito).

**Verificado contra la app en vivo después de aplicar:** tanque 1 = **130 L "Listo"**;
CMC Chino 0,4 kg · TEA 0,3 L · Genapol 0,6 L · Formol 0,05 L devueltos.

Si algún día se comprueba que la del 31-jul era buena, se revierte igual: otra novedad al
revés. Nada se perdió.

### Cómo evitar que se repita — recomendación

Descartada la idea de "un campo donde Carlos escriba y Oscar apruebe": depende de que
alguien se acuerde de escribir, y la regla de la casa es que eso no funciona
(*"no lo harán, los conozco"*). Además le mete a Oscar una cola de aprobaciones.

Lo que sí ataca la causa:

1. **Guardarraíl al guardar (lo importante).** Si se registra el mismo producto, en el
   mismo tanque, con los mismos componentes, dentro de las últimas 24 h → la app avisa
   *"esto se parece a la preparación de hace N horas, ¿seguro?"* y exige confirmar.
   **Avisar y confirmar, no bloquear** — a veces sí se prepara dos veces el mismo día.
   No depende de que nadie avise a nadie.
2. **Aviso a Oscar solo por excepción**: duplicado confirmado, negativo nuevo, o tanque
   con número imposible (como los 2.026 L del tanque 13).
3. **Botón "algo salió mal"** como red de seguridad, no como mecanismo principal — para lo
   que el sistema no puede detectar solo.

---

## ACTUALIZACIÓN 2026-07-31 (tarde) — guardarraíl y auditoría diaria

### 1. Guardarraíl anti-duplicado — DESPLEGADO Y PROBADO

Antes de aceptar una preparación, el backend compara su **firma** (producto + tanque +
componentes, **sin el agua**, que se echa al ojo) contra las preparaciones de ese mismo
tanque en las últimas 24 h. Si coincide, no la guarda y responde:

> POSIBLE DUPLICADO: hace 0.9 h ya se registró "Ambientadores de piso" en el tanque 1 con
> las mismas materias primas (OP-A70483CF-1B4)…

**Avisa, no bloquea.** La app muestra el mensaje y pregunta *"¿Registrarlo de todas
formas?"*; si Carlos acepta, reenvía con `ConfirmoNoDuplicado` y guarda. Así un lote
legítimo repetido sigue siendo posible y nadie queda trabado.

Probado contra la app en vivo, ciclo completo: primera vez guarda · repetida avisa ·
confirmada guarda. El tanque de prueba se dejó vacío y el formol usado se devolvió.

Código: `firmaProduccion_` y `avisarSiPareceDuplicada_` en `Codigo.gs`; el reintento en
`index.html` (`submitForm`). Backend desplegado **@23**; frontend publicado en `main`.

### 2. CAUSA RAÍZ ENCONTRADA: 19 celdas numéricas con formato de fecha

No era solo el tanque 13. La columna `Cantidad` (y `LitrosPreparados`) quedó con **formato
de fecha** en varias filas, así que el número escrito se guardó como fecha y al leerlo
`num()` devuelve el año:

| Se guardó | Se lee como |
|---|---|
| `2026-08-12T05:00…` | **2026** |
| `1900-01-09T04:56…` | **1900** |

Por eso hubo conteos que fijaron **2.013 L de Alcohol 96%**, **2.024 L de Soda Líquida**,
**2.017 L de Ácido Nítrico**… y el tanque 13 con 2.026 L. Son **19 celdas**, casi todas de
`Conteo inventario`, más la producción completa del Gel antibacterial del 30-jul.

**Arreglado hacia adelante:** `doPost` ahora fuerza formato numérico (`setNumberFormat`) en
Cantidad, LitrosPreparados y CantidadPresentacion **antes** de escribir. Los movimientos
nuevos ya no se pueden dañar así.

**Pendiente (necesita a Carlos):** poner el valor real en esas 19 celdas. La auditoría las
lista con el número de fila exacto. **No se inventaron los valores** — solo Carlos sabe
cuánto contó.

### 3. Auditoría diaria — `?action=auditoria`

Se buscó qué hace la industria (conteo cíclico, análisis ABC, análisis de causa de cada
variación, resolver de inmediato para que no se acumule) y se implementaron los controles
que atacan **lo que de verdad falló aquí**, no una lista genérica:

| Control | Qué caza |
|---|---|
| `PREPARACION_DUPLICADA` | misma receta y tanque en menos de 24 h |
| `CELDA_CON_FECHA` | las 19 celdas dañadas, con su fila exacta |
| `DATO_CORRUPTO` | saldos que llegaron a miles antes de un conteo |
| `CONTEO_DESVIO_ALTO` | conteos que corrigieron el saldo más del 50% |
| `STOCK_NEGATIVO_MP` | materia prima negativa = consumo mal registrado |
| `STOCK_NEGATIVO_ENVASE` | envases negativos = compra sin registrar |
| `TANQUE_VOLUMEN_IMPOSIBLE` | tanques con litros imposibles |
| `UNIDAD_MEZCLADA` | solo L contra kg (L y "und" es normal, no se reporta) |
| `CONSUMO_SIN_ENTRADA` | ítems que solo salen y nunca entran |

Se afinó a propósito para que **no dé ruido**: si el informe trae falsos positivos, nadie
lo lee. Ejemplo: un saldo previo absurdo se reporta como `DATO_CORRUPTO`, no como desvío de
conteo, porque son problemas distintos con soluciones distintas.

**Primera corrida real: 17 hallazgos, 16 altas.** Encontró 2 duplicados en el tanque 28
(Deterfull) que nadie había visto, y las 19 celdas dañadas.

**Por qué es un endpoint y no un correo automático:** los 5 crons del plan gratis de
Cloudflare ya están ocupados, y crear un trigger nuevo de Apps Script exige que Oscar
autorice permisos a mano. Como endpoint funciona ya, sin autorizar nada, y se puede
enganchar después a cualquier aviso que ya exista.

**Falta decidir (es de Oscar):** de dónde se cuelga el aviso diario. Opciones:
1. Colgarlo del cron diario que ya corre en `full-registro-chats` (0:00 UTC = 7 p.m.).
2. Trigger propio en Apps Script — hay que autorizar permisos una vez.

Que solo avise cuando haya algo **nuevo**, no todos los días (gestión por excepción).

---

## ACTUALIZACIÓN 2026-07-31 (noche) — residuo fantasma y estado final del tanque 1

### El tercer bug: el tanque arrastraba litros que no existían

Al preparar sobre un tanque que el sistema cree con sobras, esos litros **se sumaban al lote
nuevo sin avisar**. Al tanque 1 le pasó: cargaba 10 L del lote del 24-jul que **físicamente
ya no estaban** (Oscar confirmó: *"el tanque no tenía residuo"*). El fantasma se arrastra
solo y nunca se corrige.

**Corregido y desplegado (@24).** Ahora, si el tanque trae saldo, la app no lo suma callada:

> RESIDUO EN EL TANQUE: el sistema dice que en el tanque 1 todavía quedan 10 L del lote
> anterior. ¿Los aprovechaste en esta mezcla o vaciaste el tanque?

- **Aceptar** → los aprovechó: se suman, como siempre.
- **Cancelar** → estaba vacío: se descarta el fantasma con un movimiento propio
  (`Merma - tanque vaciado antes de preparar`), para que quede a la vista por qué se fue.

Probado en vivo con un tanque de prueba: sin responder **pregunta**; respondiendo *vaciado*
el tanque queda en **0,03 L y no en 0,05**. Prueba limpiada (tanque vacío, formol devuelto).

Código: `resolverResiduoTanque_` y el bloque nuevo de `expandirProduccion_`; en el frontend,
el mismo `catch` que ya manejaba el duplicado.

### Estado final del tanque 1 — decidido por Oscar

| | |
|---|---|
| **Tanque 1** | **170 L, "Listo"** |
| Preparación vigente | la del 29-jul (160 L) |
| Preparación del 31-jul (170 L) | **sigue revertida** |
| Materias primas | **no se tocaron** en este ajuste |

El camino fue: 300 L (con el duplicado) → 130 (revertido el duplicado) → 120 (quitado el
residuo de 10 L) → **170 (ajuste final indicado por Oscar)**.

**Ojo, queda abierto:** si la preparación buena era la del 31-jul (170 L) y no la del
29-jul, hay que devolver también sus materias primas — CMC 400 g, TEA 300 ml, Genapol
600 ml, Formol 45 ml. Hoy el tanque dice 170 L pero las materias primas descontadas son las
del lote del 29-jul. **No se tocó porque no está confirmado cuál de los dos lotes fue el
real.**

---

## ACTUALIZACIÓN 2026-08-01 — tres bugs más, dos de ellos míos

### 1. El formato de fecha volvió a morder (tanque 25 con 2.026 L)

El arreglo del 31-jul (formatear las filas nuevas antes de escribir) **no bastó**: sin
`SpreadsheetApp.flush()`, `setNumberFormat` y `setValues` no tienen orden garantizado y el
formato viejo a veces gana. Se comprobó leyendo la celda: `Cantidad` quedó con formato
`0.######` pero `LitrosPreparados` con **`d.m`** en la misma fila.

**Arreglo definitivo (3 capas):** formato a la columna **entera** (no solo las filas
nuevas) → `flush()` → escribir → `flush()` → **releer y, si algo quedó Date, reescribirlo
como número**. Así no depende del orden interno de Sheets.

### 2. Reparación de las celdas ya dañadas — sin inventar números

`?action=repararlitros` reconstruye `LitrosPreparados` **sumando los componentes reales de
esa misma producción** (la app ya exige que expliquen el 80–105% del volumen). Sin
`&aplicar=si` solo informa qué haría.

| Tanque | Decía | Quedó | De dónde salió |
|---|---|---|---|
| 25 · Extermin | 2.026 L | **20 L** | 0,5 L de MP + 19,5 L de agua |
| 13 · Gel antibacterial | 2.026 → 46.144 L | **2,04 L** | 10 g Carbopol + 6,7 ml TEA + 16,7 ml formol + 16,7 ml glicerina + 2 L agua |

El 13 pasó por 46.144 porque al forzar el formato numérico la fecha se destapó como su
número interno. Eso además **destapó sus componentes**, que antes también estaban dañados y
por eso no se podía reparar el 31-jul.

**Ya no queda ninguna celda con fecha ni ningún tanque con volumen imposible.**

### 3. Trampa del motivo: "sobrante" significa SUMAR

`getInventario` decide el signo de una `Novedad/Corrección` buscando palabras sueltas en el
motivo. Un motivo escrito como *"Merma - sobrante no se suma aparte"* contenía **las dos**,
y ganaba la suma: el ajuste **inflaba** en vez de restar. Un tanque de prueba quedó en 21 L
en vez de 20.

**Arreglado:** ahora la resta manda si el motivo menciona ambas cosas. Se verificó que solo
2 movimientos cambiaban de signo, los dos de ese mismo día y los dos debían restar; ningún
histórico se alteró.

**Regla al escribir correcciones:** si el motivo debe RESTAR, no uses la palabra
*sobrante* ni *desempaque*.

### 4. La pregunta del sobrante estaba mal planteada (tanque 15)

Preguntar *"¿aprovechaste el sobrante?"* se malinterpreta. Carlos tenía 11 L, preparó 1 L
más para llegar a 12, respondió **que sí lo aprovechaba**… y el tanque quedó en **1 L**,
porque esa respuesta significaba "lo registrado es el total".

**Rediseñada:** ahora la pregunta muestra **con cuánto queda el tanque en cada opción**, que
es lo único que el operario necesita decidir:

> RESIDUO EN EL TANQUE 15: el sistema dice que ya había 11 L y estás registrando 1 L.
> • Si los 1 L son ADICIONALES, el tanque queda con **12 L**.
> • Si los 1 L son el TOTAL, queda con **1 L**.

Probado con el caso exacto de Carlos: respondiendo *adicionales* queda en 12 L.
Tanque 15 corregido a **12 L**.

### Estado de tanques al cierre

| Tanque | Litros | Nota |
|---|---|---|
| 1 · Ambientadores | **27 L** | correcto: de los 170 se empacaron 143 L la noche del 31-jul |
| 13 · Gel antibacterial | **2,04 L** | reparado |
| 15 · Detergente ropa | **12 L** | corregido |
| 25 · Extermin | **20 L** | reparado |

Todos los tanques `ZZ-PRUEBA-*` quedaron vacíos y el formol de las pruebas devuelto.
