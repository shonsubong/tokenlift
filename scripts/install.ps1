# TokenLift 설치 스크립트 (Windows PowerShell)
#
# 기본 동작(권장): "CLI(tokenlift) 전역 등록"만 수행한다.
#   스킬/서브에이전트/훅은 Claude Code "플러그인"으로 설치한다(자동 등록·버전 관리):
#     /plugin marketplace add shonsubong/tokenlift
#     /plugin install tokenlift@tokenlift
#
# 옵션:
#   -CopyAssets    (레거시) 플러그인을 쓸 수 없는 환경용 — 스킬/에이전트를 ~/.claude 로
#                  수동 복사. ⚠️ 플러그인과 병행하면 스킬/에이전트가 "중복"됨.
#   -RemoveLegacy  과거 수동 복사본을 백업 후 제거(플러그인 전환 시 중복 방지).
param(
  [switch]$CopyAssets,
  [switch]$RemoveLegacy
)
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ClaudeHome = Join-Path $HOME '.claude'
$SkillsDir = Join-Path $ClaudeHome 'skills'
$AgentsDir = Join-Path $ClaudeHome 'agents'
# 백업은 skills/agents 스캔 범위 "밖"에 둔다.
# (skills/ 안에 *.bak 디렉토리를 두면 그 안의 SKILL.md 때문에 중복 스킬로 인식됨)
$BackupDir = Join-Path $ClaudeHome '.tokenlift-backup'

Write-Host "== TokenLift 설치 ==" -ForegroundColor Cyan
Write-Host "저장소: $RepoRoot"

function Backup-IfExists($path, $name) {
  if (Test-Path $path) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $dest = Join-Path $BackupDir $name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $path $dest -Recurse -Force
    Write-Host "  기존 항목 백업: $dest" -ForegroundColor Yellow
  }
}

# ── (선택) 레거시 수동 복사본 제거: 플러그인 전환 시 중복 방지 ──
if ($RemoveLegacy) {
  Write-Host "`n== 레거시 수동 복사본 제거(백업 후) ==" -ForegroundColor Cyan
  $skillDst = Join-Path $SkillsDir 'tokenlift'
  if (Test-Path $skillDst) {
    Backup-IfExists $skillDst 'skills-tokenlift'
    Remove-Item $skillDst -Recurse -Force
    Write-Host "  제거: $skillDst"
  }
  foreach ($a in @('ollama-delegate.md', 'onprem-oracle.md')) {
    $agentDst = Join-Path $AgentsDir $a
    if (Test-Path $agentDst) {
      Backup-IfExists $agentDst $a
      Remove-Item $agentDst -Force
      Write-Host "  제거: $agentDst"
    }
  }
  Write-Host "  → 이제 플러그인 버전만 사용됩니다(/plugin install tokenlift@tokenlift)." -ForegroundColor Green
}

# ── (레거시) 스킬/에이전트 수동 복사: 플러그인을 쓸 수 없는 환경 전용 ──
if ($CopyAssets) {
  Write-Host "`n== (레거시) 스킬/서브에이전트 수동 복사 ==" -ForegroundColor Cyan
  Write-Host "  ⚠️ 플러그인과 병행 금지(중복). 가능하면 /plugin install 을 사용하세요." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $AgentsDir | Out-Null

  $skillSrc = Join-Path $RepoRoot 'skills\tokenlift'
  $skillDst = Join-Path $SkillsDir 'tokenlift'
  Backup-IfExists $skillDst 'skills-tokenlift'
  if (Test-Path $skillDst) { Remove-Item $skillDst -Recurse -Force }
  Copy-Item $skillSrc $skillDst -Recurse -Force
  Write-Host "  스킬 배포 완료 → $skillDst" -ForegroundColor Green

  Get-ChildItem (Join-Path $RepoRoot 'agents') -Filter '*.md' | ForEach-Object {
    $agentDst = Join-Path $AgentsDir $_.Name
    Backup-IfExists $agentDst $_.Name
    Copy-Item $_.FullName $agentDst -Force
    Write-Host "  서브에이전트 배포 완료 → $agentDst" -ForegroundColor Green
  }
}

