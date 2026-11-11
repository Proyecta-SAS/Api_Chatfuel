# Api_Chatfuel — V1.0.32

Servicio propio de Chatfuel con **MySQL y conexión directa a Bitrix24**.
El registro, perfiles, disponibilidad, reservas y cambios de etapa se resuelven
en este proyecto. No necesita la API, base de datos ni carpeta de AI-First-One.

```text
WhatsApp → Chatfuel → Api_Chatfuel → Bitrix24
                          ↓
                        MySQL
```

## Funciones

- La IA realiza las cinco preguntas de la guía RCH del 6 de noviembre de 2026.
- Recupera aceptaciones repetidas después de «revisemos los horarios» cuando existe una invitación aceptada. Informa la fecha de una cita registrada, incluso si venció el estado conversacional; si ya pasó, pregunta antes de preparar una nueva. Las futuras o inciertas siguen protegidas.
- Una negociación verificada como eliminada en Bitrix conserva su referencia histórica y deja de bloquear el perfil o los horarios. Las nuevas citas no se vinculan a ese ID inexistente; los errores de permisos y los teléfonos ambiguos mantienen sus protecciones.
- Reconoce peticiones de consultar horarios como «me gustaría ver otro horario», «quiero otra cita» y «revisemos otros horarios» para retomar la agenda. Ver opciones no confirma una reserva; las negativas y condiciones no se toman como aceptación.
- Acepta afirmaciones como «sí, me gustaría», «de acuerdo», «me parece bien», «dale» y «listo» al responder a una invitación de cita. Un sí a una pregunta financiera no acepta agenda.
- Recupera respuestas como «sí podría», correcciones consecutivas y el banco actual de campaña sin sustituirlas por cortesías. Retoma la agenda aceptada cuando se aclara un filtro pendiente.
- Rechaza entidades/productos excluidos, reportes negativos, falta de capacidad y cinco años o menos restantes.
- Conserva PENDIENTE para datos desconocidos; pide únicamente el filtro faltante y bloquea horarios y reservas hasta confirmar APLICA.
- Mueve los descartes determinísticos a `NO APLICA CHATFUEL` (`C370:UC_ELJQDE`), incluso si no se solicita una cita.
- Verifica teléfono, embudo y etapa de origen; conserva citas y cambios manuales. Persiste fallos y los reintenta sin enviar mensajes.
- Recupera las últimas respuestas explícitas sobre tiempos antes de agendar y sustituye capturas antiguas.
- Sincroniza también los descartes explícitos de la conversación aunque la captura automática esté incompleta, incluidos libranza y producto no hipotecario. No usa mensajes del bot como evidencia.
- Los resúmenes identifican Chatfuel y distinguen descarte, perfilamiento, atención humana y solicitud de agenda; un descarte no se presenta como una cita pendiente. Las cortesías no duplican la sincronización del mismo perfil descartado.
- Conserva el texto original en MySQL y envía a Bitrix una representación compatible sin emojis de cuatro bytes, para evitar resúmenes truncados. La actualización de NO APLICA se ejecuta independientemente del campo resumen.

- `/registrar-cliente?id=...` consulta la negociación y guarda su contacto en MySQL.
- Conserva el consentimiento, franja, dos días y hasta tres horarios separados. Acepta horas con dos puntos o punto, como `16:30`, `16.30` y `4.30 p. m.`, y pide confirmación antes de reservar.
- Consulta `calendar.accessibility.get` y reparte llamadas de treinta minutos según disponibilidad y carga.
- Busca la negociación por teléfono completo en `clientes` antes de reservar.
- Crea el evento con `calendar.event.add` y `crm_fields: ["D_ID"]` si encuentra una coincidencia.
- El resumen y comentario de Bitrix incluyen RESUMEN DE LA CITA: estado, fecha, hora de Colombia, duración, modalidad, asesor y evento. Tras confirmar, el observador actualiza ese feedback en su siguiente ciclo (cada 30 segundos), con reintentos persistidos y sin crear otra cita. Los cambios posteriores del perfil conservan la sección de la reserva. Para una cita vinculada, el feedback sigue su negociación original aunque cambie de embudo: verifica ID y teléfono y actualiza solo resumen y comentario, respetando etapa y responsable.\n- Guarda la cita confirmada antes de mover la negociación a `C370:EXECUTING`.
- Verifica el evento creado y actualiza etapa, responsable y fecha de asesoría juntos, con el dueño y horario reales del calendario.
- Persiste fallos de sincronización y reintenta cada 30 segundos, sin volver a crear citas.
- Retoma consultas pausadas: conserva datos y franja y vuelve a verificar horarios vencidos antes de reservar.
- Sin registro del teléfono, reserva sin vincular ni cambiar negociaciones.
- Antes de procesar una confirmación, sustituye el aviso de respaldo del flujo por una verificación en curso: si Chatfuel agota su espera, el cliente puede consultar el resultado con «continuar» sin elegir otro horario.
- Persiste la reserva pendiente antes de llamar a Bitrix; recupera respuestas perdidas sin crear otro evento.
- Conserva la atención por IA, transferencias a humanos y recuperación de mensajes sin asignar.

