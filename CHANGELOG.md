# V1.0.22 - 2026-11-09

- Sincroniza los descartes confirmados a NO APLICA CHATFUEL, también cuando el diálogo termina antes de ofrecer una cita.
- Conserva negociaciones con cita, reservas pendientes, teléfonos sin verificar y etapas de otros canales.
- Persiste los traslados pendientes y reintenta con espera progresiva; una corrección de los datos cancela el descarte pendiente.

# V1.0.16 - 2026-11-06

- Reconoce solicitudes coloquiales y preguntas sobre la capacidad de agendar, incluso con captura de intención pendiente.
- Acepta una jornada tras una invitación y explica los horarios reales cuando se pide atención nocturna.
- Refuerza que la agenda externa sí está disponible y evita negar el servicio o remitir al mismo canal.
- No reproduce mensajes antiguos al actualizar el enrutamiento; mantiene elección y confirmación antes de reservar.

# V1.0.15 - 2026-11-06

- Muestra «reducción de crédito hipotecario» en lugar de la sigla interna en mensajes de descarte, explicaciones y FAQ del cliente.
- Conserva las reglas de elegibilidad y la asignación interna de citas.

# V1.0.14 - 2026-11-06

- Usa «con un asesor» en invitaciones, coordinación, confirmaciones y FAQ del cliente.
- Conserva a Tatiana Chilito como única asesora habilitada internamente para nuevas citas.

# V1.0.13 - 2026-11-06

- Aplica la guía RCH aprobada: banco, reportes negativos, capacidad de aumentar cuota, plazo original y tiempo pagando.
- Clasifica APLICA, NO APLICA y PENDIENTE sin scoring numérico; exige más de cinco años restantes para nuevas reservas.
- Bloquea reservas descartadas o incompletas y ofrece el mensaje del motivo concreto sin inventar datos.
- Reconoce aceptación de asesoría virtual y actualiza el resumen de perfilamiento, instrucciones, capturas y FAQ.
- Conserva Tatiana como única asesora, duración de 30 minutos y citas anteriores; recuerda PDF completo y participación de titulares.

# V1.0.12 - 2026-11-06

- Limita las nuevas citas de Chatfuel a Tatiana Chilito mediante el grupo configurado en Railway.
- Si una opción anterior pertenecía a un asesor retirado, consulta horarios nuevos y pide otra elección y confirmación.
- Conserva las citas existentes y no habilita asesores adicionales como respaldo.

# V1.0.11 - 2026-11-05

- Guarda FECHA Y HORA ASESORIA (DEF) con el inicio de la cita confirmada en Bitrix.
- Verifica fecha, etapa y responsable; recupera fallos sin crear otra reserva.
- Conserva cambios manuales de fecha durante un reintento y compara zonas horarias por el instante real.

# V1.0.10 - 2026-11-05

- Integra la agenda de 30 minutos de V1.0.9 con el resumen y feedback.
- Conserva la vinculación por TELÉFONO CLIENTE (DEF) incorporada en V1.0.8.
- Guarda el feedback completo en RESUMEN DE LA NEGOCIACION (DEF) y verifica su escritura.
- Organiza el comentario del timeline con títulos en negrita, secciones y saltos de línea.
- Incluye datos, intereses, análisis, próximos pasos y pendientes sin inventar conclusiones.
- Deduplica comentarios y permite reintentar errores de guardado del resumen.

# V1.0.9 - 2026-11-05

- Ofrece y reserva nuevas llamadas de 30 minutos, respetando ocupación y horario de cierre.
- Conserva horarios separados y exige confirmación nueva para opciones antiguas de 10 minutos.
- Recupera reservas anteriores sin ampliar su duración ni duplicar eventos.
- Alinea los mensajes de agenda y la configuración de conversación con la nueva duración.

# V1.0.8 - 2026-11-05

- Vincula la negociación usando TELÉFONO CLIENTE (DEF) cuando esté informado.
- Conserva el teléfono del contacto como respaldo solo si ese campo está vacío.
- Rechaza valores inválidos sin asociar el número de otra persona.

# V1.0.7 - 2026-11-05

- Conserva la agenda independiente incorporada por Juan-David-A-C en V1.0.6.
- Actualiza responsable y etapa según el dueño verificado de la cita creada.
- Verifica ambos campos y recupera pendientes desde MySQL sin duplicar eventos.
- Respeta reasignaciones humanas y detiene reintentos ante eventos modificados.
- Retoma consultas pausadas automáticamente y vuelve a validar horarios vencidos.
- Recupera citas confirmadas después de vencer la sesión, sin generar otra reserva.

# V1.0.6 - 2026-11-05

- Integra perfiles y agenda en este servicio con Bitrix directo y MySQL propio.
- Elimina llamadas y credenciales obligatorias de la API externa AI-First-One.
- Conserva asesores, horarios, confirmación y vínculo de negociación a C370:EXECUTING.
- Persiste reservas pendientes antes de enviar y recupera respuestas perdidas sin duplicar eventos.
- Migra perfiles y citas existentes; protege reservas antiguas inciertas.
- Excluye la carpeta de referencia de Git, pruebas y construcción.

# V1.0.5 - 2026-11-05

- Reintenta hasta tres veces las consultas seguras ante fallos temporales, con un máximo de ocho segundos por consulta.
- Captura también los errores asíncronos del perfilamiento y de la consulta de horarios.
- Distingue una consulta fallida de una reserva que requiere verificación y conserva los datos para retomar.
- Mantiene la confirmación explícita, las claves de idempotencia y la protección ante reservas inciertas.
- Registra causas técnicas acotadas sin credenciales ni datos del cliente.

# V1.0.4 - 2026-11-05

- Busca en MySQL el teléfono antes de reservar y vincula su negociación al evento de calendario.
- Solicita `C370:EXECUTING` solo después de confirmar la cita; sin registro conserva el flujo anterior.
- Normaliza teléfonos colombianos y pide revisión si existen varias negociaciones para el mismo número.
- Fija el vínculo en los reintentos y conserva citas confirmadas si queda pendiente el cambio de etapa.
- Mantiene la recuperación de mensajes incorporada en V1.0.3.

# V1.0.1

- Ofrece horarios libres más separados dentro de la franja seleccionada.
- Integra la agenda y el registro de clientes en `Api_Chatfuel`.
- Conserva MySQL como servicio separado y mantiene `/registrar-cliente`.

# Historial de cambios

## 1.0.0 - 2026-11-04

- Endpoint GET/POST `/registrar-cliente?id=...` para registrar clientes desde Bitrix24.
- Consulta de negociación y contacto principal: nombres, apellidos y teléfono.
- Persistencia en MySQL con creación automática de la tabla `clientes` y actualización sin duplicados por ID de negociación.
- Validación de solicitudes, manejo de errores y token de webhook opcional.
- Configuración de despliegue Railway y verificación de MySQL en `/health`.
- Pruebas de API y persistencia; instrucciones y variables de ejemplo.
