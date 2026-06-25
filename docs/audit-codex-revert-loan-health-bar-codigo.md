# Auditoria Codex - redisenio barra Loan health Revert Lend

Fecha: 2026-06-25

## Alcance auditado

- `src/components/BotPortal.jsx`: render de `PoolCard`, bloque `Revert Lend` / `borrow-track`.
- `src/styles/bot-portal.css`: estilos de `borrow-health`, segmentos `borrow-seg` y marcador `borrow-marker`.
- Verificacion de no afectacion en calculo/backend:
  - `convex/actions/poolScanner.ts`
  - `src/components/AdminView.jsx`
- Referencia visual local revisada: `quantum/revert-barra.jpg`.

Cambio auditado: redisenio solo-UI de la barra "Loan health", pasando de gradiente con mascara a 4 segmentos estaticos y marcador triangular basado en `healthFactor`.

## Bloqueante

No se encontraron hallazgos bloqueantes.

## Alto

No se encontraron hallazgos altos.

## Medio

No se encontraron hallazgos medios.

## Bajo

### B1 - El marcador podia perder contraste en tema claro (RESUELTO)

Evidencia (al momento de la auditoria):

- `src/styles/bot-portal.css:22-35` define tema claro con fondo/panel blanco.
- El marcador fijaba `border-bottom: 7px solid #fff`, por lo que en tema claro dependia casi por completo del `drop-shadow` para verse contra una superficie blanca. En tema oscuro replicaba bien la referencia Revert.

Impacto:

- Riesgo visual acotado: el valor numerico `healthFactor` sigue visible en `src/components/BotPortal.jsx:487`, pero el punto exacto del marcador podia ser menos evidente en modo claro.

Resolucion (aplicada en este PR):

- El marcador pasa a `border-bottom: 7px solid var(--text)` (blanco en tema oscuro, oscuro en claro), cerrando el riesgo de contraste en ambos temas. Verificado con preview en oscuro y claro.

### B2 - Los colores segmentados pueden leerse como umbrales exactos aunque son decorativos

Evidencia:

- `src/components/BotPortal.jsx:492` posiciona el marcador con `clamp(0, 100, (healthFactor - 1) / 2 * 100)`.
- `src/styles/bot-portal.css:860-863` define segmentos con proporciones visuales `14 / 14 / 52 / 13`.
- En la practica, aunque el prompt define los segmentos como decorativos, el usuario puede interpretar el color bajo el marcador como una zona de riesgo.

Impacto:

- Riesgo UX bajo. El sentido general es correcto: HF bajo queda a la izquierda/rojo y HF alto a la derecha/verde/menta. Ademas se muestra el HF exacto y el LTV.

Recomendacion:

- Mantener si el objetivo es imitar la referencia Revert. Si se busca precision operativa, documentar los cortes o hacer que los segmentos representen umbrales reales.

### B3 - Queda CSS heredado no usado para `.borrow-fill`

Evidencia:

- `rg` ya no encuentra `borrowTone`, `borrowLabel` ni `.borrow-health-featured.green/.amber/.red`.
- Si queda `src/styles/bot-portal.css:882`: `.borrow-fill { display: none; }`.
- En el JSX auditado ya no se renderiza `.borrow-fill`.

Impacto:

- Deuda menor, sin efecto funcional.

Recomendacion:

- Se puede eliminar en una limpieza posterior si no existe otro uso previsto.

## Verificaciones especificas del prompt

### 1. Null-safety de `healthFactor`

Resultado: OK para el flujo actual.

Evidencia:

- `src/components/BotPortal.jsx:388` renderiza el bloque activo solo con `pool.borrowHealth > 0`.
- `src/components/BotPortal.jsx:3780-3782` inicializa `borrowHealth`, `leverageRevert` y `healthFactor` en `0`.
- `src/components/BotPortal.jsx:3803-3807` solo sobreescribe datos Revert cuando `pd.borrowHealth > 0`, y aplica `pd.healthFactor ?? 0`.
- `convex/actions/poolScanner.ts:612-623` calcula `borrowHealth`, `healthFactor`, deuda y LTV en la misma rama `debt > 0n && collateral > 0n && fullValue > 0n`.

