# Seguimientos de DalIA y Chatfuel

Implementación desactivada por defecto. El 18/11 se verificaron las seis
plantillas aprobadas y sus webhooks y se vincularon los flujos de botones.
La activación de producción requiere `FOLLOWUPS_ENABLED=true`; consultar el
estado real en `/followups/status` y conservar evidencia del corte de activación.

## Programación y persistencia

Desde V1.0.49 también se detiene el seguimiento cuando el bot ya comunicó que
no puede continuar el perfilamiento por alcance. Este es un cierre operativo;
no añade ni modifica hechos financieros del cliente. Una pregunta posterior
de perfilamiento invalida ese cierre anterior para volver a evaluar el caso.

Desde V1.0.47 los envíos se permiten de 08:30 (inclusive) a 17:00 (exclusive),
hora de Colombia, todos los días. Se puede configurar la franja mediante
`FOLLOWUPS_SEND_FROM` y `FOLLOWUPS_SEND_UNTIL`. Fuera de la franja se conserva
el pendiente hasta la siguiente apertura, sin acumular envíos vencidos.
Las bajas, consultas de recibos y traslados confirmados siguen procesándose.
Un recibo con ID que tarde más de quince minutos se vuelve a consultar cada
quince minutos, sin repetir el envío. Un rechazo o un envío sin ID verificable
continúa en revisión. Los descartes explícitos del historial nativo detienen
los seguimientos aunque Fuely no haya guardado todavía ese dato del perfil.

El observador descubre negociaciones nuevas de las cinco campañas conocidas en
el embudo 370, posteriores a `FOLLOWUPS_ENROLL_AFTER`. Usa un cursor persistido
por ID y conserva candidatos que todavía no tienen bienvenida entregada. No
vuelve a recorrer todo el historial CRM en cada ciclo.

El primer envío de plantilla entregado o leído en la línea de origen fija la
hora inicial. Los pasos se programan a 1, 24 y 72 horas desde ese envío, no de
forma acumulada entre recordatorios. El ciclo del trabajador es de un minuto.
La bienvenida debe corresponder al ingreso actual del lead, evitando usar una
plantilla antigua del mismo número.

Desde V1.0.43, `FOLLOWUPS_INACTIVITY_ENABLED=true` incluye conversaciones que
respondieron y quedaron incompletas. Cada nueva respuesta invalida los pasos
anteriores. La siguiente pregunta entregada del bot fija un nuevo ciclo de
1, 24 y 72 horas. Mientras el bot no responda, no se envían recordatorios.
Las plantillas de seguimiento no reinician el reloj. Cada ciclo tiene su clave
de envío y conserva la evidencia previa. En Chatfuel se consultan también las
fechas y el remitente del historial nativo: Wasapi puede reflejar únicamente
las plantillas enviadas por su API. Un mensaje humano no inicia un ciclo.
DalIA usa from_id 25152 y Chatfuel 24020; deben verificarse al vincular las
automatizaciones de la cuenta. Nunca cambiar el país de un teléfono por inferencia.

La tabla `chatfuel_seguimientos` conserva estado y resultados por canal y
teléfono. No se reinscribe otra negociación del mismo contacto ni se reabre un
seguimiento cancelado. Un lock de MySQL serializa los trabajadores del contacto.
La intención de envío se persiste antes de llamar al webhook. Una respuesta
incierta queda en revisión, sin reenvío automático. Tras una interrupción se omiten
los pasos ya vencidos para evitar enviar varios mensajes juntos.

Cada paso consulta de nuevo Bitrix y Wasapi; en Chatfuel consulta también la
conversación, las capturas del perfil y el estado firmado de la agenda. Bajas,
descartes, citas, atención humana y cambios de responsable,
teléfono, embudo o etapa detienen el seguimiento. Una consulta incompleta no
autoriza el envío. Con el modo de inactividad apagado, cualquier respuesta
entrante cancela definitivamente los pendientes, como en la versión anterior.
Con ese modo encendido, una respuesta espera la próxima pregunta del bot.
La cancelación no borra su evidencia persistida.

La aceptación del webhook confirma solo que la automatización aceptó la solicitud.
No acredita entrega de WhatsApp. `FOLLOWUPS_WEBHOOK_ACCEPT_FIELD` identifica un
booleano true explícito de la respuesta; HTTP 200 con error no basta.

Para el endpoint `/app-whatsapp-automation/bitrix` de AtlasFlow, el adaptador
construye un POST JSON con `deal_id`, `uuid`, `from_id`, `numero_cel`, `etapa`
y `variables`. Resuelve `{{ID}}`, `{{TITLE}}` y el teléfono con los datos del
contacto verificado, sin ejecutar una URL con macros literales. Comprueba que
el `from_id` del enlace coincide con la línea del seguimiento y conserva la
etiqueta `etapa` elegida por el usuario. El UUID y remitente explícitos eligen
la plantilla y la línea; la etiqueta no cambia el canal del programador.

