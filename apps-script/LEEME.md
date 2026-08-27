# Esta copia NO es la que corre. Está congelada.

El backend vivo del Apps Script es:

    3-INVENTARIO/app-ingeniero/Código.js

Las dos carpetas tenían el **mismo `scriptId`**, así que un `clasp push` hecho desde aquí
mandaba esta copia —del 13 de agosto— encima de la buena y se llevaba por delante todo lo
del 24 y el 26 de agosto: el SKU obligatorio al empacar, el mapa de parejas verificadas y
el arreglo de las recargas. Nadie se habría dado cuenta hasta que el laboratorio empezara
a perder producción otra vez.

Por eso se le quitó el `.clasp.json` a esta carpeta: ahora `clasp push` aquí **falla**, que
es justo lo que tiene que pasar. Los archivos se dejan como historia, no como fuente.

Para tocar el backend:

```bash
cd "3-INVENTARIO/app-ingeniero"
clasp push -f
clasp deploy -i AKfycbxAWuJv7dfjjyobgnEc9yIMJN7uqSnOu9vM80G88JCiDV-0oam5DebiEeqG0FLgcN8I -d "qué cambió"
```

Sin ese `deploy -i` el `doGet`/`doPost` sigue sirviendo la versión vieja: el push solo
guarda, no publica.
