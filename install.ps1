# Local Dost installer for Windows (PowerShell)
#   irm https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/local-dost/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo   = if ($env:LOCALDOST_REPO)   { $env:LOCALDOST_REPO }   else { 'YOUR_GITHUB_USERNAME/local-dost' }
$Branch = if ($env:LOCALDOST_BRANCH) { $env:LOCALDOST_BRANCH } else { 'main' }
$Data   = if ($env:LOCALDOST_HOME)   { $env:LOCALDOST_HOME }   else { Join-Path $env:USERPROFILE '.localdost' }
$App    = Join-Path $Data 'app'
$Bin    = Join-Path $Data 'bin'

function Say($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "v $m" -ForegroundColor Green }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; throw $m }

Write-Host "`nLocal Dost - free AI coding agent for your terminal`n" -ForegroundColor Cyan

# 1. Node.js 18+
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js 18+ is required. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again."
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Die "Node.js 18+ is required (found $(node -v)). Please upgrade: https://nodejs.org" }
Ok "Node $(node -v)"

# 2. Get the code
New-Item -ItemType Directory -Force -Path $Data, $Bin | Out-Null
$localRoot = if ($PSScriptRoot) { $PSScriptRoot } else { $null }

if ($localRoot -and (Test-Path (Join-Path $localRoot 'bin\localdost.js'))) {
  Say 'Installing from local checkout'
  if (Test-Path $App) { Remove-Item -Recurse -Force $App }
  New-Item -ItemType Directory -Force -Path $App | Out-Null
  Copy-Item -Recurse -Force (Join-Path $localRoot 'bin'), (Join-Path $localRoot 'src'), (Join-Path $localRoot 'package.json') $App
}
elseif (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $App '.git')) {
    Say 'Updating existing install'
    git -C $App pull --ff-only --quiet
  } else {
    Say 'Downloading Local Dost'
    if (Test-Path $App) { Remove-Item -Recurse -Force $App }
    git clone --depth 1 --branch $Branch --quiet "https://github.com/$Repo.git" $App
    if ($LASTEXITCODE -ne 0) { Die "Could not download https://github.com/$Repo (check the repo name and your internet)." }
  }
}
else {
  Say 'Downloading Local Dost'
  $zip = Join-Path $env:TEMP 'localdost.zip'
  $tmp = Join-Path $env:TEMP 'localdost-extract'
  Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path $App) { Remove-Item -Recurse -Force $App }
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $App
  Remove-Item -Force $zip
}
if (-not (Test-Path (Join-Path $App 'bin\localdost.js'))) { Die "Install looks incomplete: bin\localdost.js is missing." }
Ok "Installed to $App"

# 3. Launchers (.cmd works in cmd.exe and PowerShell)
foreach ($n in 'localdost', 'dost') {
  Set-Content -Path (Join-Path $Bin "$n.cmd") -Value "@echo off`r`nnode `"$App\bin\localdost.js`" %*" -Encoding ASCII
}
Ok 'Commands created: localdost, dost'

# 4. PATH (user level)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $Bin)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Bin), 'User')
  Ok "Added $Bin to your PATH"
  $reload = $true
}

Write-Host "`nAll set!" -ForegroundColor Green
if ($reload) { Write-Host '  1. Open a NEW terminal window, then go to any project folder' } else { Write-Host '  1. Go to any project folder' }
Write-Host '  2. Run: localdost   (first run walks you through free API keys)' -ForegroundColor Cyan
Write-Host "`nUpdate later: run this installer again.`n"
