Write-Host "=========================================================="
Write-Host " MINDAL LAUNCHER"
Write-Host "=========================================================="
Write-Host ""

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$filePath = Join-Path $dir "payroll_app.html"

Write-Host "Script folder: $dir"
Write-Host "Looking for:   $filePath"
Write-Host ""

if (-not (Test-Path -LiteralPath $filePath)) {
    Write-Host "[ERROR] payroll_app.html was NOT found next to this script!" -ForegroundColor Red
    Write-Host "Make sure both files are in the same folder."
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host "[OK] payroll_app.html found."
Write-Host ""

# .NET's Uri class builds a correct file:// URL even when the path
# contains spaces or non-Latin (Cyrillic) characters - this is the
# part that cmd.exe consistently gets wrong.
$fileUri = ([System.Uri]$filePath).AbsoluteUri
Write-Host "File URL: $fileUri"
Write-Host ""

$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

Write-Host "Checking for installed browsers..."
foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { Write-Host "[found] $c" }
}
Write-Host ""

$browser = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $browser) {
    Write-Host "No Chrome/Edge found in standard install locations."
    Write-Host "Opening the file with Windows' default program instead..."
    Start-Process -FilePath $filePath
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 0
}

Write-Host "Using browser: $browser"
Write-Host ""
Write-Host "If a normal browser window opens at the homepage instead"
Write-Host "of the Mindal interface, the browser was probably already"
Write-Host "running and ignored the --app flag. Close ALL its windows"
Write-Host "(check the system tray near the clock too), then run this"
Write-Host "launcher again."
Write-Host ""

Start-Process -FilePath $browser -ArgumentList @("--new-window", "--app=$fileUri")

Write-Host "Command sent."
Write-Host ""
Read-Host "Press Enter to close this window"
