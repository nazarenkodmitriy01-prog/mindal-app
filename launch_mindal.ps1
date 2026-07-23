Add-Type -AssemblyName System.Windows.Forms

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$filePath = Join-Path $dir "payroll_app.html"

if (-not (Test-Path -LiteralPath $filePath)) {
    [System.Windows.Forms.MessageBox]::Show(
        "payroll_app.html not found next to the launcher ($dir).",
        "Mindal Launcher",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

# .NET's Uri class builds a correct file:// URL even when the path
# contains spaces or non-Latin (Cyrillic) characters - this is the
# part that cmd.exe consistently gets wrong.
$fileUri = ([System.Uri]$filePath).AbsoluteUri

$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

$browser = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $browser) {
    # No Chrome/Edge found in standard install locations - open with the
    # system default handler instead.
    Start-Process -FilePath $filePath
    exit 0
}

# If a normal browser window opens at the homepage instead of the Mindal
# interface, the browser was probably already running and ignored the
# --app flag. Closing all its windows (check the system tray too) and
# launching again fixes that.
Start-Process -FilePath $browser -ArgumentList @("--new-window", "--app=$fileUri")
