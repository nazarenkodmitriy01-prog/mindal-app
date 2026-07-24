$ErrorActionPreference = "Stop"

$base = "https://nazarenkodmitriy01-prog.github.io/mindal-app"
$targetDir = Join-Path $env:USERPROFILE "Desktop\Mindal"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

Invoke-WebRequest -Uri "$base/launch_mindal.ps1" -OutFile (Join-Path $targetDir "launch_mindal.ps1") -UseBasicParsing
Invoke-WebRequest -Uri "$base/launch_mindal_hidden.vbs" -OutFile (Join-Path $targetDir "launch_mindal_hidden.vbs") -UseBasicParsing

$batUrl = "$base/%D0%97%D0%B0%D0%BF%D1%83%D1%81%D1%82%D0%B8%D1%82%D1%8C_%D0%9C%D0%B8%D0%BD%D0%B4%D0%B0%D0%BB%D1%8C.bat"
$batPath = Join-Path $targetDir "Start_Mindal.bat"
Invoke-WebRequest -Uri $batUrl -OutFile $batPath -UseBasicParsing

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $env:USERPROFILE "Desktop\Mindal.lnk"))
$shortcut.TargetPath = $batPath
$shortcut.WorkingDirectory = $targetDir
$shortcut.Description = "Mindal - shift and payroll tracker"
$shortcut.Save()

Write-Host ""
Write-Host "Done. Shortcut 'Mindal' added to the Desktop."
Write-Host "Launcher files installed to: $targetDir"
Write-Host "It always opens the live site, so future updates need no reinstall."
