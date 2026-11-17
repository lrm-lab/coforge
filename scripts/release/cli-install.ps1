[CmdletBinding()]
param(
  [Parameter()]
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"

function Test-CoforgeVersion([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  if ($Value -eq ".") { return $false }
  if ($Value.Contains("..")) { return $false }
  if ($Value.StartsWith("-")) { return $false }
  if ($Value.Length -gt 100) { return $false }
  return $Value -cmatch '^[A-Za-z0-9.+-]+\z'
}

if ($Version -ne "latest" -and -not (Test-CoforgeVersion $Version)) {
  throw "cli-install.ps1: version must be latest or a valid version string"
}

$defaultFeedUrl = "https://releases.coforge.cn"
$feedUrl = $env:COFORGE_RELEASE_FEED_URL
if ([string]::IsNullOrEmpty($feedUrl)) { $feedUrl = $defaultFeedUrl }
$feedUrl = $feedUrl.TrimEnd("/")

$testMode = $env:COFORGE_INSTALLER_TEST_MODE -eq "1"
if (-not ($feedUrl.StartsWith("https://") -or ($testMode -and $feedUrl.StartsWith("http://")))) {
  throw "cli-install.ps1: COFORGE_RELEASE_FEED_URL must use HTTPS"
}
$curlProto = if ($testMode -and $feedUrl.StartsWith("http://")) { "=http,https" } else { "=https" }

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$target = switch ($architecture) {
  "x64" { "windows-x64" }
  "arm64" { "windows-arm64" }
  default { throw "cli-install.ps1: unsupported Windows architecture: $architecture" }
}

$maxPointerBytes = 4096
$maxManifestBytes = 1048576
$maxBinaryBytes = 536870912

function Get-CoforgeObject([string]$Uri, [string]$OutFile, [long]$MaxBytes, [switch]$FollowRedirects) {
  $arguments = @("--fail", "--silent", "--show-error", "--proto", $curlProto, "--tlsv1.2", "--max-filesize", $MaxBytes, "--output", $OutFile)
  if ($FollowRedirects) { $arguments += @("--location", "--proto-redir", $curlProto) }
  & curl.exe @arguments $Uri
  if ($LASTEXITCODE -ne 0) {
    throw "cli-install.ps1: download failed with curl exit code $LASTEXITCODE"
  }
  if ((Get-Item -LiteralPath $OutFile).Length -gt $MaxBytes) {
    throw "cli-install.ps1: download exceeded the maximum allowed size of $MaxBytes bytes"
  }
}

function Expand-CoforgeGzip([string]$InputFile, [string]$OutFile, [long]$MaxBytes) {
  $inputStream = [System.IO.File]::OpenRead($InputFile)
  try {
    $gzipStream = [System.IO.Compression.GZipStream]::new($inputStream, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $outputStream = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create)
      try {
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while ($true) {
          $read = $gzipStream.Read($buffer, 0, $buffer.Length)
          if ($read -le 0) { break }
          $total += $read
          if ($total -gt $MaxBytes) {
            throw "cli-install.ps1: decompressed binary exceeded the maximum allowed size of $MaxBytes bytes"
          }
          $outputStream.Write($buffer, 0, $read)
        }
      } finally {
        $outputStream.Dispose()
      }
    } finally {
      $gzipStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

function Test-Sha256([string]$Value) {
  return $Value -cmatch '^[a-f0-9]{64}\z'
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-cli-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$stagedPath = $null
try {
  if ($Version -eq "latest") {
    $latestPath = Join-Path $temporaryDirectory "latest"
    Get-CoforgeObject -Uri "$feedUrl/latest" -OutFile $latestPath -MaxBytes $maxPointerBytes
    $Version = ([string](Get-Content -Raw -LiteralPath $latestPath)).Trim()
    if ($Version -eq "latest" -or -not (Test-CoforgeVersion $Version)) {
      throw "cli-install.ps1: the latest pointer did not return a valid version"
    }
  }
  $releaseUrl = "$feedUrl/$Version"

  $manifestPath = Join-Path $temporaryDirectory "manifest.json"
  Get-CoforgeObject -Uri "$releaseUrl/manifest.json" -OutFile $manifestPath -MaxBytes $maxManifestBytes
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $manifestSha256 = if ($manifest.cli) { [string]$manifest.cli.$target.checksum } else { "" }
  if (-not (Test-Sha256 $manifestSha256)) {
    throw "cli-install.ps1: release $Version does not publish a standalone CLI for $target"
  }

  $targetUrl = "$releaseUrl/$target"
  $sidecarPath = Join-Path $temporaryDirectory "coforge.sha256"
  Get-CoforgeObject -Uri "$targetUrl/coforge.sha256" -OutFile $sidecarPath -MaxBytes $maxPointerBytes
  $sidecarSha256 = ([string](Get-Content -Raw -LiteralPath $sidecarPath)).Trim()
  if (-not (Test-Sha256 $sidecarSha256)) {
    throw "cli-install.ps1: sidecar checksum for $target is missing or malformed"
  }
  if ($sidecarSha256 -ne $manifestSha256) {
    throw "cli-install.ps1: sidecar and manifest checksums disagree for $target"
  }

  [Console]::Error.WriteLine("Downloading coforge $Version ($target)")
  $gzipPath = Join-Path $temporaryDirectory "coforge.gz"
  Get-CoforgeObject -Uri "$targetUrl/coforge.gz" -OutFile $gzipPath -MaxBytes $maxBinaryBytes -FollowRedirects
  $binaryPath = Join-Path $temporaryDirectory "coforge.exe"
  Expand-CoforgeGzip -InputFile $gzipPath -OutFile $binaryPath -MaxBytes $maxBinaryBytes
  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaryPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $manifestSha256) {
    throw "cli-install.ps1: downloaded CLI failed its checksum check"
  }

  $binDirectory = if ($env:COFORGE_BIN_DIR) { $env:COFORGE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "CoForge\bin" }
  New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
  $stagedPath = Join-Path $binDirectory (".coforge-" + [guid]::NewGuid().ToString("N") + ".tmp")
  Copy-Item -LiteralPath $binaryPath -Destination $stagedPath
  Move-Item -LiteralPath $stagedPath -Destination (Join-Path $binDirectory "coforge.exe") -Force
  $stagedPath = $null

  $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $storedPath = [string]$environmentKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $alreadyStored = $false
    foreach ($entry in ($storedPath.Split(";") | Where-Object { $_ -ne "" })) {
      if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyStored = $true }
    }
    if (-not $alreadyStored) {
      $updatedPath = if ($storedPath -eq "") { $binDirectory } else { "$binDirectory;$storedPath" }
      $environmentKey.SetValue("Path", $updatedPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
  } finally {
    if ($environmentKey) { $environmentKey.Close() }
  }
  $alreadyInSession = $false
  foreach ($entry in (($env:Path -split ";") | Where-Object { $_ -ne "" })) {
    if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyInSession = $true }
  }
  if (-not $alreadyInSession) { $env:Path = "$binDirectory;$env:Path" }

  Write-Host "coforge $Version installed to $(Join-Path $binDirectory 'coforge.exe')"
}
finally {
  if ($stagedPath) { Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