En AtlasFlow, `accepted:true` solo acredita recepción del webhook. El adaptador
exige una respuesta de envío Wasapi sin rechazos, y bloquea simulaciones,
respuestas parciales y errores de negocio aunque el HTTP sea 200. Esto sigue
siendo aceptación por Wasapi: la entrega al destinatario se verifica por separado.

Desde V1.0.41 se conserva el ID numérico del único mensaje aceptado, validando
teléfono y remitente de su recibo. Se consulta ese ID en el historial de la línea.
`sent` queda pendiente; solo `delivered` o `read` confirman entrega. La ausencia
de un recibo identificable o de confirmación durante 15 minutos requiere revisión.
Un estado `failed` detiene el seguimiento, conserva el código y no reenvía. Para
131049 se registra un límite mínimo de 24 horas antes de otro intento manual;
no se cambia la categoría ni el contenido de la plantilla para evadir el límite.

## Botones de respuesta rápida

Textos actuales: **Sí, me interesa** y **No, gracias**. También se reconocen los
borradores anteriores «Sí, quiero saber», «Sí, continuemos» y «Quiero retomar».
Un «Sí» o «No» aislado mantiene su interpretación financiera habitual.

Para Chatfuel, vincular exclusivamente esas respuestas al flujo que:

1. Llama por POST a `/followups/resume`, con Bearer `CHATFUEL_BOOKING_SECRET`.
2. Envía `{ "contactId": "<id WhatsApp del contacto>", "message": "<texto del botón>" }`.
3. Muestra `message` del resultado y finaliza esa rama. Un `human: "si"` conserva
   la atención humana; no devuelve el chat automáticamente a la IA.
4. Con respuesta positiva y sin protección, la siguiente respuesta del cliente
   continúa por el flujo normal de la IA, con el perfil conservado.

La URL del webhook de **envío** de la automatización y esta URL de **retorno** del
botón cumplen funciones distintas. Una plantilla de Meta por sí sola no conecta
estas acciones. El secreto permanece en la acción HTTP del flujo, no en el botón.
Los flujos personalizados requieren configuración del panel/GraphQL; la conexión
MCP disponible no expone su edición. Se vincularon el 18/11; comprobar que las
acciones publicadas conserven la URL, autenticación y mapeos correctos.

La respuesta positiva cancela los pendientes y vuelve a preguntar únicamente el
filtro faltante. Con perfil completo ofrece la invitación a agenda, sin reservar.
Una gestión humana o cita anterior queda protegida. «No, gracias» cancela los
pendientes y guarda `seguimiento_detener=si`; no escribe un «no» financiero.

En DalIA el retorno entra por su webhook normal. El cambio paralelo del motor
normaliza botones de Meta y protege los filtros; el botón negativo aplica la
pausa de seguimiento existente. Desplegar ese cambio antes de activar los envíos.

`POST /followups/cancel` permite cancelar inmediatamente desde un evento de
respuesta o de atención humana, con el mismo Bearer y `{channel,phone}`.
El observador revalida también estas condiciones antes del envío.
`GET /followups/status` muestra estado técnico sin teléfonos ni secretos.

## Gestión después de 72 horas

Justo al confirmar la entrega del tercer envío, el trabajador cambia a la etapa
«SIN RESPUESTA 3 DÍAS», sin agregar otra espera. La comprobación de ausencia de
respuesta se realiza antes del envío. Los dos IDs de destino se verifican contra
la configuración existente de asesores. Mueve etapa y responsable juntos, alternando el equipo con un
contador MySQL transaccional. No sobrescribe una reasignación humana.

Si Meta rechaza el mensaje no se mueve la etapa. Si Bitrix falla después de la
entrega, se retoma solo la gestión CRM. No vuelve a enviar el tercer
mensaje. Una escritura ya aplicada se reconoce por etapa y responsable leídos.
Un clic posterior a la asignación mantiene la gestión humana.

## Vinculación y activación pendientes

- Copiar nombres/idioma e IDs de las plantillas aprobadas de las WABA correctas.
- Recibir y revisar cada URL de automatización y su contrato de solicitud y
  respuesta. Puede haber tres URLs compartidas que acepten la línea o seis URLs
  si cada automatización pertenece a una línea fija.
- Configurar payload real con `{{phone}}`, `{{fromId}}` y, cuando aplique,
  `{{name}}`, `{{template}}`, `{{hours}}`, `{{dealId}}`, `{{idempotencyKey}}`.
- Verificar el prefijo de contactos, las etapas y los usuarios de destino.
- Vincular la rama de cada botón en Chatfuel; desplegar el guard de DalIA.
- Probar con un contacto de prueba identificado, incluida entrega y retorno de
  ambos botones. Las pruebas unitarias no sustituyen esta comprobación.
- Publicar ambas revisiones y activar con fecha de inscripción explícita y
  `FOLLOWUPS_TEMPLATES_APPROVED=true`. No reactivar masivamente leads históricos.

## Comprobación local

`npm run check`, `npm test` y `git diff --check`.
Los servicios de los tests están simulados; no envían WhatsApp ni modifican CRM.
Las pruebas MySQL existentes requieren `TEST_MYSQL_URL` de una base de prueba.