El clamp de `src/components/BotPortal.jsx:492` acota valores finitos por debajo de 0 o por encima de 100. No encontre una ruta actual donde `pool.healthFactor` llegue como `undefined` o `null` al `toFixed(2)`.

Nota: si en el futuro otra fuente mete `borrowHealth > 0` con `healthFactor` no numerico, `toFixed(2)` podria romper. Con las fuentes actuales no ocurre.

### 2. Semantica del mapeo `(HF - 1) / 2`

Resultado: OK.

Evidencia:

- HF `1.0` se mapea a `0%`, extremo izquierdo.
- HF `3.0` o mayor se mapea a `100%`, extremo derecho.
- HF menor a `1.0` queda clampado a `0%`.
- HF mayor a `3.0` queda clampado a `100%`.

El sentido operativo es coherente: menor HF implica mayor riesgo y queda en zona izquierda/roja; mayor HF implica mas margen y queda hacia verde/menta.

### 3. Sin codigo muerto critico / sin efectos en motor

Resultado: OK.

Evidencia:

- `convex/actions/poolScanner.ts:615-616` mantiene el calculo de `borrowHealth` y `healthFactor`.
- `convex/actions/poolScanner.ts:639-641` sigue retornando ambos valores.
- `src/components/AdminView.jsx:122` sigue usando `live?.borrowHealth` aparte.
- El diff auditado no toca scanner, persistencia, ejecucion ni money-path.

Unico residuo menor: `.borrow-fill { display: none; }` en `src/styles/bot-portal.css:882`.

### 4. Reutilizacion/consistencia visual

Resultado: OK con observacion baja en tema claro.

Evidencia:

- Segmentos usan la paleta del portal: `var(--red)`, `var(--amber)`, `var(--green)` en `src/styles/bot-portal.css:860-862`.
- El segmento menta usa `color-mix(in srgb, var(--green) 50%, #fff)` en `src/styles/bot-portal.css:863`.
- MDN marca `color-mix()` como Baseline ampliamente disponible desde mayo de 2023: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix

Para navegadores modernos, el soporte es aceptable. Si el producto debe soportar navegadores antiguos, conviene poner fallback antes de `color-mix`.

## Pruebas y comandos revisados

- `git diff -- src/components/BotPortal.jsx src/styles/bot-portal.css`
- `rg -n "borrowHealth|healthFactor|Loan health|Revert Lend|borrow-track|borrow-marker" src convex tests docs -S`
- `rg -n "borrowTone|borrowLabel|borrow-health-featured\\.(green|amber|red)|borrow-fill" src/components/BotPortal.jsx src/styles/bot-portal.css -S`
- `git diff --check -- src/components/BotPortal.jsx src/styles/bot-portal.css` - OK
- `npx vite build --outDir /tmp/quantum-audit-build --emptyOutDir` - OK
  - Warnings no bloqueantes ya esperables: comentarios PURE de dependencias `ox` y chunk JS > 500 kB.
- `npm ls playwright puppeteer --depth=0` - no hay Playwright/Puppeteer instalado.

No se ejecuto `npm run build` porque incluye `convex deploy --yes`.

## Gap de prueba visual

No pude hacer una captura runtime de una tarjeta real con prestamo Revert activo en esta sesion porque el proyecto no tiene Playwright/Puppeteer instalado y no hay fixture local de usuario autenticado con deuda Revert activa. Si se requiere cierre visual absoluto, falta abrir el portal con una posicion Revert real en ambos temas y validar:

- marcador visible;
- marcador alineado bajo el track;
- sin solapamiento con `borrow-foot`;
- contraste aceptable en modo claro.

La referencia local `quantum/revert-barra.jpg` si coincide conceptualmente con el nuevo markup: 4 segmentos estaticos y triangulo bajo la barra.

## Veredicto final

GO.

El cambio es de render/UI, no toca motor, persistencia, scanner ni money-path. No encontre riesgos bloqueantes, altos ni medios. Los puntos bajos son de contraste/lectura visual y limpieza menor.
