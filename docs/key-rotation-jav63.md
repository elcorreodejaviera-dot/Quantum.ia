# Rotación de la clave de cifrado de credenciales HL (JAV-63)

> Las credenciales HL son **private keys que firman órdenes reales**. La credencial viva en
> producción (cuenta Protector, bot operando) DEBE seguir descifrando en todo momento.

## Modelo

- `HL_CREDENTIALS_ENCRYPTION_KEY` = clave **legacy** (id `"legacy"`). Sin cambiarla, todo sigue igual.
- `HL_CREDENTIALS_KEYRING` (opcional) = JSON `{"<id>":"<secreto>"}` con claves adicionales.
- `HL_CREDENTIALS_ACTIVE_KEY_ID` (opcional) = id con el que se **cifra** lo nuevo (default `"legacy"`).
- Cada credencial guarda `keyId` (ausente = `"legacy"`). `decryptPrivateKey` resuelve la clave por ese id.
- Cada secreto pasa por `sha256` → clave de 32 bytes (igual que el cifrado original).

**Default (sin keyring/active):** comportamiento 100% idéntico al actual.

## Procedimiento seguro de rotación (orden obligatorio)

1. **Deploy del código** con solo `legacy` activo (sin keyring ni active id). Verifica que todo opera igual.
2. **Provisionar** `HL_CREDENTIALS_KEYRING={"v2":"<nuevo-hex-32-bytes>"}` **manteniendo** `HL_CREDENTIALS_ENCRYPTION_KEY` (legacy).
3. **Verificar** que la credencial viva todavía descifra con legacy (p.ej. una ejecución/lectura del bot, o `reencryptCredentials` con `limit: 0` no debería ser necesario; basta confirmar operación normal).
4. **Setear** `HL_CREDENTIALS_ACTIVE_KEY_ID=v2`.
   - ⚠️ NO apuntar a un id ausente del keyring → falla-cerrado al cifrar/re-cifrar (no rompe el decrypt legacy, pero bloquea nuevas conexiones/rotación hasta corregir).
5. **Ejecutar** la re-encriptación por lotes:
   `node node_modules/convex/bin/main.js run hlCredentialActions:reencryptCredentials '{"limit":50}'`
   Repetir hasta que `reencrypted: 0` (todo en la clave activa). Es idempotente (salta lo ya activo) y fail-isolated por credencial.
6. **Verificar** ejecución/decrypt de la cuenta viva tras la rotación.
7. **Mantener** la clave legacy en env hasta confirmar estabilidad y cerrar la ventana de rollback. Recién entonces se puede retirar.

## Notas

- No correr dos rotaciones con distintos `ACTIVE_KEY_ID` en paralelo (no hay CAS sobre el ciphertext leído).
- `reencryptCredentials` es `internalAction` (solo CLI/admin, no expuesto a clientes).
- El `patch` de `ciphertext+iv+authTag+keyId` es atómico; si falla decrypt/encrypt/update, cuenta `failed` y no corrompe el registro.
