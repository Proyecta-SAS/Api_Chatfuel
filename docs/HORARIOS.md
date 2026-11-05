# Horarios separados — actualizado en V1.0.9

La agenda elige el primer y el último inicio libre del día y franja elegidos,
y el hueco libre más cercano al punto medio entre ellos. Las opciones se
ordenan de menor a mayor y proceden de la consulta real de disponibilidad.

Por ejemplo, si Bitrix ofrece 08:30, 09:00, 10:40 y 11:20, se muestran 08:30,
10:40 y 11:20. No se ofrecen horas ocupadas ni se inventan horarios fijos.
Un mismo inicio no se repite aunque esté disponible con dos asesores.

Entre las opciones ofrecidas se deja al menos un intervalo libre de diez
minutos después de cada llamada. Si quedan solo 08:30, 09:00 y 09:30,
se ofrecen 08:30 y 09:30; si
quedan solo dos horas consecutivas, se ofrece una. La duración de cada llamada
es de treinta minutos. Un inicio debe caber completo en la franja y en la
disponibilidad real del asesor. Esto no bloquea otros huecos del calendario.

Elegir un horario sigue sin reservarlo: se pide confirmación explícita y la
API vuelve a validar la disponibilidad al crear la cita. Pedir más opciones
excluye los horarios que ya se mostraron.

Las opciones de diez minutos aún sin reservar se consultan de nuevo y requieren
otra elección y confirmación. Las citas anteriores conservan su duración;
recuperarlas por su clave nunca las amplía ni crea otro evento.
