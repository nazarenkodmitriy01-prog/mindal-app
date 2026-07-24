Add-Type -AssemblyName System.Windows.Forms

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$filePath = Join-Path $dir "payroll_app.html"
$liveUrl = "https://nazarenkodmitriy01-prog.github.io/mindal-app/payroll_app.html"

# Предпочитаем "живую" версию с сайта, чтобы новые изменения (после git push)
# появлялись на этом компьютере сразу, а не только после ручного обновления
# локальных файлов - точно так же, как уже работает установленное на телефон
# TWA-приложение, которое каждый раз подгружает актуальную страницу с сайта.
# Если интернета нет - открываем локальную копию рядом со скриптом.
$targetUrl = $null
try {
    $null = Invoke-WebRequest -Uri $liveUrl -Method Head -TimeoutSec 3 -UseBasicParsing
    $targetUrl = $liveUrl
} catch {
    if (Test-Path -LiteralPath $filePath) {
        # .NET's Uri class builds a correct file:// URL even when the path
        # contains spaces or non-Latin (Cyrillic) characters - this is the
        # part that cmd.exe consistently gets wrong.
        $targetUrl = ([System.Uri]$filePath).AbsoluteUri
    }
}

if (-not $targetUrl) {
    [System.Windows.Forms.MessageBox]::Show(
        "Не удалось открыть ни сайт ($liveUrl), ни локальный файл ($filePath). Проверьте интернет-соединение.",
        "Mindal Launcher",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

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
    Start-Process -FilePath $targetUrl
    exit 0
}

# If a normal browser window opens at the homepage instead of the Mindal
# interface, the browser was probably already running and ignored the
# --app/--start-fullscreen flags. Closing all its windows (check the
# system tray too) and launching again fixes that.
Start-Process -FilePath $browser -ArgumentList @("--new-window", "--start-fullscreen", "--app=$targetUrl")
