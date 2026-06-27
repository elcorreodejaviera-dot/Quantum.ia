# Audit de código — JAV-123 (hueco gris en tarjeta de pool, fila "Tiempo de vida")

Sos Codex revisando un cambio **CSS-only de UI** (prioridad baja, bajo riesgo) antes de hacer commit/PR.
Quiero un veredicto **GO / NO-GO** y, si hay NO-GO, hallazgos accionables.

## Contexto del bug

Al quitar el tile "Total generado" (JAV-119, producto solo-real), las tarjetas de pool quedaron con
una métrica suelta de "Tiempo de vida" que dejaba **columnas vacías**:

- **Admin** (`src/components/AdminView.jsx`): `.av-pos-grid` es un grid de **4 columnas** con
  `background: var(--line)` (gris). Hay **5 celdas** → la 5ª ("Tiempo de vida") caía sola en una 2ª fila
  ocupando 1 de 4 columnas y las **3 restantes mostraban el fondo gris** → bloque gris vacío visible.
- **Portal inversor** (`src/components/BotPortal.jsx`): `.pool-metrics-header` es grid de **6 columnas**
  con una sola `<Metric>` de "Tiempo de vida" → 5 columnas vacías (sin `background`, menos visible pero
  igual desalineado).

## El arreglo (working tree, sin commitear)

Hacer que la fila de "Tiempo de vida" ocupe **todo el ancho**, sin reintroducir "Total generado".

### `src/components/AdminView.jsx`
- La celda de "Tiempo de vida" pasa de `className="av-cell"` a `className="av-cell av-cell-wide"`.
- Nueva regla en `AdminStyles()`:
  ```css
  .av-cell-wide{grid-column:1/-1}
  ```
  → la 5ª celda ocupa una fila propia full-width (columnas 1 a -1); las otras 4 quedan en la 1ª fila.

### `src/components/BotPortal.jsx`
- El contenedor pasa de `className="pool-metrics-header"` a
  `className="pool-metrics-header pool-lifetime-row"`.

### `src/styles/bot-portal.css`
- Nueva regla:
  ```css
  .pool-metrics-header.pool-lifetime-row {
    grid-template-columns: 1fr;
  }
  ```
  Selector de **doble clase** a propósito: especificidad (0,2,0) > las reglas de una sola clase
  `.pool-metrics-header` (0,1,0) dentro de los `@media (max-width: 900px)` y `640px` → la métrica única
  se mantiene a 1 columna en **todos** los breakpoints.

## Diff exacto

```diff
diff --git a/src/components/AdminView.jsx b/src/components/AdminView.jsx
@@ PositionCard celda lifetime
-        <div className="av-cell" title={lifeDateStr ? `Vida total desde ${lifeDateStr}` : 'Vida total de la posición'}>
+        <div className="av-cell av-cell-wide" title={lifeDateStr ? `Vida total desde ${lifeDateStr}` : 'Vida total de la posición'}>
@@ AdminStyles()
   .av-cell{background:var(--panel-2);padding:10px 14px}
+  .av-cell-wide{grid-column:1/-1}

diff --git a/src/components/BotPortal.jsx b/src/components/BotPortal.jsx
@@ PoolCard lifetime row
-        <div className="pool-metrics-header">
+        <div className="pool-metrics-header pool-lifetime-row">

diff --git a/src/styles/bot-portal.css b/src/styles/bot-portal.css
+.pool-metrics-header.pool-lifetime-row {
+  grid-template-columns: 1fr;
+}
```

## Verificación ya hecha
- `npx vite build` limpio (NO `npm run build`, que despliega prod).
- Especificidad CSS revisada: la doble clase gana a los media queries.

## Qué quiero que verifiques
1. ¿El arreglo elimina realmente el hueco gris en admin (5ª celda full-width, sin columnas grises)?
2. ¿En el portal la métrica única queda a todo el ancho en desktop **y** en 900/640px (especificidad OK)?
3. ¿Algún efecto colateral en otras tarjetas que reusen `.av-pos-grid`, `.av-cell`,
   `.pool-metrics-header` o estas nuevas clases? (¿colisión de nombres `av-cell-wide` /
   `pool-lifetime-row`?)
4. ¿Hay una forma más limpia/idiomática dado el resto del CSS del repo, o esto es correcto y mínimo?
5. ¿Algún riesgo de regresión (responsive, gap, alineación de label/valor)?

Respondé **GO** o **NO-GO** con hallazgos.
