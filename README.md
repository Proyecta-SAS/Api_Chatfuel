# Api_Chatfuel — V1.0.12

Servicio propio de Chatfuel con **MySQL y conexión directa a Bitrix24**.
El registro, perfiles, disponibilidad, reservas y cambios de etapa se resuelven
en este proyecto. No necesita la API, base de datos ni carpeta de AI-First-One.

```text
WhatsApp → Chatfuel → Api_Chatfuel → Bitrix24
                          ↓
                        MySQL
```

## Funciones

- `/registrar-cliente?id=...` consulta la negociación y guarda su contacto en MySQL.
- Conserva el consentimiento, franja, dos días y hasta tres horarios separados.
- Consulta `calendar.accessibility.get` y reparte llamadas de treinta minutos según disponibilidad y carga.
- Busca la negociación por teléfono completo en `clientes` antes de reservar.
- Crea el evento con `calendar.event.add` y `crm_fields: ["D_ID"]` si encuentra una coincidencia.
- Guarda la cita confirmada antes de mover la negociación a `C370:EXECUTING`.
- Verifica el evento creado y actualiza etapa, responsable y fecha de asesoría juntos, con el dueño y horario reales del calendario.
- Persiste fallos de sincronización y reintenta cada 30 segundos, sin volver a crear citas.
- Retoma consultas pausadas: conserva datos y franja y vuelve a verificar horarios vencidos antes de reservar.
- Sin registro del teléfono, reserva sin vincular ni cambiar negociaciones.
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

Después del push, `/health` debe indicar `version: "1.0.12"` y
`calendar.independent: true`. La carpeta temporal `AI-First-One/` está excluida
de Git y Docker y se puede eliminar: no forma parte del arranque ni de las pruebas.

Ver [migración](docs/MIGRACION.md), [Railway](docs/RAILWAY.md),
[vinculación](docs/VINCULACION-CITAS.md) y [pruebas WhatsApp](docs/PRUEBAS.md).
