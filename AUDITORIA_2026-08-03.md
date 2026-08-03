# Auditoría del 3-ago-2026: qué estaba mal de verdad y qué se arregló

Continuación de `CAIDA_2026-08-03.md`. Aquí se revisaron los 779 movimientos reales,
no supuestos.

## 1. La auditoría diaria estaba gritando ruido

Antes: **15 hallazgos, 14 de prioridad ALTA**. Después: **6 hallazgos, 4 ALTAS** — y ahora
sí ve el problema que importa. Lo que pasaba:

### a) Preparaciones "duplicadas" que no eran duplicadas (2 falsos ALTA)
La regla marcaba dos preparaciones iguales del mismo tanque en menos de 24 h. Pero **no
miraba si el tanque se había vaciado en el intermedio**. El tanque 28, revisado movimiento
por movimiento:

- 24-jul 20:37 preparó 20 L → 21:23 empacó **5 galones de 4 L = 20 L** → 21:25 preparó otros 20 L.
- 28-jul 21:50 preparó 20 L → 21:51-21:53 empacó 7×2 L + 1×4 L + 1×2 L = **20 L** → al otro día preparó 20 L.

Eso es el trabajo normal. **Arreglado:** la regla ahora ignora el caso si hubo empaque o
consumo de base del tanque entre las dos preparaciones.

### b) Datos de prueba metidos en la producción real (1 falso ALTA)
Quedaron **40 movimientos** de pruebas técnicas de julio 31 y agosto 1 (`ZZ-PRUEBA-*`,
"Prueba sobrante", "Prueba formato numerico"…) y **5 tanques falsos** en la lista que ve el
operario. **Arreglado:** se excluyen de la auditoría y de la lista de tanques (31 tanques
en vez de 36). No se borró nada del libro mayor — se ignora, que es la regla de la casa.
Se verificó que el material que gastaron esas pruebas ya había sido devuelto: **impacto
neto en Formol = 0,000**.

### c) Ocho alertas ALTA que se repetían todos los días para siempre
Los conteos viejos con celda-fecha (Alcohol 96%, Butylglycol, Soda Líquida, Peróxido…)
**ya fueron tapados por conteos posteriores**: el saldo de hoy no depende de ellos.
**Arreglado:** salen una sola vez, juntos, como una línea de prioridad BAJA e histórica.

## 2. El hueco grave: la auditoría no miraba el saldo de HOY

La regla vieja solo comparaba el saldo **anterior** a un conteo. Un ítem contado **una sola
vez** —y justo esa vez con la celda dañada— nunca se detectaba. Por eso esto llevaba
9 días invisible:

> **Soda Cáustica: 46.052,9 kg.** Son 46 toneladas. Tiene exactamente 2 movimientos en toda
> su historia: el conteo del 25-jul (que quedó con la fecha en la celda, 46054 = 25-jul-2026
> en número de Sheets) y un consumo de 1,1 kg. Nadie la ha vuelto a contar.

**Arreglado:** control nuevo `SALDO_IMPOSIBLE` sobre el saldo actual de materia prima.

## 3. Pop-up obligatorio: lo que el sistema no puede adivinar

Cuando un saldo no puede ser cierto, no hay cálculo que lo resuelva: hay que preguntarle a
quien está en la planta. Ahora la app abre un aviso **que no se puede cerrar** con la
pregunta concreta. Hoy salen dos, sacadas de los datos reales:

1. **Soda Cáustica marca 46.052,9 kg** → *¿Cuánto hay HOY?*
2. **Alcohol 96% marca 1 und, pero siempre se ha movido en L** → *¿Cuánto hay HOY, en L?*
   (el conteo del 24-jul se registró en "und" y borró los litros que traía)

Cómo funciona:
- Las preguntas las calcula el backend (`?action=preguntas`) **desde los datos vivos**. No
  hay una lista escrita a mano: si mañana otro ítem se daña igual, la pregunta aparece sola.
- La respuesta se guarda como un **Conteo inventario normal**, firmado por quien contesta,
  con la observación de por qué se hizo. Pasa por la misma validación, la misma clave de
  idempotencia y la misma confirmación que cualquier otro movimiento. **No se edita ni se
  borra nada** del libro mayor.
- Como la pregunta nace del saldo absurdo, **al responderla desaparece sola**. No hay estado
  que mantener.
- Único escape: **"No sé, preguntar a Carlos"** — vuelve a preguntar a las 12 h y el dato
  sigue marcado como malo en la auditoría. Se dejó a propósito: un bloqueo sin salida
  pararía la producción, y eso es peor. Si Oscar lo quiere sin escape, es quitar un botón.
- Espera su turno si están abiertos la bienvenida o el tour, y reintenta si el Apps Script
  está ocupado.

## 4. Rendimiento: lo que hacía cola al Apps Script

`getEstadoOperacion_` leía **la hoja completa**, y la app la llama **hasta 12 veces por cada
guardado** para confirmar. `doPost` también la leía completa para revisar idempotencia.
Ahora ambos revisan solo las **últimas 500 filas** (`VENTANA_BUSQUEDA_FILAS`). El
movimiento que se confirma acaba de escribirse: está al final. Con 779 filas ya se nota, y
deja de crecer para siempre.

**No se tocó** el `setNumberFormat` de columna completa con `flush()` en cada POST: es el
arreglo que impide que vuelvan a aparecer celdas-fecha, y se verificó que funciona —
**ningún movimiento posterior al 31-jul tiene valores 46.xxx**.

## 5. Lo que queda pendiente (dicho claro, no escondido)

- **45 saldos negativos**, todos de envases, etiquetas, tapas y accesorios (**ninguna
  materia prima**). Los peores: Tapa normal −473, Galón transparente 4 L −201, Envase
  transparente 500 ml −98. La auditoría dice bien qué son: compras que entraron sin
  registrarse. Se arregla registrando las entradas, no ajustando saldos — es digitación,
  no código.
- **CMC CHINO y Trietanolamina (TEA)** mezclan peso con volumen (kg con L). Hoy el saldo de
  ambos queda en 0 porque se cuentan y se consumen completos el mismo día, así que no está
  haciendo daño, pero hay que unificar la unidad de cada ítem.
- **Las pruebas automáticas (`npm test`) están rotas: 12 fallan.** Se verificó que
  **fallaban igual antes de estos cambios** (mismo listado exacto en el commit anterior):
  los tests son más viejos que el backend y no simulan la hoja que ahora leen las
  validaciones de residuo y duplicado. No es una regresión, pero mientras sigan así no
  protegen de nada.
