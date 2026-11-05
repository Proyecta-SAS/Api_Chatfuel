# Configuración de conversación y prueba de agenda

La configuración `rch-questions-v6-2026-11-04` agrega un saludo amable al
retomar y una nueva revisión cuando el cliente pide empezar de cero. Mantiene
el trato de usted, una pregunta por mensaje y el cuestionario RCH existente.
El banco, la cobertura, el saldo pendiente en dinero, los años pagando y las
cuotas vencidas conservan sus definiciones.

`config/chatfuel/rch-questions.json` es la referencia versionada. El prompt
se aplica en la automatización principal de Chatfuel y se verifica leyéndolo
de nuevo; desplegar el conector de Railway no publica ese prompt por sí solo.
Los ajustes de la plataforma y el servicio de agenda tienen ciclos distintos.

## Nueva revisión con un contacto usado

Chatfuel conserva el historial del contacto y no ofrece borrarlo o reiniciarlo,
según su documentación: https://chatfuel.com/docs/leads/can-i-clear-chat-history.
Una nueva revisión no equivale a eliminar ese historial ni garantiza que el
modelo no tenga acceso técnico a él: el prompt le indica que use solamente
las respuestas posteriores a la nueva solicitud.

Antes de limpiar los atributos de perfil de un contacto de prueba autorizado,
guardar una copia fuera de Git y comprobar que no haya una reserva pendiente
o confirmada. Conservar el identificador del cliente, las marcas de sincronización
y todos los datos de citas reales. No eliminar contactos, negociaciones,
conversaciones ni conexiones para ejecutar esta prueba.

El cliente inicia con «Hola, quiero empezar de cero». La IA debe saludar y
preguntar por el banco, sin reutilizar el banco ni otros datos anteriores.
Comprobar la respuesta real; una lectura correcta del prompt no valida por sí
sola el comportamiento del modelo.

## Prueba de agendamiento

1. Completar las preguntas RCH con datos proporcionados en la nueva revisión.
2. Aceptar la propuesta de una llamada o pedirla de forma natural.
3. Completar nombre, ciudad y obligación activa si faltan; no son requisitos
   del primer saludo.
4. Elegir franja, día y uno de los horarios consultados en Bitrix.
5. Confirmar expresamente la reserva del horario elegido.
6. Verificar el identificador del evento y la cita de treinta minutos en Bitrix,
   y que la misma negociación de Bitrix conserve el comentario del perfil nuevo.

La disponibilidad consultada no significa que exista una reserva. No crear
una cita de prueba automáticamente: la persona debe elegir y confirmarla.
Una reserva incierta necesita verificación antes de intentar otra.

El scoring nuevo de Chatfuel sigue pendiente. El motor y scoring original
de DalIA no forman parte de este cambio.

El prompt pide emojis pertinentes en saludos, agradecimientos y transiciones,
sin recargar los mensajes. El conector 2.1.18 los incorpora al ofrecer días
y horarios y al confirmar la reserva. Los mensajes de dificultad mantienen
un tono sobrio.

La amabilidad debe mantenerse en todas las respuestas: transiciones breves,
una explicación sencilla del siguiente dato y ausencia de preguntas aisladas
con tono de formulario. La pregunta de cobertura procede de P1 de la guía
RCH de marketing; se reformuló para ser más cercana, conservando su significado.

La versión 2.1.19 corrige la aceptación de una oferta de llamada cuando la IA
guarda la intención como pendiente: exige que la pregunta inmediatamente
anterior ofrezca organizar la llamada. Un sí al banco, nombre u otro dato no
activa la agenda. Conserva la deduplicación y no crea una reserva al aceptar
el ofrecimiento: primero hay que elegir y confirmar el horario.
