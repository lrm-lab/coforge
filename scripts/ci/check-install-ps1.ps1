# The static gate for scripts/release/install.ps1, run from the repository root by CI's "Check
# Windows installer" job under both PowerShell 7 and Windows PowerShell 5.1.
#
# install.sh is gated by shellcheck in the Computer job; install.ps1 had no machine gate at all,
# which is how a top-level `exit` - fatal under the documented `irm ... | iex` entry point,
# because it terminates the user's own session - survived in it unnoticed. This is that missing
# gate. It is deliberately static: running the installer end to end would need a real Windows
# binary in a fixture feed and would write to the runner's HKCU\Environment, so nothing here
# proves the installer's runtime behavior.
#
# install.ps1 documents Windows PowerShell 5.1 as a supported host and carries 5.1-specific
# workarounds, so the 5.1 preinstalled on the runner parses it too. Its parser rejects syntax that
# PowerShell 7 accepts, which is the whole point of the second pass.
param(
  # Also lint with PSScriptAnalyzer (PowerShell 7 only).
  [switch]$Lint
)

$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  "scripts/release/install.ps1", [ref]$tokens, [ref]$errors) | Out-Null
if ($errors) {
  $errors | Out-String | Write-Error
  exit 1
}

if ($Lint) {
  Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -SkipPublisherCheck
  # PSAvoidUsingWriteHost targets reusable functions, whose output a caller may want to
  # capture. This is a bootstrap script run as `irm ... | iex`, where the pipeline carries
  # the expression's value: Write-Output would make progress text the result of that
  # expression. Write-Host is the correct call here, so the rule is excluded rather than
  # worked around.
  $findings = Invoke-ScriptAnalyzer -Path "scripts/release/install.ps1" `
    -Severity Warning, Error -ExcludeRule PSAvoidUsingWriteHost
  if ($findings) {
    $findings | Format-Table -AutoSize | Out-String | Write-Error
    exit 1
  }
}
