# Installs the latest butterfly binary from GitHub Releases.
#   irm https://raw.githubusercontent.com/Deveshu04/Butterfly-Code-CLI/master/scripts/install.ps1 | iex
# Options (environment): $env:BUTTERFLY_VERSION = "0.1.0"; $env:BUTTERFLY_INSTALL_DIR = "C:\tools\butterfly"
$ErrorActionPreference = "Stop"

$repo = "Deveshu04/Butterfly-Code-CLI"
$installDir = if ($env:BUTTERFLY_INSTALL_DIR) { $env:BUTTERFLY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\butterfly" }

if ([Environment]::Is64BitOperatingSystem -eq $false) { throw "butterfly requires 64-bit Windows" }

if ($env:BUTTERFLY_VERSION) {
  $version = $env:BUTTERFLY_VERSION.TrimStart("v")
} else {
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  $version = $release.tag_name.TrimStart("v")
}

$name = "butterfly-v$version-windows-x64.zip"
$base = "https://github.com/$repo/releases/download/v$version"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("butterfly-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading butterfly v$version (windows-x64)..."
  Invoke-WebRequest "$base/$name" -OutFile (Join-Path $tmp $name) -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing

  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape($name))$" }
  if (-not $line) { throw "no checksum for $name" }
  $expected = ($line -split "\s+")[0].ToLower()
  $actual = (Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $name" }

  Expand-Archive (Join-Path $tmp $name) -DestinationPath (Join-Path $tmp "x") -Force
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Copy-Item (Join-Path $tmp "x\butterfly.exe") (Join-Path $installDir "butterfly.exe") -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
  Write-Host "Added $installDir to your PATH (open a new terminal to use it)."
}
Write-Host "Installed butterfly v$version to $installDir\butterfly.exe"