El perfil y resumen se guardan localmente. Una negociación registrada recibe el
feedback completo en `UF_CRM_1646852109830` (RESUMEN DE LA NEGOCIACION (DEF)) y un
comentario en el timeline con títulos en negrita, saltos de línea y secciones.
Incluye hechos recopilados, intereses, contexto, análisis, próximos pasos y datos
por confirmar; se basa en las respuestas registradas y no inventa objeciones ni resultados.
Se comprueba la escritura del resumen y se deduplican comentarios idénticos.
No se modifican las preguntas ni el scoring
del motor original; el nuevo scoring de 0 a 100 sigue fuera de alcance.

## Ejecutar

Node.js 24 o superior y MySQL. Copiar `.env.example` a `.env` y completar valores.

```powershell
npm ci
npm run check
npm test
npm start
```

Las tablas se crean al arrancar de forma idempotente; no se elimina `clientes`.
Para probar persistencia y concurrencia, definir `TEST_MYSQL_URL` con una instancia
**de prueba** y ejecutar `npm test`. Se crean bases aleatorias y se eliminan al terminar.
La suite simula Bitrix y Chatfuel: no crea citas ni envía WhatsApp reales.

## Variables

| Variable | Uso |
| --- | --- |
| `MYSQL_URL` | MySQL propio |
| `BITRIX_WEBHOOK_URL` | Webhook del portal con permisos CRM |
| `BITRIX_CALENDAR_WEBHOOK_URL` | Webhook del mismo portal con permisos calendar; opcional si el anterior ya los tiene |
| `APPOINTMENT_ADVISORS_JSON` | Lista de `{id, name, bitrixUserId}`; conservar IDs durante la migración |
| `CHATFUEL_BOT_ID` | Bot atendido |
| `CHATFUEL_API_TOKEN` | Credencial propia de Chatfuel |
| `CHATFUEL_BOOKING_SECRET` | Secreto de al menos 32 caracteres para HTTP y estados firmados |
| `CHATFUEL_BOOKING_FLOW_ID` | Flujo existente de agenda |
| `HANDOFF_SYNC_ENABLED` | Activa el observador |
| `INCOMING_RECOVERY_ENABLED` | Recupera mensajes pendientes cuando la plataforma lo permite |
| `APPOINTMENT_SAME_DAY_CUTOFF_HOUR` | Corte para ofrecer el mismo día; 12 por defecto |
| `REGISTRAR_CLIENTE_TOKEN` | Protección opcional del registro |
| `PORT` | Puerto HTTP; 3000 por defecto |

No hay variables obligatorias de otro CRM. Los atributos históricos `crm_30x_`
se conservan por compatibilidad con Chatfuel; ahora se resuelven en nuestro MySQL.

## Rutas y datos

| Método | Ruta | Autenticación |
| --- | --- | --- |
| GET | `/health` | Pública; estado y versión, sin datos personales |
| GET / POST | `/registrar-cliente?id=123` | Token opcional del registro |
| POST | `/booking` | `Bearer CHATFUEL_BOOKING_SECRET` |
| POST | `/sync-handoffs` | `Bearer CHATFUEL_BOOKING_SECRET` |

`/booking` conserva `{contactId, operation: "start" | "step"}` y su respuesta.
El calendario se llama dentro del proceso, sin una segunda API.
Tablas: `clientes`, `chatfuel_perfiles`, `chatfuel_citas`, `chatfuel_comentarios`.
Una cita incierta bloquea su intervalo hasta verificarse.

## Publicación

GitHub: `Proyecta-SAS/Api_Chatfuel`, rama `main`; cada colaborador usa su propia cuenta.
Servicio: https://apichatfuel-production.up.railway.app

Después del push, `/health` debe indicar `version: "1.0.32"` y
`calendar.independent: true`. La carpeta temporal `AI-First-One/` está excluida
de Git y Docker y se puede eliminar: no forma parte del arranque ni de las pruebas.

Ver [migración](docs/MIGRACION.md), [Railway](docs/RAILWAY.md),
[vinculación](docs/VINCULACION-CITAS.md) y [pruebas WhatsApp](docs/PRUEBAS.md).
