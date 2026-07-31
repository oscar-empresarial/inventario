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

### Bug adicional encontrado al revisar (pendiente, no urgente)

El tanque **13 (Gel antibacterial) marca 2.026 L disponibles**: la celda
`LitrosPreparados` de su preparación del 30-jul contiene una **fecha**
(`2026-05-02T05:00…`) en vez de un número — la hoja formateó la celda como fecha y
`num()` lee "2026". Corregir la celda en la hoja REGISTRO_APP (fila del 30-jul, tambor
13) poniendo los litros reales, y considerar validar en `doPost` que LitrosPreparados
sea numérico.
