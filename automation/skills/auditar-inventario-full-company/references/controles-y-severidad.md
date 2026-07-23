# Controles y severidad

## Crítica

Usar cuando existe riesgo de corrupción o pérdida silenciosa:

- backend incompatible o no disponible;
- mismo `RequestId` asociado con payloads u operaciones diferentes;
- identificadores de movimiento duplicados;
- cantidades no finitas;
- escritura parcial confirmada.

## Alta

Requiere revisión prioritaria, pero no autoriza un ajuste:

- inventario o tanque negativo;
- empaque superior a lo preparado;
- producción sin componentes esenciales de una BOM provisional;
- producción sin volumen, producto, tanque o responsable;
- entrada, consumo o empaque con cantidad inválida;
- operación nueva sin trazabilidad mínima.

## Media

Riesgo de configuración o control:

- proporción de receta fuera de tolerancia provisional;
- BOM no estandarizada;
- nombre o unidad sospechosa;
- revisión pendiente;
- responsable no reconocido;
- identidad no verificable por uso de computador compartido;
- reutilización de tanque sin lote independiente.

## Baja o informativa

- componente adicional frente a una receta provisional;
- fila histórica anterior a los metadatos actuales;
- recomendación de conteo, respaldo o mejora futura.

## Reglas de interpretación

- Agrupar hallazgos históricos repetidos por código y lote.
- Distinguir dato ausente de dato igual a cero.
- Convertir L/mL y kg/g antes de comparar.
- Escalar la receta al volumen real producido.
- No sumar sólidos como si fueran litros.
- Una diferencia de receta es evidencia para revisar, no prueba automática de error humano.
- Priorizar anomalías nuevas sobre deudas históricas conocidas.
- El informe debe decir expresamente que no modificó inventario.
