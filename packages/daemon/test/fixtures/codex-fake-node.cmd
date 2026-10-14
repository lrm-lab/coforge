@echo off
rem Test fixture (Windows twin of `codex-fake-node`): answers --version plainly and echoes the
rem `initialize` request back with just its id. Found through the child's PATH, so the
rem probe-environment regression flips red/green the same way.
if "%~1"=="--version" (
  echo codex 0.0-seam
  exit /b 0
)
powershell -NoProfile -NonInteractive -Command "$line=$null; while($null -ne ($line=[Console]::In.ReadLine())) { if($line.Contains('initialize')) { $id=([regex]::Match($line,'""id"":""([^""]*)""')).Groups[1].Value; [Console]::Out.WriteLine('{"id":"'+$id+'"}') } }"
