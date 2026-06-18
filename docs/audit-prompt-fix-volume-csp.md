# Prompt de auditoría (Codex) — fixes #3 (volume24h) + #4 (CSP Turnstile) — JAV-85

Audita el código (working tree). Dos fixes de correctness, NO money-path.

## #3 — `convex/admin.ts` getSystemStats volume24h
`execs24` ahora usa `.withIndex("by_created", q=>q.gte("createdAt", prevSince)).order("desc").take(SCAN_CAP)`
(antes sin `.order("desc")` → orden ascendente → tomaba las 1000 MÁS ANTIGUAS de la ventana de 48h → con
>1000 execs se perdían las de hoy → volume24h infra-contado / "-100%" falso).

Verifica:
1. ¿Con `.gte(prevSince).order("desc").take(SCAN_CAP)` se conservan correctamente las execs MÁS RECIENTES de
   la ventana [prevSince, now), y el filtro de rango sigue aplicando? ¿`addVol(notional, createdAt)` reparte
   bien en ventana actual/previa?
2. ¿Algún efecto en el delta si hay exactamente entre 1000 y 2000 execs (se perderían las más antiguas de la
   ventana previa → delta podría sobre-estimar)? ¿Aceptable vs el bug anterior? (el arms-scan sigue por by_updated.)

## #4 — `server.js` CSP
Añadido `https://challenges.cloudflare.com` a `script-src` y `frame-src` (Cloudflare Turnstile que usa Clerk
para bot-protection). Antes, con la CSP enforcing, si se activa bot-protection en Clerk el widget se bloquearía.

Verifica:
3. ¿`challenges.cloudflare.com` es el dominio correcto de Turnstile y basta en script-src + frame-src? ¿Falta
   algún otro (p.ej. connect-src ya es `https:` así que cubre)? 
4. ¿La CSP sigue bien formada (sin romper las demás directivas)?