# ── CLI 전역 등록 (항상 수행; 플러그인은 CLI 를 설치하지 않는다) ──
# 주의: 네이티브 명령(npm)은 try/catch 로 실패가 안 잡힌다. 반드시 $LASTEXITCODE 로 확인.
Write-Host "`n== tokenlift CLI 전역 명령 등록 ==" -ForegroundColor Cyan
Push-Location $RepoRoot
npm link 2>&1 | Out-Host
$linkOk = ($LASTEXITCODE -eq 0)
Pop-Location

if ($linkOk) {
  Write-Host "  npm link 완료. 'tokenlift' 명령 사용 가능." -ForegroundColor Green
} else {
  Write-Host "  npm link 실패(저장소가 C: 외 드라이브면 전역 심볼릭 링크가 막힘). 셸 shim 으로 대체합니다." -ForegroundColor Yellow
  # npm 전역 prefix(보통 %AppData%\npm, 이미 PATH 에 포함)에 shim 직접 생성
  $npmPrefix = (& npm config get prefix 2>$null)
  if (-not $npmPrefix -or -not (Test-Path $npmPrefix)) { $npmPrefix = Join-Path $env:APPDATA 'npm' }
  New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null
  $entry = Join-Path $RepoRoot 'bin\tokenlift.mjs'
  $entryUnix = $entry -replace '\\','/'
  # cmd / PowerShell 용 shim
  $cmdShim = Join-Path $npmPrefix 'tokenlift.cmd'
  Set-Content -Path $cmdShim -Encoding ASCII -Value "@echo off`r`nnode `"$entry`" %*"
  # git-bash 용 shim
  $shShim = Join-Path $npmPrefix 'tokenlift'
  Set-Content -Path $shShim -Encoding ASCII -Value "#!/usr/bin/env bash`nexec node `"$entryUnix`" `"`$@`""
  Write-Host "  shim 생성 완료: $cmdShim" -ForegroundColor Green
  Write-Host "  ('$npmPrefix' 이 PATH 에 있으면 새 터미널에서 'tokenlift' 사용 가능)" -ForegroundColor Gray
  Write-Host "  PATH 미포함 시 직접 실행: node `"$entry`" <command>" -ForegroundColor Gray
}

# ── 환경 점검 ──
Write-Host "`n== 환경 점검(doctor) ==" -ForegroundColor Cyan
node (Join-Path $RepoRoot 'bin\tokenlift.mjs') doctor

# ── 다음 단계 안내 ──
Write-Host "`n== 다음 단계: Claude Code 플러그인 설치(스킬·에이전트·훅 자동 등록) ==" -ForegroundColor Cyan
Write-Host "  Claude Code 안에서:"
Write-Host "    /plugin marketplace add shonsubong/tokenlift" -ForegroundColor Gray
Write-Host "    /plugin install tokenlift@tokenlift" -ForegroundColor Gray
Write-Host "  (스킬은 /tokenlift:tokenlift 로, 보안 힌트 훅은 hooks/hooks.json 으로 자동 활성화)"
if ($CopyAssets) {
  $hookPath = (Join-Path $RepoRoot 'hooks\suggest-delegation.mjs') -replace '\\','/'
  Write-Host "`n  (레거시 모드) 훅 수동 등록 — ~/.claude/settings.json 의 hooks.UserPromptSubmit:"
  Write-Host "    { `"hooks`": { `"UserPromptSubmit`": [ { `"hooks`": [ { `"type`": `"command`"," -ForegroundColor Gray
  Write-Host "      `"command`": `"node \`"$hookPath\`"`" } ] } ] } }" -ForegroundColor Gray
}

Write-Host "`n설치 완료." -ForegroundColor Green
