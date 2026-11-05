# Agenda propia y vinculación — V1.0.7

Desde V1.0.9 las nuevas llamadas duran 30 minutos. La consulta de huecos,
validación de solapamientos, creación de evento y confirmación usan esa duración.
Una opción antigua aún sin reservar se vuelve a presentar con disponibilidad
actual y necesita confirmación nueva. Una reserva existente conserva su intervalo
original y se recupera con la misma clave sin crear otro evento.

Desde V1.0.8, `/registrar-cliente` prioriza **TELÉFONO CLIENTE (DEF)**
(`UF_CRM_1584616588730`) de la negociación. El teléfono del contacto vinculado
solo se usa cuando ese campo está vacío. Un valor no vacío inválido se rechaza
para evitar vincular por accidente el número de otra persona. Se conserva el
contacto y no se alteran los campos de Bitrix durante el registro.

`src/calendar/service.js` integra perfiles, disponibilidad, reservas y sincronización.
Se ejecuta dentro de Api_Chatfuel con su MySQL. Bitrix24 es el proveedor de calendario.

Antes de reservar, se compara el teléfono completo con `clientes`, reconociendo
móviles colombianos con o sin 57 y su formato. Una coincidencia fija negociación
y etapa `C370:EXECUTING`. Sin coincidencia reserva sin vínculo. Ante ambigüedad pide
revisión humana; un error MySQL permite reintentar sin fingir que el cliente no existe.

El servicio verifica el embudo 370 y el teléfono antes de enviar `crm_fields: ["D_ID"]`
a `calendar.event.add`. Guarda la confirmación local antes de actualizar la etapa,
y verifica el cambio con `crm.deal.get`.

En V1.0.7 lee el evento con `calendar.event.getbyid`, comprueba ID, horario,
zona, marcador y dueño del calendario. Actualiza `STAGE_ID` y `ASSIGNED_BY_ID`
juntos y comprueba ambos campos. El responsable corresponde al asesor disponible
al confirmar, aunque difiera del que se ofreció inicialmente.

Los pendientes quedan en `chatfuel_citas.respuesta.crmSync`; un trabajador los
revisa cada 30 segundos con espera progresiva entre intentos y máximo de ocho.
No crea eventos ni repite citas. Cambios manuales, eventos modificados o reservas
posteriores requieren revisión y detienen el reintento automático. Las filas
importadas conservan su contrato anterior.

La firma vence a los 30 minutos para impedir reservar con una selección vieja.
Una pausa no borra el perfil: se recupera la franja y se consulta disponibilidad
actual. Las fechas, horas y confirmaciones vencidas se presentan nuevamente;
una reserva ya confirmada se recupera desde MySQL sin crear otro evento.

## Persistencia e idempotencia

La clave de reserva conserva contacto, cliente, horario y asesor. Los reintentos
también deben conservar vínculo, duración y horario. MySQL bloquea por clave y día
para impedir solapamientos dentro de este servicio y vuelve a consultar Bitrix.
Otros sistemas pueden modificar Bitrix concurrentemente: no existe una transacción
distribuida que garantice exclusión global entre aplicaciones distintas.

La fila `pending` se confirma en MySQL antes de crear el evento externo. Si se pierde
la respuesta, conserva esa fila y el horario ocupado. Un reintento busca un único
evento con `CHATFUEL_APPOINTMENT:UUID`, mismo propietario e intervalo. Si no puede
verificarlo, pide revisión y no crea otro evento, incluso tras reiniciar el proceso.

Un error de etapa conserva la cita con `crmSync.status: pending`. El reintento solo
sincroniza CRM. Si otra acción cambió la etapa desde la reserva, no la sobrescribe.
Los comentarios se reclaman antes de enviarlos; un envío incierto queda pendiente
de revisión y no se repite automáticamente. No se recrea la negociación.

## Sesiones anteriores

Se conservan secreto firmado, IDs de asesores y atributos del flujo. Las selecciones
anteriores se incorporan al perfil local al continuar. Las citas importadas conservan
ID, evento y clave de idempotencia. Una reserva antigua en curso sin fila importada
se protege para revisión; nunca se recrea a ciegas.

Referencias oficiales: [crear evento](https://apidocs.bitrix24.com/api-reference/calendar/calendar-event/calendar-event-add.html)
y [recuperar eventos](https://apidocs.bitrix24.com/api-reference/calendar/calendar-event/calendar-event-get.html).

La validación de fechas usa `DATE_FROM` con `TZ_FROM`, según la
[documentación del evento](https://apidocs.bitrix24.com/api-reference/calendar/calendar-event/calendar-event-get-by-id.html).
