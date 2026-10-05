$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = Join-Path $pwd 'build/windows-lite/verification'
New-Item -ItemType Directory -Force $root | Out-Null
function Write-Utf8($path, $value) { [IO.File]::WriteAllText($path, $value, (New-Object Text.UTF8Encoding $false)) }
function Invoke-App($exe, $mode, $testHome, $output) {
  New-Item -ItemType Directory -Force $output | Out-Null
  $process = Start-Process -FilePath $exe -ArgumentList @($mode, "`"$testHome`"", "`"$output`"") -PassThru
  if (!$process.WaitForExit(180000)) { $process.Kill(); throw 'Native app timed out' }
  if ($process.ExitCode -ne 0) { Get-Content "$output/failure.txt" -ErrorAction SilentlyContinue; throw "Native verification failed: $mode" }
}
function New-Home($name, $large) {
  $homePath = Join-Path $root $name
  New-Item -ItemType Directory -Force "$homePath/.codex/sessions", "$homePath/.claude/projects", "$homePath/.qwen" | Out-Null
  Write-Utf8 "$homePath/.ai-yaoce-test-home" 'isolated verification only'
  $stamp = [DateTime]::UtcNow.ToString('o')
  if ($large) {
    foreach ($fileIndex in 1..12) {
      $text = New-Object Text.StringBuilder
      [void]$text.AppendLine((@{type='session_meta'; payload=@{id="load-$fileIndex";model_provider='fixture'}} | ConvertTo-Json -Compress -Depth 10))
      [void]$text.AppendLine('{"type":"turn_context","payload":{"model":"fixture-model"}}')
      foreach ($count in 1..1000) {
        [void]$text.AppendLine((@{type='event_msg';timestamp=$stamp;payload=@{type='token_count';info=@{total_token_usage=@{input_tokens=$count;output_tokens=0}}}} | ConvertTo-Json -Compress -Depth 10))
        [void]$text.AppendLine((@{type='response_item';payload=@{text=('NOT_RETAINED_' * 100)}} | ConvertTo-Json -Compress -Depth 10))
      }
      Write-Utf8 "$homePath/.codex/sessions/$fileIndex.jsonl" $text.ToString()
    }
  } else {
    Write-Utf8 "$homePath/.codex/sessions/test.jsonl" ((@{type='event_msg';timestamp=$stamp;payload=@{type='token_count';info=@{total_token_usage=@{input_tokens=100;output_tokens=50}}}} | ConvertTo-Json -Compress -Depth 10) + "`n")
    Write-Utf8 "$homePath/.claude/projects/test.jsonl" ((@{type='assistant';timestamp=$stamp;sessionId='fixture-session';message=@{id='fixture-message';model='claude-fixture';content='DO_NOT_RETAIN';usage=@{input_tokens=12;output_tokens=5}}} | ConvertTo-Json -Compress -Depth 10) + "`n")
  }
  Write-Utf8 "$homePath/.qwen/settings.json" '{"logPrompts":true,"usageStatisticsEnabled":true}'
  return $homePath
}
$homeSmall = New-Home 'small-home' $false
$exe = (Resolve-Path 'release/windows-lite/app/ai-yaoce.exe').Path
Invoke-App $exe '--smoke' $homeSmall "$root/packaged"
$destination = Join-Path $env:LOCALAPPDATA 'Programs/ai-yaoce'
if (Test-Path $destination) { throw 'Refusing to replace an existing installation during verification' }
$installer = (Resolve-Path 'release/windows-lite/ai-yaoce-2.0.0-windows-x64-setup.exe').Path
$process = Start-Process $installer -ArgumentList '/S' -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Installation failed' }
$installed = Join-Path $destination 'ai-yaoce.exe'
if (!(Test-Path $installed)) { throw 'Default ai-yaoce install path missing' }
if (!(Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI 遥测.lnk'))) { throw 'Desktop shortcut missing' }
Invoke-App $installed '--smoke' $homeSmall "$root/installed"
Invoke-App $installed '--smoke' $homeSmall "$root/restarted"
$homeLarge = New-Home 'load-home' $true
Invoke-App $installed '--performance' $homeLarge "$root/performance"
$performance = Get-Content "$root/performance/performance.json" -Raw | ConvertFrom-Json
if (!$performance.passed) { throw 'Performance budget failed' }
$installBytes = (Get-ChildItem $destination -File -Recurse | Measure-Object Length -Sum).Sum
if ($installBytes -gt 10MB) { throw 'Installed files exceed 10 MiB' }
$sentinel = Join-Path $destination 'user-owned-file.txt'; Write-Utf8 $sentinel 'must survive uninstall'
$uninstaller = Join-Path $destination 'uninstall.exe'
$process = Start-Process $uninstaller -ArgumentList '/S' -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Uninstall failed' }
foreach ($attempt in 1..20) { if (!(Test-Path $installed)) { break }; Start-Sleep -Milliseconds 500 }
if (Test-Path $installed) { throw 'Installed program not removed' }
if (!(Test-Path $sentinel)) { throw 'Uninstaller deleted user-owned content' }
if (!(Test-Path "$homeSmall/app-settings/native-settings.json")) { throw 'Test settings unexpectedly removed' }
if (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI 遥测.lnk')) { throw 'Desktop shortcut not removed' }
Remove-Item $sentinel
if ((Get-ChildItem $destination -Force | Measure-Object).Count -eq 0) { Remove-Item $destination }
@{passed=$true;installedBytes=$installBytes;defaultPath='LOCALAPPDATA/Programs/ai-yaoce';restarted=$true;uninstalled=$true;userContentPreserved=$true;scope='Windows CI, synthetic isolated local files; not physical-device validation'} | ConvertTo-Json | Set-Content "$root/installation.json"
Get-Content "$root/performance/performance.json"
Get-Content "$root/installation.json"
