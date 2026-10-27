# The Windows Scheduled Task that runs the Coordinator, for restart-windows-daemon.ps1; dot-source it.

function Get-WindowsTaskUserId {
  $domain = [string]$env:USERDOMAIN
  $user = [string]$env:USERNAME
  if ($domain -and $user) { return "$domain\$user" }
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Escape-Xml([string]$Value) {
  return ($Value -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

function New-DaemonTaskXml {
  param(
    [string]$UserId,
    [string]$ExecutablePath,
    [string]$SocketPath,
    [string]$StateDirectory
  )
  $uid = Escape-Xml $UserId
  $cmd = Escape-Xml $ExecutablePath
  $argsXml = Escape-Xml "__daemon --socket $SocketPath --state-directory $StateDirectory"
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$uid</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$uid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$cmd</Command>
      <Arguments>$argsXml</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

function Invoke-Schtasks {
  param([string[]]$SchtasksArgs)
  $output = & schtasks.exe @SchtasksArgs 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Output = $output.Trim() }
}

function Install-AndRunDaemonTask {
  param(
    [string]$Exe,
    [string]$Task,
    [switch]$EndFirst
  )
  $state = Join-Path $env:USERPROFILE ".coforge\daemon"
  $socket = Join-Path $state "daemon.sock"
  $userId = Get-WindowsTaskUserId
  $xml = New-DaemonTaskXml -UserId $userId -ExecutablePath $Exe -SocketPath $socket -StateDirectory $state
  $xmlPath = Join-Path $env:TEMP ("coforge-daemon-task-{0}.xml" -f [guid]::NewGuid().ToString("n"))
  try {
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

    if ($EndFirst) {
      Write-Host "==> Stopping Scheduled Task '$Task' (if running)..."
      $null = Invoke-Schtasks -SchtasksArgs @("/End", "/TN", $Task)
      $stopDeadline = [datetime]::UtcNow.AddSeconds(15)
      while ([datetime]::UtcNow -lt $stopDeadline) {
        $still = @(Get-DaemonCoordinatorProcess)
        if ($still.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
      }
      # A dead owner / leftover AF_UNIX reparse point blocks the next Coordinator bind on Windows.
      Clear-StaleSupervisorLock
      if (Test-Path -LiteralPath $socket) {
        Write-Host "==> Removing leftover daemon.sock before restart"
        Remove-Item -Force -LiteralPath $socket -ErrorAction SilentlyContinue
      }
    }

    Write-Host "==> Registering Scheduled Task '$Task' (XML LogonTrigger)..."
    $created = Invoke-Schtasks -SchtasksArgs @("/Create", "/TN", $Task, "/XML", $xmlPath, "/F")
    if ($created.Code -ne 0) {
      throw "schtasks /Create failed (exit $($created.Code)): $($created.Output)"
    }

    Write-Host "==> Running Scheduled Task '$Task'..."
    $started = Invoke-Schtasks -SchtasksArgs @("/Run", "/TN", $Task)
    if ($started.Code -ne 0) {
      throw "schtasks /Run failed (exit $($started.Code)): $($started.Output)"
    }
  } finally {
    Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue
  }

  $deadline = [datetime]::UtcNow.AddSeconds(20)
  do {
    $proc = Get-DaemonCoordinatorProcess | Select-Object -First 1
    if ($proc) {
      Write-Host "Coordinator is up (pid $($proc.ProcessId))."
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([datetime]::UtcNow -lt $deadline)

  throw "Scheduled Task started but __daemon did not appear within 20s. Check '$state' logs."
}
