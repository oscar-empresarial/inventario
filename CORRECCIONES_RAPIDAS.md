# Correcciones rápidas del inventario

## Qué se agregó

La pestaña naranja **Correcciones** permite:

1. **Corregir producto del tanque**: cambia el nombre del contenido actual sin cambiar sus litros. Opcionalmente traslada al nombre correcto las presentaciones ya empacadas que todavía tienen saldo en ese mismo lote.
2. **Completar producción**: agrega las materias primas omitidas a la preparación original. Descuenta únicamente esos componentes y nunca vuelve a sumar los litros fabricados.
3. **Trasladar saldo**: mueve toda la existencia de un nombre equivocado a un ítem oficial existente.
4. **Ver historial relacionado**: desde Movimientos muestra la operación, sus correcciones, el tanque, el producto y los consumos enlazados.

## Reglas de seguridad

- `REGISTRO_APP` sigue siendo un libro mayor: no se edita ni se borra el movimiento original.
- Toda corrección exige responsable, motivo y referencia original.
- El mismo `RequestId` no puede duplicar una corrección.
- Una corrección de tanque solo puede actuar sobre el lote actual; se rechaza si el tanque fue preparado de nuevo después.
- Corregir un tanque no altera litros.
- Completar componentes no crea otra fila de `Preparar tambor`.
- Las materias primas añadidas quedan unidas mediante `ReferenciaOriginal`, por lo que Conciliación vuelve a evaluar la preparación completa.
- Una corrección histórica puede dejar una materia prima en negativo si antes no existía saldo. Eso queda visible para conteo/revisión; la app no inventa una entrada para ocultarlo.

## Publicación

Los dos archivos deben actualizarse:

1. Copiar `apps-script/Codigo.gs` en el proyecto de Apps Script, guardar y editar la implementación existente usando **Nueva versión**.
2. Publicar `index.html` en GitHub Pages.
3. Abrir la app, entrar a **Correcciones** y pulsar **Actualizar datos**.

La versión compatible del backend se conservó para que la aplicación normal no quede bloqueada si los dos pasos se hacen con unos minutos de diferencia.

## Preguntas para el ingeniero antes de corregir

1. ¿Cuál es el tanque o balde exacto?
2. ¿Qué producto decía y cuál era realmente?
3. ¿Ya se empacaron unidades desde ese tanque?
4. ¿Qué materias primas se usaron realmente, con cantidad y unidad?
5. ¿Quién confirma la corrección y qué evidencia revisó?

