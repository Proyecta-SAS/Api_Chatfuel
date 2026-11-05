# Api_Chatfuel

Este repositorio contiene exclusivamente la integración Chatfuel / MySQL / Bitrix.
La agenda es propia: no reintroducir dependencias de API, base de datos o archivos
de AI-First-One. La carpeta de referencia es temporal y está excluida de Git.
Conservar las preguntas y el scoring del motor original de DalIA cuando se
trabaje en este proyecto. Los cambios futuros de Chatfuel se realizan aquí.

- Leer README.md y docs/MIGRACION.md antes de cambiar el despliegue.
- Ejecutar `npm run check`, `npm test` y `git diff --check` al cambiar el conector.
- Publicar en `https://github.com/Proyecta-SAS/Api_Chatfuel`, rama `main`.
  Este es el destino indicado por el usuario para Git y Railway.
  Antes de cambiar el origen del servicio, comprobar que contenga la versión
  actual para evitar desplegar código antiguo.
  Pueden publicar los miembros y colaboradores que tengan
  permiso de escritura, incluido `Juan-David-A-C`. Cada persona usa su propia
  cuenta, autoría y credenciales; no exigir a un colaborador que inicie sesión
  con otra cuenta ni que cambie su identidad para poder subir cambios.
  Si un push falla, comprobar el remoto, la cuenta autenticada y el error real
  de GitHub antes de atribuirlo a una falta de permisos. `user.name` y
  `user.email` identifican la autoría del commit; no conceden acceso al remoto.
  Antes de crear commits, comprobar `gh api user --jq .login` y la identidad
  local de Git. Deben corresponder a la persona que publica en esa sesión.
  Si no coinciden, usar `scripts/configurar-autor-github.ps1 -Cuenta LOGIN`
  con la cuenta autenticada del colaborador; nunca atribuirle a otra persona
  los cambios ni reutilizar la identidad del propietario por estar guardada.
  Ver [docs/COLABORADORES.md](docs/COLABORADORES.md).
- Los tokens y datos de clientes se guardan fuera de Git. No copiar .runtime,
  archivos DPAPI, documentos de clientes ni volcados del proyecto anterior.
- Los simuladores no crean negociaciones ni citas. Una reserva real requiere
  elección del cliente y confirmación técnica de Bitrix.
- Al migrar, preparar el servicio nuevo con HANDOFF_SYNC_ENABLED=false y
  coordinar el cambio de URLs y del observador para evitar procesamiento doble.

## Publicaciones

Por preferencia expresa del usuario, escribir los mensajes de commit y las
etiquetas de versión en español, con versión y descripción breve. Formato:
`V1.0.1: Ofrece horarios libres más separados`.
Mantener la secuencia de versiones existente y asociar la etiqueta `Vx.y.z`
a la revisión publicada. No reescribir commits que ya se compartieron.

El usuario fijó expresamente `V1.0.1` para la publicación de horarios separados;
usar esta secuencia en las próximas versiones, en lugar de continuar 2.1.x.
