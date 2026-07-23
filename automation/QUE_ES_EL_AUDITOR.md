# Auditor del inventario Full Company

Este módulo es el inspector preventivo del inventario. Lee el estado del sistema, ejecuta pruebas y produce un informe con lo que debe revisarse. No modifica existencias, no aprueba elementos y no bloquea el trabajo.

## Qué revisa

- disponibilidad y versión de Apps Script;
- entradas, consumos, producciones y empaques;
- operaciones incompletas, partidas o duplicadas;
- `RequestId`, `OperacionID` y hashes de trazabilidad;
- saldos negativos y diferencias de tanques;
- componentes y proporciones frente a las recetas disponibles;
- nombres, unidades y envases sospechosos;
- responsables declarados y elementos pendientes en Revisiones;
- funcionamiento del código mediante pruebas normales y adversariales.

## Cómo usarlo

En Codex se puede pedir:

> Usa `$auditar-inventario-full-company` y dime qué debo revisar hoy.

También acepta preguntas concretas:

- “Audita la última producción de Ecovarsol”.
- “Revisa si Carlos o Neyder registraron operaciones incompletas”.
- “Comprueba si el tambor guardado aparece en inventario”.
- “Ejecuta todas las pruebas e investiga cualquier fallo”.

Los informes quedan en `automation/reports/` y se excluyen de Git porque pueden contener datos internos.

## Fórmulas

El catálogo inicial se extrajo de:

`G:\Mi unidad\Drive Full Company\Precios\Costos Marca Sorprendente.xlsx`

Contiene 40 recetas provisionales. Sirven para generar alertas, pero no son reglas obligatorias porque las mermas todavía no están estandarizadas y algunas recetas necesitan confirmación.

## Responsabilidad

Carlos y Neyder usan el mismo computador. El sistema conserva el nombre que seleccionan, pero esa selección no demuestra técnicamente quién estaba frente al equipo. El auditor revisa el cumplimiento del proceso; no asigna culpa.

## Regla principal

Una alerta inicia una revisión. Nunca autoriza por sí sola a cambiar inventario. Toda diferencia física debe cerrarse con conteo, responsable, motivo y soporte.
