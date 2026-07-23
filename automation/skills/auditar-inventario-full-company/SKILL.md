---
name: auditar-inventario-full-company
description: Auditar de forma preventiva y de solo lectura el inventario de Full Company, su aplicación web, Apps Script, movimientos, producciones, tanques, empaques, conciliación, revisiones y uso operativo. Usar cuando se pida comprobar si el sistema funciona, detectar registros incompletos o inconsistentes, revisar cómo lo usan Carlos o Neyder, comparar una producción con su fórmula/BOM, ejecutar pruebas adversariales, investigar descuadres o preparar un informe de riesgos sin ajustar inventario automáticamente.
---

# Auditar Inventario Full Company

## Principios

- Tratar `REGISTRO_APP` como libro mayor: no editar ni borrar movimientos históricos.
- Trabajar en modo lectura salvo que el usuario solicite explícitamente una corrección.
- No bloquear operaciones, ajustar existencias ni aprobar revisiones automáticamente.
- Usar las BOM provisionales solo para alertar. No convertirlas en reglas obligatorias hasta que producción valide receta y merma.
- Auditar el proceso y la evidencia, no calificar personalmente al trabajador.
- Explicar primero qué necesita revisión hoy, luego la evidencia y finalmente la mejora sugerida.

## Flujo

1. Leer [operacion-full-company.md](references/operacion-full-company.md) para entender el proceso real.
2. Leer [controles-y-severidad.md](references/controles-y-severidad.md) antes de clasificar hallazgos.
3. Localizar el repositorio. Preferir la ruta indicada por el usuario; en este equipo usar:
   `C:\Users\USUARIO\Desktop\Sistema Automatizado - Claude\inventario`.
4. Verificar que el repositorio no tenga cambios ajenos sin guardar. No descartarlos.
5. Ejecutar las pruebas del repositorio con `npm test` cuando se revise funcionamiento o código.
6. Ejecutar el auditor determinístico:

   ```powershell
   node <skill-dir>\scripts\audit-live.mjs `
     --config <skill-dir>\references\default-config.json `
     --boms <skill-dir>\references\boms-provisionales.json `
     --out "C:\Users\USUARIO\Desktop\Sistema Automatizado - Claude\inventario\automation\reports"
   ```

7. Abrir el informe Markdown y revisar, como mínimo:

   - versión y disponibilidad del backend;
   - producciones incompletas, componentes y proporciones;
   - operaciones partidas, duplicadas o sin idempotencia;
   - tanques negativos o empaques superiores a lo preparado;
   - inventario negativo, unidades incompatibles y nombres sospechosos;
   - registros sin responsable o con responsable no esperado;
   - elementos pendientes en Revisiones;
   - metadatos históricos faltantes, separados de fallos nuevos.

8. Si se investiga una anomalía concreta, contrastar `OperacionID`, `IdempotencyKey`, `RequestHash`, `HashIntegridad`, responsable, fecha, tanque, producto y movimientos hijos.
9. Entregar un resumen en lenguaje sencillo con: causas, impacto, evidencia, acción recomendada y qué no debe ajustarse sin conteo físico.

## Fórmulas

Leer [boms-provisionales.json](references/boms-provisionales.json) solo para auditorías de producción. Escalar cantidades proporcionalmente al volumen realmente fabricado: un tanque de 120 L puede contener una fabricación de 100 L.

Si cambia `Costos Marca Sorprendente.xlsx`, usar la skill de hojas de cálculo, inspeccionar visualmente el libro y regenerar el catálogo con `scripts/extract-boms.mjs`. Mantener `authoritativeForBlocking: false` hasta que el usuario confirme recetas y tolerancias.

## Cambios

Cuando el usuario pida corregir la aplicación:

- reproducir primero el fallo con una prueba;
- implementar la corrección mínima coherente;
- añadir prueba de regresión y caso adversarial;
- ejecutar toda la batería;
- no desplegar Apps Script ni escribir datos reales sin autorización explícita;
- conservar un informe de antes/después.

## Resultado esperado

Guardar los informes locales en `automation/reports/`. No subirlos al repositorio público porque pueden contener información operativa. Presentar los hallazgos críticos y altos agrupados; no convertir decenas de filas históricas en decenas de alarmas independientes.
