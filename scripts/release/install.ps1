[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "upgrade", "repair", "status", "help")]
  [string]$Command = "install",
  [Parameter()]
  [string]$Version = "latest",
  [Parameter()]
  [string]$Channel,
  [Parameter()]
  [string]$RequestId,
  [Parameter()]
  [switch]$Json,
  [Parameter()]
  [switch]$Setup,
  [Parameter()]
  [switch]$Yes,
  [Parameter()]
  [switch]$AllowDowngrade,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$SetupArguments,
  [Parameter()]
  [string]$PrepareDirectory,
  [Parameter()]
  [string]$Target,
  [Parameter()]
  [switch]$ResolveOnly,
  [Parameter()]
  [switch]$QuietHeader,
  [Parameter()]
  [ValidateSet("all", "manifest", "artifact", "installer")]
  [string]$PreparePhase = "all"
)

$ErrorActionPreference = "Stop"

$versionWasBound = $PSBoundParameters.ContainsKey("Version")
$channelWasBound = $PSBoundParameters.ContainsKey("Channel")
if ($Command -in @("install", "upgrade", "repair")) {
  if (-not $versionWasBound -and -not $channelWasBound -and $env:RAFT_COMPUTER_VERSION) {
    $Version = $env:RAFT_COMPUTER_VERSION
    $versionWasBound = $true
  }
  if (-not $channelWasBound -and -not $versionWasBound) {
    if ($env:INSTALL_CHANNEL_DEFAULT) { $Channel = $env:INSTALL_CHANNEL_DEFAULT; $channelWasBound = $true }
  }
}
if ($versionWasBound -and $channelWasBound) {
  throw "install.ps1: -Version and -Channel cannot be combined"
}
if ($Command -eq "upgrade" -and [string]::IsNullOrEmpty($RequestId)) {
  throw "install.ps1: upgrade requires -RequestId"
}
if ($Command -in @("install", "status", "help")) {
  if ($RequestId) { throw "install.ps1: -RequestId is only valid with upgrade" }
}
if ($Command -in @("status", "help") -and $versionWasBound) {
  throw "install.ps1: $Command does not accept -Version"
}
if ($Command -in @("status", "help") -and $channelWasBound) {
  throw "install.ps1: $Command does not accept -Channel"
}
if ($Setup -and $Command -notin @("install", "upgrade", "repair")) {
  throw "install.ps1: -Setup is only valid with install, upgrade, or repair"
}
if ($Setup -and $Json) { throw "install.ps1: -Setup cannot be combined with -Json" }
if ($Setup -and (-not $SetupArguments -or $SetupArguments.Count -eq 0)) {
  throw "install.ps1: -Setup requires at least one setup argument"
}
if (($Yes -or $AllowDowngrade) -and $Command -notin @("install", "upgrade", "repair")) {
  throw "install.ps1: native confirmation options are only valid with install, upgrade, or repair"
}

