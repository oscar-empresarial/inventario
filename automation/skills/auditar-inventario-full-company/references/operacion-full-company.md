# Operación real de Full Company

## Flujo de materiales

1. Carlos (laboratorio) o Neyder (patinador) recibe mercancía y registra la entrada.
2. Para fabricar, registra cuánto retira de cada materia prima y cuánto producto obtiene.
3. La capacidad del recipiente no determina la producción: en un tanque de 120 L puede fabricar 100 L.
4. La producción crea inventario a granel identificado por tanque/lote.
5. Solo se puede empacar producto que ya exista a granel.
6. El empaque consume producto a granel, envases y accesorios. También registra la etiqueta usada o declara explícitamente que sale sin etiqueta.
7. Si un envase o insumo no existe en el maestro, se registra y queda trazable para revisión.
8. El mismo principio aplica a líquidos, polvos, palos de aluminio y otros productos transformados.
9. El producto terminado debe alimentar posteriormente el stock de Siigo.

## Regularización de arranque

La empresa todavía no dispone de un conteo físico completo. Como medida transitoria, cuando se empaca existencia antigua se registra primero la materia prima teórica correspondiente, se crea la producción a granel y luego se registra el empaque.

Este flujo debe:

- quedar marcado como regularización o reconstrucción inicial;
- conservar responsable, fecha, motivo y referencia;
- usar la fórmula proporcional a la cantidad empacada;
- generar una alerta informativa;
- no confundirse con una fabricación física ocurrida ese día;
- no sustituir indefinidamente el conteo físico.

## Personas e identidad

- Operadores esperados: Carlos y Neyder.
- Ambos pueden realizar tareas similares.
- Se usa un computador compartido y una misma sesión.
- El campo `Responsable` es una declaración operativa, no una prueba de identidad.
- No atribuir culpa basándose solo en la cuenta de Google. Recomendar un PIN corto o confirmación personal cuando sea viable.

## Política de alertas

- No bloquear por defecto.
- Alertar y dejar trazabilidad.
- Proponer corrección o revisión.
- Nunca ajustar existencias automáticamente.
- Para diferencias físicas, exigir conteo, motivo y soporte antes de un ajuste.

## Limitaciones conocidas

- Las recetas viven en `G:\Mi unidad\Drive Full Company\Precios\Costos Marca Sorprendente.xlsx`.
- Las mermas no están estandarizadas.
- Las BOM extraídas son provisionales.
- La autenticación actual no identifica de forma confiable al operario.
- El identificador del tanque físico todavía puede mezclar reutilizaciones históricas con lotes de producción.
