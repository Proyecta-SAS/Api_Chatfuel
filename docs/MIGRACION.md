# Migración a agenda propia — V1.0.6

V1.0.1 a V1.0.5 alojaban el conector en su propio servicio, pero todavía llamaban
a la API del proyecto de referencia. V1.0.6 elimina esa dependencia.

## Componentes trasladados

- Cálculo de huecos, zona Bogotá y selección por disponibilidad y carga.
- Resolución y persistencia de perfiles en MySQL propio.
- Reservas durables, bloqueo concurrente e idempotencia.
- Evento directo en Bitrix, vínculo de negociación y sincronización de etapa.
- Recuperación de solicitudes inciertas y comentarios deduplicados.

Los módulos derivados están en `src/calendar/`, adaptados a JavaScript Node 24.
No se copió el panel, Next.js, Postgres ni módulos ajenos. No hay imports ni llamadas
HTTP al proyecto anterior. La carpeta `AI-First-One/` es temporal y se puede eliminar.

## Preparación

- Proyecto Railway: `a8744968-739a-441f-ab07-eca9488a3830`.
- Servicio: `b15812dd-8735-45f3-9e31-086c4862c50b`.
- Entorno: `ac461721-7ee3-4600-9ed6-126a2d8b0d0a`.
- GitHub de destino: `Proyecta-SAS/Api_Chatfuel`, rama `main`.
- Dominio y acciones Chatfuel: `apichatfuel-production.up.railway.app`.

Se prepararon `APPOINTMENT_ADVISORS_JSON` y `BITRIX_CALENDAR_WEBHOOK_URL` como valores
propios, sin referencias a variables de otro proyecto y sin desplegar. Se verificó
la lectura directa de los dos calendarios sin crear eventos.

Se copiaron 6 perfiles y 3 citas confirmadas de Chatfuel a nuestro MySQL. El respaldo
está fuera de Git. `scripts/import-calendar.mjs` recibe JSON por stdin y conserva IDs;
repetirlo no duplica ni sobrescribe registros existentes. Un conflicto cancela la importación.

Mientras siga desplegada la versión anterior puede generar actividad posterior al
respaldo. Las reservas antiguas inciertas sin fila local se bloquean para revisión.
Antes de apagar el servicio remoto anterior, comprobar que no queden citas pendientes
de reconciliación. Borrar la carpeta local no apaga ni elimina el otro proyecto.

## Publicación

1. Ejecutar `npm run check`, `npm test` y `git diff --check`.
2. Crear commit y etiqueta V1.0.6; subir a `main`.
3. Esperar el despliegue exitoso y comprobar `/health`: V1.0.6,
   `calendar.independent: true`, MySQL y observador conectados.
4. Probar desde WhatsApp con horario elegido y confirmado por el cliente.
5. Las variables antiguas `AI_FIRST_ONE_BASE_URL` y `AI_FIRST_ONE_APPOINTMENTS_TOKEN`
   ya no se leen. Retirarlas después del despliegue: la versión anterior aún las usa.

No se cambia el motor ni las preguntas del otro proyecto. Las pruebas automatizadas
usan simuladores. Posteriormente se completó una reserva real con el horario elegido
por el usuario: evento vinculado, etapa verificada, persistencia MySQL y reintentos
sin duplicados. Se ejecutó el motor V1.0.6 aislado, sin desplegarlo para todos.
El endpoint HTTP reconoció la confirmación guardada en el contacto de prueba.
La entrega de mensajes por WhatsApp no forma parte de esa verificación.
El usuario realizará el commit y push; la verificación del despliegue queda pendiente.

## Respaldo histórico

El anterior `chatfuel-bitrix-booking` del proyecto DalIA quedó con observador
desactivado y no se elimina. Proyecto `f738779e-2840-495c-b09b-0c2597c814cd`, servicio
`ff561cac-0a81-4561-9aa6-661f0bcb537b`, entorno `4a4e8414-0996-48c2-977f-58678ae59d0e`.
Una reversión requiere coordinar observadores para evitar procesamiento doble.
