# Auditoría integral del inventario Full Company

Fecha: 22 de julio de 2026  
Versión revisada: `2.2.0-revisiones`

## Resultado ejecutivo

La revisión corrigió dos causas que alteraban la lectura del inventario y reconstruyó el módulo de Revisiones para que sirva como cola de gobierno de datos. No se realizaron ajustes automáticos ni se borraron movimientos históricos.

El caso de Ecovarsol de 120 L que aparecía con 40 L se originó porque el cálculo buscaba tanques por coincidencia parcial. Un empaque registrado para el tanque `1` también coincidía con el tanque `12` y descontaba 80 L de este último. La búsqueda ahora exige coincidencia exacta. Además, la producción de 120 L con solo 1 L de fragancia queda bloqueada si la fórmula declarada no explica el volumen producido.

## Qué significaban los 108 hallazgos

La cifra anterior no equivalía a 108 ajustes de inventario:

- 80 filas eran movimientos históricos sin los nuevos metadatos de auditoría. Ahora se presentan como un único aviso de migración histórica.
- 16 avisos correspondían a producciones históricas con genealogía o fórmula incompleta. Deben verificarse documentalmente; no deben inventarse consumos retroactivos.
- 10 alertas de saldos negativos incluían falsos positivos causados por leer una columna vacía antes que `LitrosPreparados`.
- 2 alertas de tanque duplicado eran reutilizaciones físicas de un mismo tanque, una práctica posible, no duplicados automáticos.

La nueva conciliación separa cantidad total, hallazgos prioritarios, filas históricas y códigos de causa. Su propósito es señalar qué revisar; nunca modifica existencias por sí sola.

## Correcciones implementadas

### Inventario y producción

- Coincidencia exacta del identificador de tanque; se eliminaron colisiones como `1`/`12` y `2`/`28`.
- Lectura correcta de campos equivalentes cuando una columna anterior existe pero está vacía.
- Producción bloqueada cuando sus componentes no explican el volumen, hay componentes duplicados, falta confirmación de fórmula o el saldo fuente es insuficiente.
- Cada producción conserva una operación común para producto terminado y consumos, incluyendo versión de fórmula.
- Formularios de varias líneas se guardan como una operación compuesta y atómica para evitar registros parciales.
- Tipos de movimiento limitados a una lista conocida; se bloquean solicitudes directas de borrado o aprobación.

### Centro de Revisiones

La pestaña Revisiones ya no depende del rango de fechas de la pantalla de movimientos. Consulta toda la cola y separa Pendientes, Historial y Conciliación.

Decisiones disponibles:

- **Aprobar:** reconocer un artículo nuevo como maestro oficial.
- **Corregir nombre:** renombrar un artículo oficial con motivo, soporte y responsable, transfiriendo su saldo completo con trazabilidad.
- **Relacionar duplicado:** enlazar una variante con un artículo oficial y transferir su saldo sin borrar historia.
- **Archivar:** permitido únicamente cuando el saldo es cero.

Las decisiones se guardan en una sola operación, con referencia, motivo, responsable, fecha e identificadores de solicitud. No existe una acción destructiva de “eliminar artículo”.

### Conciliación y auditoría

- Agrupación de filas históricas sin auditoría en vez de generar una tarjeta por fila.
- Separación de reutilización de tanque respecto de un duplicado real.
- Cálculo de lotes con operaciones exactas y ventanas históricas controladas.
- Resumen por código de hallazgo y lotes prioritarios.
- Catálogos reconstruidos también desde el libro de movimientos aprobado, para que el registro contable siga siendo la fuente principal.

## Pruebas ejecutadas

Se ejecutaron 26 pruebas automáticas, todas aprobadas. Cubren, entre otros escenarios:

- incidente de 120 L con solo 1 L de componente;
- fórmulas completas e incompletas;
- base insuficiente y tanque destino usado como fuente;
- componentes repetidos;
- inventario negativo en consumo o empaque;
- colisiones de tanques `1`/`12` y `2`/`28`;
- agrupación de auditoría histórica;
- operaciones compuestas sin escrituras parciales;
- decisiones controladas de revisión;
- referencias obligatorias para correcciones;
- sintaxis y contratos entre interfaz y servidor.

También se verificó visualmente el nuevo centro de Revisiones, sus pestañas, formularios y mensajes de incompatibilidad cuando la interfaz nueva se conecta temporalmente a un servidor anterior.

## Referencias de diseño ERP/MRP

El flujo se alineó con prácticas de sistemas empresariales:

- versiones y aprobación del maestro/BOM antes de producción, como Engineering Change Management de Microsoft Dynamics 365;
- listas de materiales con cantidades explícitas, como Manufacturing de Odoo;
- movimientos de mercancía trazables y tipificados, como SAP S/4HANA;
- conteos y ajustes con razones documentadas, como Dynamics 365 y los conteos cíclicos de Odoo.

Referencias:

- https://learn.microsoft.com/en-us/dynamics365/supply-chain/engineering-change-management/product-engineering-overview
- https://www.odoo.com/documentation/master/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html
- https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/4dd8cb7b1c484b4b93af84d00f60fdb8/c503b753128eb44ce10000000a174cb4.html
- https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/reason-codes-for-counting-journals
- https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/cycle_counts.html

## Riesgos y siguientes fases

### Prioridad crítica

- El despliegue actual de Apps Script es público y el servidor no dispone de una identidad confiable del operario. Para permisos reales por rol se requiere restringir el acceso a cuentas autorizadas o añadir autenticación empresarial y una tabla de roles.
- Convertir las fórmulas manuales en BOM maestras versionadas por producto. La validación volumétrica evita el caso absurdo, pero no demuestra por sí sola que se usaron los ingredientes correctos.

### Prioridad alta

- Contar físicamente y documentar los tanques históricos con saldo negativo real, en especial `1`, `9`, `14` y `21`, además del origen no trazado de Genapol. Corregir mediante conteo con razón y soporte, nunca editando el pasado.
- Verificar la genealogía histórica del tanque `12` (Ecovarsol) y las diferencias de los tanques `27` y `28` contra hojas de producción.
- Separar `TanqueFisicoID` de `LoteProduccionID` para que la reutilización de un recipiente no mezcle lotes.
- Añadir anulación/reverso formal en lugar de modificar movimientos registrados.

### Prioridad media

- Incorporar lotes de materia prima, proveedor, caducidad, cuarentena/liberación de calidad y FEFO.
- Crear respaldo automatizado, exportación y prueba periódica de recuperación.
- Reemplazar el límite de 1.000 movimientos por paginación completa.
- Añadir controles de segregación de funciones: quien registra no debería aprobar su propia corrección sensible.

## Puesta en producción

1. Guardar el código de `apps-script/Codigo.gs` en el proyecto de Apps Script.
2. Crear una versión nueva del despliegue existente y completar la autorización de Google solicitada al propietario.
3. Verificar que `?action=ping` o la respuesta raíz indique `2.2.0-revisiones`.
4. Publicar `index.html` en GitHub Pages.
5. Abrir Revisiones, confirmar que carga la cola global y ejecutar primero revisiones documentales; no ajustar existencias basándose solo en una alerta.

