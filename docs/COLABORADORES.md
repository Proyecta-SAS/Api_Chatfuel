# Publicar con la cuenta de cada colaborador

El repositorio de destino es `Proyecta-SAS/Api_Chatfuel`. Cada colaborador con
permiso de escritura utiliza su propia cuenta de GitHub y firma sus commits
con su identidad. El nombre del propietario del repositorio no cambia.

## Configuración inicial en el computador del colaborador

Requiere Git y GitHub CLI (`gh`). Después de traer los archivos actualizados
del repositorio, Juan David ejecuta en PowerShell, desde la carpeta del proyecto:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configurar-autor-github.ps1 -Cuenta Juan-David-A-C
```

El comando comprueba el remoto, la cuenta autenticada y el permiso de escritura.
Si la sesión pertenece a otra persona, se detiene antes de cambiar la configuración
y explica cómo iniciar sesión con la cuenta correcta. No comparte credenciales.

Configura solamente este repositorio para usar la sesión de GitHub CLI en HTTPS
y firmar los próximos commits con el usuario autenticado y su correo privado
`ID+USUARIO@users.noreply.github.com`. No cambia las identidades de otros proyectos.
Para revisar sin aplicar cambios se puede añadir `-WhatIf`.

Después se utilizan los comandos habituales `git add`, `git commit` y
`git push origin main`. Para verificar la autoría antes de publicar:

```powershell
git log -1 --format="%h %an <%ae> %s"
```

La configuración no cambia la autoría de commits que ya existían. No reescribir
commits publicados para cambiar nombres. Tampoco cambia la cuenta de Railway
que realiza los despliegues: esa conexión se administra aparte.
