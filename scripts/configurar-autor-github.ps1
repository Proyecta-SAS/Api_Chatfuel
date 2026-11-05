[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*$')]
    [string]$Cuenta
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    $output = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Fallo $Command. No se completo la configuracion."
    }
    return $output
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    $origin = Invoke-Checked git @('remote', 'get-url', '--push', 'origin')
    if ($origin -notmatch '^(https://github\.com/|git@github\.com:)Proyecta-SAS/Api_Chatfuel(?:\.git)?/?$') {
        throw 'El remoto origin no corresponde a Proyecta-SAS/Api_Chatfuel. No se cambio la identidad.'
    }

    $account = (Invoke-Checked gh @('api', 'user')) | ConvertFrom-Json
    if ($account.login -ine $Cuenta) {
        throw "La sesion de GitHub CLI pertenece a $($account.login), no a $Cuenta. En tu computador, usa gh auth switch --hostname github.com --user $Cuenta si ya agregaste esa cuenta, o gh auth login --hostname github.com para iniciar sesion con ella. Despues repite este comando. No se cambio la identidad."
    }

    $permission = (Invoke-Checked gh @('api', "repos/Proyecta-SAS/Api_Chatfuel/collaborators/$($account.login)/permission")) | ConvertFrom-Json
    if ($permission.permission -notin @('write', 'maintain', 'admin')) {
        throw 'La cuenta autenticada no tiene permiso de escritura. No se cambio la identidad.'
    }

    $email = "$($account.id)+$($account.login)@users.noreply.github.com"
    if ($PSCmdlet.ShouldProcess('Este repositorio', "Configurar autor $($account.login) <$email> y credenciales HTTPS de su sesion gh")) {
        # Los valores locales no cambian la identidad de otros repositorios.
        # --% conserva el argumento vacio en Windows PowerShell 5.1.
        # El valor vacio descarta helpers heredados antes de elegir gh.
        & git --% config --local --replace-all credential.https://github.com.helper ""
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo configurar el acceso local a GitHub.' }
        Invoke-Checked git @('config', '--local', '--add', 'credential.https://github.com.helper', '!gh auth git-credential')
        Invoke-Checked git @('config', '--local', 'user.name', $account.login)
        Invoke-Checked git @('config', '--local', 'user.email', $email)
        Write-Output "Listo: los proximos commits de este repositorio usaran $($account.login) <$email>."
        Write-Output 'La publicacion HTTPS usara la sesion de GitHub CLI. No se modificaron commits anteriores ni se subieron cambios.'
    }
} finally {
    Pop-Location
}