function Test-CoforgeVersion([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  if ($Value -eq ".") { return $false }
  if ($Value.Contains("..")) { return $false }
  if ($Value.StartsWith("-")) { return $false }
  if ($Value.Length -gt 100) { return $false }
  return $Value -cmatch '^[A-Za-z0-9.+-]+\z'
}

if ($Version -ne "latest" -and -not (Test-CoforgeVersion $Version)) {
  throw "install.ps1: version must be latest or a valid version string"
}

$defaultFeedUrl = "https://releases.coforge.cn"
$feedUrl = $env:COFORGE_RELEASE_FEED_URL
if ([string]::IsNullOrEmpty($feedUrl)) { $feedUrl = $defaultFeedUrl }
$feedUrl = $feedUrl.TrimEnd("/")

$testMode = $env:COFORGE_INSTALLER_TEST_MODE -eq "1"
if (-not ($feedUrl.StartsWith("https://") -or ($testMode -and $feedUrl.StartsWith("http://")))) {
  throw "install.ps1: COFORGE_RELEASE_FEED_URL must use HTTPS"
}

$curlProto = if ($testMode -and $feedUrl.StartsWith("http://")) { "=http,https" } else { "=https" }
if ([string]::IsNullOrEmpty($Target)) {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  $Target = switch ($architecture) {
    "x64" { "windows-x64" }
    "arm64" { "windows-arm64" }
    default { throw "install.ps1: unsupported Windows architecture: $architecture" }
  }
}
$platform = switch -CaseSensitive ($Target) {
  "linux-x64" { "Linux x64" }
  "linux-arm64" { "Linux ARM64" }
  "darwin-x64" { "macOS (Intel)" }
  "darwin-arm64" { "macOS (Apple Silicon)" }
  "windows-x64" { "Windows x64" }
  "windows-arm64" { "Windows ARM64" }
  default { throw "install.ps1: unsupported release target: $Target" }
}
if ($PreparePhase -ne "all" -and -not $PrepareDirectory) {
  throw "install.ps1: preparation phase requires a directory"
}
# The installer gzip is chosen by target; the bootstrap and the `installer` phase both fetch it.
$installerGzip = if ($Target.StartsWith("windows-", [System.StringComparison]::Ordinal)) { "coforge-installer.exe.gz" } else { "coforge-installer.gz" }

# `latest` and the checksum sidecar are both tiny, feed-controlled text objects with no
# advertised size of their own, so each download gets a small fixed ceiling rather than none.
$maxPointerBytes = 4096
$maxManifestBytes = 1048576
# Fixed transport ceiling; the updater checks exact compressed and expanded manifest sizes.
$maxBinaryBytes = 536870912
# Pi's image library (photon_rs_bg.wasm) is a fixed, platform-independent object (~1.8 MB); the
# updater checks its exact recorded size against the manifest.
$maxWasmBytes = 16777216

function Write-CoforgeStep([string]$Message) {
  [Console]::Error.WriteLine("==> $Message")
}

$downloadFailedStatus = 75

function Exit-CoforgeDownload([string]$Message) {
  if ($PrepareDirectory -or $ResolveOnly) {
    # These modes run as the Computer's own child process (-File), never inside a user session.
    [Console]::Error.WriteLine($Message)
    exit $downloadFailedStatus
  }
  throw $Message
}

# Use native curl (not PowerShell's curl alias). No redirects are followed, including for
# bodies, preserving the Windows bootstrap and updater transport policy.
function Get-CoforgeObject([string]$Uri, [string]$OutFile, [long]$MaxBytes, [switch]$Binary) {
  $progress = if ($Binary -and -not [Console]::IsErrorRedirected) { "--progress-bar" } else { "--silent" }
  $status = & curl.exe --fail $progress --show-error --proto $curlProto --tlsv1.2 --max-filesize $MaxBytes --output $OutFile --write-out '%{http_code}' $Uri
  $curlExit = $LASTEXITCODE
  if ($curlExit -eq 63) {
    throw "install.ps1: download failed with curl exit code $curlExit"
  }
  if ($curlExit -ne 0) {
    Exit-CoforgeDownload "install.ps1: download failed with curl exit code $curlExit"
  }
  if ($status -cmatch '^3[0-9]{2}\z') {
    # A redirect is the feed answering against its contract, not a failure to reach it.
    throw "install.ps1: download returned HTTP $status (redirects are not followed)"
  }
  if ($status -cnotmatch '^2[0-9]{2}\z') {
    Exit-CoforgeDownload "install.ps1: download returned HTTP $status (redirects are not followed)"
  }
  if ((Get-Item -LiteralPath $OutFile).Length -gt $MaxBytes) {
    throw "install.ps1: download exceeded the maximum allowed size of $MaxBytes bytes"
  }
}

function Expand-CoforgeGzip([string]$InputFile, [string]$OutFile, [long]$MaxBytes) {
  $inputStream = [System.IO.File]::OpenRead($InputFile)
  try {
    $gzipStream = [System.IO.Compression.GZipStream]::new(
      $inputStream,
      [System.IO.Compression.CompressionMode]::Decompress
    )
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
            throw "install.ps1: decompressed binary exceeded the maximum allowed size of $MaxBytes bytes"
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

if ($PrepareDirectory) {
  if (-not (Test-Path -LiteralPath $PrepareDirectory -PathType Container)) {
    throw "install.ps1: preparation directory must already exist"
  }
  $temporaryDirectory = $PrepareDirectory
} else {
  $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("coforge-installer-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
}
try {
  if (-not $QuietHeader) { Write-CoforgeStep "Detected platform: $platform" }
  # -PrepareDirectory and -ResolveOnly are the Computer's own calls (installation-source.ts and
  # installer-launch.ts in release/). A plain bootstrap skips this block and installs through
  # coforge-installer below.
  if ($PrepareDirectory -or $ResolveOnly) {
    if ($Version -eq "latest") {
      if (-not $QuietHeader) { Write-CoforgeStep "Finding the latest CoForge Computer version" }
      $latestPath = Join-Path $temporaryDirectory "latest"
      Get-CoforgeObject -Uri "$feedUrl/latest" -OutFile $latestPath -MaxBytes $maxPointerBytes
      # Get-Content -Raw on a zero-byte file returns $null on Windows PowerShell 5.1, and $null has
      # no .Trim() method - the [string] cast turns that into an empty string, matching how
      # is_valid_version("") in install.sh already fails closed on an empty body instead of
      # erroring out with an unrelated method-not-found exception.
      $latestPointer = ([string](Get-Content -Raw -LiteralPath $latestPath)).Trim()
      Remove-Item -LiteralPath $latestPath
      if ($latestPointer -eq "latest" -or -not (Test-CoforgeVersion $latestPointer)) {
        throw "install.ps1: the latest pointer did not return a valid version"
      }
      $Version = $latestPointer
    }

    if (-not $QuietHeader) { Write-CoforgeStep "Resolved version: $Version" }
    if ($ResolveOnly) {
      Write-Output $Version
      return
    }

    # The `installer` phase fetches one object of the installer feed (`<feed>/installer/...`, so the
    # caller passes that as the feed URL): this target's coforge-installer gzip and nothing else. Its
    # name is derived from the target here, never taken from a caller, and the caller verifies size
    # and checksum against the installer manifest it fetched with the `manifest` phase.
    if ($PreparePhase -eq "installer") {
      Write-CoforgeStep "Downloading CoForge installer"
      Get-CoforgeObject -Uri "$feedUrl/$Version/$Target/$installerGzip" -OutFile (Join-Path $temporaryDirectory $installerGzip) -MaxBytes $maxBinaryBytes -Binary
      return
    }

    $manifestPath = Join-Path $temporaryDirectory "manifest.json"
    if ($PreparePhase -ne "artifact") {
      Get-CoforgeObject -Uri "$feedUrl/$Version/manifest.json" -OutFile $manifestPath -MaxBytes $maxManifestBytes
    }
    if ($PreparePhase -eq "manifest") { return }
    $compressedPath = Join-Path $temporaryDirectory "coforge-computer.gz"
    Write-CoforgeStep "Downloading CoForge Computer"
    Get-CoforgeObject -Uri "$feedUrl/$Version/$Target/coforge-computer.gz" -OutFile $compressedPath -MaxBytes $maxBinaryBytes -Binary
    # Pi's image library is part of the Computer download step and gets no progress line of its
    # own; only a failed fetch mentions it.
    $wasmPath = Join-Path $temporaryDirectory "photon_rs_bg.wasm"
    Get-CoforgeObject -Uri "$feedUrl/$Version/photon_rs_bg.wasm" -OutFile $wasmPath -MaxBytes $maxWasmBytes
    [System.IO.File]::WriteAllText((Join-Path $temporaryDirectory "version"), "$Version`n", [System.Text.UTF8Encoding]::new($false))
    if ($PrepareDirectory) { return }
  }

  # Bootstrap: the installer feed (<feed>/installer) names its current version in one pointer, and
  # each target has one installer gzip and a sidecar checksum. The installer resolves the Computer
  # version itself, so this script fetches no Computer object.
  Write-CoforgeStep "Finding the CoForge installer"
  $installerPointerPath = Join-Path $temporaryDirectory "installer-latest"
  Get-CoforgeObject -Uri "$feedUrl/installer/latest" -OutFile $installerPointerPath -MaxBytes $maxPointerBytes
  $installerVersion = ([string](Get-Content -Raw -LiteralPath $installerPointerPath)).Trim()
  Remove-Item -LiteralPath $installerPointerPath
  if ($installerVersion -eq "latest" -or -not (Test-CoforgeVersion $installerVersion)) {
    throw "install.ps1: the installer pointer did not return a valid version"
  }

  $installerUrl = "$feedUrl/installer/$installerVersion/$Target"
  $installerGzipPath = Join-Path $temporaryDirectory $installerGzip
  Write-CoforgeStep "Downloading CoForge installer"
  Get-CoforgeObject -Uri "$installerUrl/$installerGzip" -OutFile $installerGzipPath -MaxBytes $maxBinaryBytes -Binary

  # Bootstrap checks the sidecar before executing code.
  $sidecarPath = Join-Path $temporaryDirectory "coforge-installer.sha256"
  Get-CoforgeObject -Uri "$installerUrl/coforge-installer.sha256" -OutFile $sidecarPath -MaxBytes $maxPointerBytes
  $expectedSha256 = ([string](Get-Content -Raw -LiteralPath $sidecarPath)).Trim()
  # `-cnotmatch`, not the case-insensitive default `-notmatch`: Get-FileHash below always returns
  # lowercase hex (`.ToLowerInvariant()`), so a sidecar carrying uppercase hex would pass this
  # check under case-insensitive matching and then fail the checksum comparison instead - the
  # wrong error, for the wrong reason. install.sh's `case` pattern is inherently case-sensitive,
  # so this keeps both scripts equally strict about the sidecar's format.
  if ($expectedSha256 -cnotmatch '^[a-f0-9]{64}\z') {
    throw "install.ps1: sidecar checksum for $Target is missing or malformed"
  }

  $installerPath = Join-Path $temporaryDirectory "coforge-installer.exe"
  Expand-CoforgeGzip -InputFile $installerGzipPath -OutFile $installerPath -MaxBytes $maxBinaryBytes
  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "install.ps1: downloaded installer failed its checksum check"
  }

  $installerArguments = @($Command)
  switch ($Command) {
    "install" {
      if ($versionWasBound -or -not $channelWasBound) { $installerArguments += @("--version", $Version) }
    }
    "upgrade" {
      $installerArguments += @("--request-id", $RequestId)
      if ($versionWasBound -or -not $channelWasBound) { $installerArguments += @("--version", $Version) }
    }
    "repair" {
      if ($versionWasBound) { $installerArguments += @("--version", $Version) }
    }
    "status" { if ($Json) { $installerArguments += "--json" } }
  }
  if ($channelWasBound) { $installerArguments += @("--channel", $Channel) }
  if ($Yes) { $installerArguments += "--yes" }
  if ($AllowDowngrade) { $installerArguments += "--allow-downgrade" }
  if ($Json -and $Command -in @("install", "upgrade", "repair")) { $installerArguments += "--json" }
  & $installerPath @installerArguments
  $installerStatus = $LASTEXITCODE
  if ($installerStatus -eq 3 -and $Command -notin @("status", "help")) {
    [Console]::Error.WriteLine("install.ps1: retrying installer once after exit 3")
    & $installerPath @installerArguments
    $installerStatus = $LASTEXITCODE
  }
  $homeDirectory = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $binDirectory = Join-Path $homeDirectory ".coforge\computer\bin"
  $installedBinary = if ($env:RAFT_COMPUTER_BINARY) { $env:RAFT_COMPUTER_BINARY } elseif ($env:RAFT_COMPUTER_INSTALL_DIR) { Join-Path $env:RAFT_COMPUTER_INSTALL_DIR "coforge-computer.exe" } else { Join-Path $binDirectory "coforge-computer.cmd" }
  $binDirectory = Split-Path -Parent $installedBinary
  if ($installerStatus -ne 0) {
    if ($Setup -and (Test-Path -LiteralPath $installedBinary -PathType Leaf)) {
      & $installedBinary setup @SetupArguments
      if ($LASTEXITCODE -eq 0) { return }
    }
    throw "install.ps1: coforge-installer exited with code $installerStatus"
  }
  if ($Command -ne "install" -and -not $Setup) { return }
  $computerLabel = if ($Version -eq "latest") { "CoForge Computer" } else { "CoForge Computer $Version" }

  $shimPath = Join-Path $binDirectory "coforge-computer.cmd"
  if (-not (Test-Path -LiteralPath $shimPath)) {
    throw "install.ps1: $computerLabel was installed, but no shim appeared at $shimPath - that version predates this installer. Re-run this installer once a newer version is published."
  }

  $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $storedPath = [string]$environmentKey.GetValue(
      "Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    # Compare entry by entry, not by substring: a substring test both misses "already present but
    # written with a trailing separator" and falsely matches a directory this one is a prefix of.
    $storedEntries = $storedPath.Split(";") | Where-Object { $_ -ne "" }
    $alreadyStored = $false
    foreach ($entry in $storedEntries) {
      if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyStored = $true }
    }
    if (-not $alreadyStored) {
      $updatedPath = if ($storedPath -eq "") { $binDirectory } else { "$binDirectory;$storedPath" }
      $environmentKey.SetValue("Path", $updatedPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
  }
  finally {
    if ($environmentKey) { $environmentKey.Close() }
  }
  $sessionEntries = ($env:Path -split ";") | Where-Object { $_ -ne "" }
  $alreadyInSession = $false
  foreach ($entry in $sessionEntries) {
    if ($entry.TrimEnd("\") -ieq $binDirectory.TrimEnd("\")) { $alreadyInSession = $true }
  }
  if (-not $alreadyInSession) { $env:Path = "$binDirectory;$env:Path" }

  if ($Setup) {
    & $installedBinary setup @SetupArguments
    if ($LASTEXITCODE -ne 0) {
      throw "install.ps1: Computer setup exited with code $LASTEXITCODE"
    }
    return
  }

  # Keep completion guidance out of the script's pipeline return value.
  Write-Host "   $computerLabel installed and ready to use"
  Write-Host "Next: coforge-computer setup --workspace <slug>"
}
finally {
  if (-not $PrepareDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
