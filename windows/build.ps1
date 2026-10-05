$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
New-Item -ItemType Directory -Force build/windows-lite, release/windows-lite/app | Out-Null
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile((Join-Path $pwd 'assets/ai-yaoce-logo.png'))
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($image, 0, 0, 256, 256)
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $memory.ToArray()
$file = [IO.File]::Create((Join-Path $pwd 'build/windows-lite/app.ico'))
$writer = New-Object IO.BinaryWriter $file
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
$writer.Dispose(); $memory.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $image.Dispose()
msbuild windows/AiYaoce.csproj /nologo /p:Configuration=Release /v:minimal
if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
msbuild windows/Tests.csproj /nologo /p:Configuration=Release /v:minimal
if ($LASTEXITCODE -ne 0) { throw 'Test build failed' }
& './build/windows-lite/tests/ai-yaoce-tests.exe'
if ($LASTEXITCODE -ne 0) { throw 'Core tests failed' }
$nsis = Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe'
if (!(Test-Path $nsis)) { throw 'Install NSIS first; no implicit runtime download' }
& $nsis /INPUTCHARSET UTF8 /V3 windows/installer.nsi
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
$installer = Get-Item 'release/windows-lite/ai-yaoce-2.0.0-windows-x64-setup.exe'
if ($installer.VersionInfo.ProductName -ne 'AI 遥测') { throw 'Installer product name is not valid Chinese Unicode' }
if ($installer.Length -gt 5MB) { throw 'Installer exceeds 5 MiB budget' }
$bytes = (Get-ChildItem 'release/windows-lite/app' -File -Recurse | Measure-Object Length -Sum).Sum
if ($bytes -gt 10MB) { throw 'Application exceeds 10 MiB budget' }
$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()
"$hash  $($installer.Name)" | Set-Content -Encoding utf8NoBOM 'release/windows-lite/SHA256SUMS.txt'
@{installerBytes=$installer.Length; applicationBytes=$bytes; framework='system .NET Framework 4.8 (not bundled)'} | ConvertTo-Json | Set-Content 'release/windows-lite/size-report.json'
