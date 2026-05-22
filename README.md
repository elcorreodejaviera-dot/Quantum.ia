# Quantum.ia

Portal web para monitorear pools de liquidez, posiciones spot y bots de cobertura.

Dominio objetivo:

```text
https://www.portal-quantum.com
```

## Ejecutar localmente

```bash
npm run dev
```

Abrir:

```text
http://127.0.0.1:4173/
```

Credenciales actuales del prototipo:

```text
Usuario: admin
Contraseña: Javier1934!
```

## Rutas

- `/` abre el portal principal.
- `/bot-portal.html` redirige internamente al portal principal para compatibilidad.
- `/health` expone el health check para Railway.

## Publicar en Railway

1. Sube este repositorio a GitHub.
2. En Railway crea un nuevo proyecto desde GitHub.
3. Selecciona este repositorio.
4. Railway detectará `package.json` y ejecutará `npm start`.
5. El health check usará `/health`.

No necesitas configurar `PORT`; Railway lo asigna automáticamente.

## Dominio personalizado

En Railway agrega el dominio:

```text
www.portal-quantum.com
```

Luego configura el DNS del dominio con el registro que Railway indique. Normalmente será un `CNAME` para `www`.
