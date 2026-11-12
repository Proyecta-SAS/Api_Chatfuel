# Gestión de clientes - V1.0.34

Por solicitud expresa del usuario se replican en Chatfuel los tres cambios ya
aprobados: nueva pregunta de incremento mínimo, convenio con banco admitido y
felicitación seguida de la invitación a Zoom de 30 minutos. La insolvencia
queda pendiente y la instrucción de no ofrecer esa línea permanece vigente.

La configuración versionada en config/chatfuel/rch-questions.json conserva las
instrucciones leídas de producción, incluido el cierre de descartes sin insistir.
Se publica en la base de conocimiento y en el prompt principal que heredan los
canales WhatsApp; la captura de rch_puede_aumentar_cuota se actualiza por atributo.
No se habilitan canales ni se modifican la agenda nativa, el flujo ni el reparto
de asesores. El conector reconoce tanto aumentar como aumentando y mantiene
compatible la conversación iniciada con la pregunta anterior.

Un sí a la propuesta financiera no acepta una cita ni el criterio histórico
de aumentar más del 10 %. El interés condicionado y las dudas quedan pendientes.
Solo se felicita tras confirmar los cinco filtros. La reserva requiere elección
y confirmación técnica. Los ensayos usan simuladores y la vista previa de Chatfuel,
que no envía mensajes a clientes ni crea reservas reales.

La plataforma limita el prompt principal a 5000 caracteres y cada captura a 450.
Los textos finales se leyeron de vuelta y coinciden con la configuración versionada.
