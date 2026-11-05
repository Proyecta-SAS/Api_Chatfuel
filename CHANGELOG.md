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
