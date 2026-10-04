# Enables Steam's CEF remote debugging and makes the daemon start at logon
# (shortcut in the Startup folder). Run again after moving this directory.
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Name = 'Steam Overlay Access'

$Steam = $env:STEAM_DIR
if (-not $Steam) { $Steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath }
if (-not $Steam) { $Steam = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue).InstallPath }
if (-not $Steam -or -not (Test-Path $Steam)) {
    Write-Host 'Steam directory not found; set the STEAM_DIR environment variable and run again.'
    exit 1
}

$Python = $null
foreach ($cmd in @(@('py', '-3'), @('python'), @('python3'))) {
    if (-not (Get-Command $cmd[0] -ErrorAction SilentlyContinue)) { continue }
    $launcher = $cmd[0]
    $rest = @($cmd | Select-Object -Skip 1)
    $exe = & $launcher @rest -c 'import sys; print(sys.executable)'
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe)) { $Python = $exe; break }
}
if (-not $Python) {
    Write-Host 'Python 3 not found. Install it from https://www.python.org/downloads/ and run again.'
    exit 1
}

$check = 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(''websockets'') else 1)'
& $Python -c $check
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing the Python module 'websockets'..."
    & $Python -m pip install --user websockets
    & $Python -c $check
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not install 'websockets'; run: `"$Python`" -m pip install websockets"
        exit 1
    }
}

New-Item -ItemType File -Force -Path (Join-Path $Steam '.cef-enable-remote-debugging') | Out-Null
if (-not (Test-Path (Join-Path $Steam '.cef-enable-remote-debugging'))) {
    Write-Host "Could not create .cef-enable-remote-debugging in $Steam (run as administrator?)."
    exit 1
}

# NVDA's controller client lets the daemon speak through NVDA instead of SAPI.
$Dll = Join-Path $Dir 'nvdaControllerClient.dll'
if (-not (Test-Path $Dll)) {
    try {
        $v = '2026.2'
        $arch = & $Python -c 'import platform, struct; print(''arm64'' if platform.machine() == ''ARM64'' else ''x64'' if struct.calcsize(''P'') == 8 else ''x86'')'
        $zip = Join-Path $env:TEMP 'nvda_controllerClient.zip'
        $out = Join-Path $env:TEMP 'nvda_controllerClient'
        Write-Host 'Downloading the NVDA controller client...'
        Invoke-WebRequest "https://download.nvaccess.org/releases/$v/nvda_${v}_controllerClient.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $out -Force
        $found = Get-ChildItem $out -Recurse -Filter nvdaControllerClient.dll |
            Where-Object { $_.FullName -match "[\\/]$arch[\\/]" } | Select-Object -First 1
        if ($found) { Copy-Item $found.FullName $Dll }
    } catch {}
    if (-not (Test-Path $Dll)) {
        Write-Host 'Could not get the NVDA controller client; speech will use SAPI. See README to add it by hand.'
    }
}

# pythonw.exe runs without a console window
$Pythonw = Join-Path (Split-Path -Parent $Python) 'pythonw.exe'
if (-not (Test-Path $Pythonw)) { $Pythonw = $Python }
$Script = Join-Path $Dir 'soa_daemon.py'

$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) "$Name.lnk"))
$link.TargetPath = $Pythonw
$link.Arguments = "`"$Script`""
$link.WorkingDirectory = $Dir
$link.Description = 'Screen reader support for the Steam overlay'
$link.Save()

Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like '*soa_daemon.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $Pythonw -ArgumentList "`"$Script`"" -WorkingDirectory $Dir

Write-Host 'Installed. Restart Steam once so that it opens its debugging port.'
