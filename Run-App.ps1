$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$backendPath = Join-Path $projectRoot "backend"
$frontendPath = Join-Path $projectRoot "frontend"
$venvPath = Join-Path $projectRoot ".venv"
$venvActivate = Join-Path $venvPath "Scripts\Activate.ps1"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$frontendUrl = "http://127.0.0.1:5173"
$backendHealthUrl = "http://127.0.0.1:8000/api/health"

function Test-Endpoint {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

function Wait-ForEndpoint {
    param(
        [string]$Uri,
        [string]$ServiceName
    )

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-Endpoint -Uri $Uri) {
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "$ServiceName did not become ready at $Uri. Check its PowerShell window for errors."
}

function Start-AppTerminal {
    param(
        [string]$Title,
        [string]$WorkingDirectory,
        [string]$Command
    )

    $safeTitle = $Title.Replace("'", "''")
    $safeWorkingDirectory = $WorkingDirectory.Replace("'", "''")
    $terminalScript = "Set-Location -LiteralPath '$safeWorkingDirectory'; `$Host.UI.RawUI.WindowTitle = '$safeTitle'; $Command"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($terminalScript))
    Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList @(
        "-NoExit",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedCommand
    ) | Out-Null
}

if (-not (Test-Path $venvPython)) {
    $pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pythonLauncher) {
        & $pythonLauncher.Source -3 -m venv $venvPath
    }
    else {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if (-not $pythonCommand) {
            throw "Python 3.10 or newer is required. Install Python and run this launcher again."
        }
        & $pythonCommand.Source -m venv $venvPath
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the Python virtual environment."
    }
}

if (-not (Test-Path $venvPython)) {
    throw "The Python virtual environment was not created at $venvPath."
}

if (-not (Test-Path $venvActivate)) {
    throw "The virtual environment activation script was not found at $venvActivate."
}

. $venvActivate

$pythonVersion = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0 -or [version]$pythonVersion -lt [version]"3.10") {
    throw "Python 3.10 or newer is required. The selected interpreter is Python $pythonVersion."
}

Write-Host "Installing backend dependencies into $env:VIRTUAL_ENV..."
& python -m pip install --disable-pip-version-check -r (Join-Path $backendPath "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Backend dependency installation failed. Check your internet connection and the Python package output above."
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    throw "Node.js 20 or newer (including npm) is required. Install Node.js and run this launcher again."
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Node.js 20 or newer is required. Install Node.js and run this launcher again."
}
$nodeVersion = & $nodeCommand.Source -p "process.versions.node"
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]"20.0") {
    throw "Node.js 20 or newer is required. The selected version is Node.js $nodeVersion."
}

if (-not (Test-Path (Join-Path $frontendPath "node_modules\vite\bin\vite.js"))) {
    Write-Host "Installing frontend dependencies..."
    Push-Location $frontendPath
    try {
        & $npmCommand.Source install
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend dependency installation failed."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Endpoint -Uri $backendHealthUrl)) {
    $safeActivatePath = $venvActivate.Replace("'", "''")
    $backendCommand = ". '$safeActivatePath'; python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000"
    Start-AppTerminal -Title "AMD Chatbot Backend" -WorkingDirectory $projectRoot -Command $backendCommand
}

if (-not (Test-Endpoint -Uri $frontendUrl)) {
    $safeNpmPath = $npmCommand.Source.Replace("'", "''")
    $frontendCommand = "& '$safeNpmPath' run dev -- --host 127.0.0.1"
    Start-AppTerminal -Title "AMD Chatbot Frontend" -WorkingDirectory $frontendPath -Command $frontendCommand
}

Write-Host "Waiting for the backend and frontend to start..."
Wait-ForEndpoint -Uri $backendHealthUrl -ServiceName "Backend"
Wait-ForEndpoint -Uri $frontendUrl -ServiceName "Frontend"
Start-Process $frontendUrl
Write-Host "AMD Chatbot is open at $frontendUrl"
