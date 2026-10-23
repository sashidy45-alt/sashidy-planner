# Notificaciones de Sashidy Planner

La campanita de la cabecera abre un panel compacto. Cada dispositivo tiene su propio permiso y preferencias; activar el celular no activa automáticamente la laptop.

- **Actividades con hora:** aviso automático aproximadamente 10 minutos antes, con título, fecha y hora prevista.
- **Actividades sin hora:** opción independiente; elige la hora del recordatorio del día programado. No se avisa por tareas sin fecha.
- **Probar aviso:** envía una notificación real únicamente al dispositivo actual.
- Tocar la notificación abre el día y, si está disponible localmente, el detalle de la actividad.
- Se utilizan las actividades guardadas en la sincronización de Upstash. Una edición sin conexión debe sincronizarse antes de que pueda modificar los avisos del servidor.

## 1. Publicación

Integrar esta rama en `main`. Vercel instalará las dependencias y ejecutará `npm run build`; `vercel.json` define `dist` como salida. Las funciones están en `api/`. El archivo fuente vigente es `src/app.html`; `index.html` es generado por `build.sh`. No editar las copias antiguas `src/app (1).html` o `src/src/app.html`.

## 2. Variables en Vercel (Producción)

Conservar las variables existentes de sincronización. No cambiar los códigos ni la base de datos.

| Nombre | Valor / procedencia |
|---|---|
| `KV_REST_API_URL` | URL REST de la base Redis existente en Upstash. |
| `KV_REST_API_TOKEN` | Token REST de esa misma base. |
| `ALLOWED_CODES` | Código(s) privado(s) de la agenda existente, separados por comas. |
| `VAPID_PUBLIC_KEY` | Clave pública generada para notificaciones. |
| `VAPID_PRIVATE_KEY` | Clave privada del mismo par. |
| `VAPID_SUBJECT` | Contacto del administrador en formato `mailto:correo@ejemplo.com`. |
| `APP_URL` | Dirección pública estable de la agenda, como `https://tu-agenda.vercel.app`; no la dirección del panel vercel.com. |
| `QSTASH_CURRENT_SIGNING_KEY` | Current Signing Key de QStash en Upstash. |
| `QSTASH_NEXT_SIGNING_KEY` | Next Signing Key de QStash en Upstash. |

Si ya generaste y guardaste las claves VAPID, reutiliza ese mismo par. No subir claves o tokens a GitHub. El token REST de Redis y las claves de firma QStash cumplen funciones diferentes.

Después de guardar variables, volver a desplegar la versión de Producción. El navegador solo recibe la clave VAPID pública; las claves privadas permanecen en las funciones del servidor.

## 3. Programación en Upstash QStash

Redis almacena la agenda; **QStash** ejecuta la comprobación aunque la agenda esté cerrada. Crear **un solo** schedule:

| Campo | Valor |
|---|---|
| Destino | `<APP_URL>/api/notification-dispatch` |
| Método | `POST` |
| Cron | `* * * * *` (cada minuto) |
| Content-Type | `text/plain` |
| Cuerpo | `tick` |
| Reintentos | 2 |

QStash añade automáticamente la firma. No usar `GET` ni un cron público sin autenticar. El destino debe coincidir exactamente con `APP_URL` y la ruta, sin redirecciones ni protección de vista previa. Las llamadas y cuotas de QStash dependen del plan de la cuenta; verificar que permita esta frecuencia antes de activar el schedule. No es necesario guardar `QSTASH_TOKEN` en Vercel para esta implementación: el schedule se crea desde la consola de Upstash.

Esperar uno o dos minutos. El panel de la campanita verifica si el servidor ha ejecutado el programador durante los últimos tres minutos. Si no hay ejecución reciente, muestra el aviso de configuración pendiente y no presenta el envío automático como operativo.

## 4. Activación por dispositivo

1. Abrir la agenda publicada y vincular la misma agenda mediante su código en Ajustes.
2. Abrir la campanita y activar **En este dispositivo**. Aceptar el permiso del navegador.
3. **Actividades con hora** queda activado por defecto; el anticipo es de 10 minutos.
4. Opcionalmente activar **Actividades sin hora**, elegir una hora y pulsar **Guardar**.
5. Pulsar **Probar aviso**. Repetir el proceso en celular y laptop.

En iPhone/iPad se requiere iOS/iPadOS 16.4 o posterior y abrir la agenda instalada mediante **Añadir a pantalla de inicio**. En los demás equipos se necesita un navegador compatible con Web Push. La visibilidad, el sonido y la pantalla bloqueada dependen del permiso del sistema, No molestar, conectividad y configuración del navegador. El envío es aproximadamente diez minutos antes: el programador revisa cada minuto y el sistema operativo puede demorar la entrega.

## Verificación final en Producción

- Probar recepción en ambos dispositivos, con la agenda cerrada.
- Crear una actividad para unos 12 minutos después y comprobar que llega el título y la hora prevista.
- Reprogramar, completar y eliminar actividades antes de su aviso; comprobar que no llegan avisos antiguos.
- Desactivar solo la laptop; comprobar que el celular continúa recibiendo.
- Comprobar actividades repetidas y la hora elegida para actividades sin hora.

## Implementación y límites

- Las preferencias y suscripciones se guardan en Redis por agenda y dispositivo (máximo 10 por agenda), separadas del documento de actividades.
- El proceso consulta la versión actual de la agenda antes de enviar. Genera repeticiones aun después de la ventana de 35 días del cliente y respeta excepciones y eliminaciones.
- Se usan firmas QStash, validación de destinos Web Push, permisos por código, bloqueos y marcas de envío por dispositivo. Los errores 404/410 eliminan suscripciones caducadas.
- Ventana de recuperación de tres minutos; no se envía una acumulación de avisos antiguos después de una interrupción prolongada.
- Se reduce la duplicación mediante bloqueos y marcas, pero ningún envío remoto puede garantizar exactamente una entrega ante una caída entre la aceptación del proveedor y el guardado de la marca.
- El proceso está pensado para esta agenda personal y pocos dispositivos; no es un sistema masivo de notificaciones.
- Cambiar las claves VAPID obliga a volver a activar los dispositivos. Desvincular la agenda intenta eliminar la suscripción antes de borrar el código local.

## Validación local

`npm ci` · `npm test` · `npm run build`

Las pruebas locales no sustituyen la recepción real en los dispositivos: se necesitan las variables privadas y el schedule de la cuenta. Ninguna clave privada ni suscripción real está incluida en este repositorio.
