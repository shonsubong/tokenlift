#!/usr/bin/env bash
# TokenLift 설치 스크립트 (macOS / Linux / WSL2)
#
# 기본 동작(권장): "CLI(tokenlift) 전역 등록"만 수행한다.
#   스킬/서브에이전트/훅은 Claude Code "플러그인"으로 설치한다(자동 등록·버전 관리):
#     /plugin marketplace add shonsubong/tokenlift
#     /plugin install tokenlift@tokenlift
#
# 옵션:
#   --copy-assets    (레거시) 플러그인을 쓸 수 없는 환경용 — 스킬/에이전트를 ~/.claude 로
#                    수동 복사하고 훅 수동 등록법을 안내한다. ⚠️ 플러그인과 병행하면
#                    스킬/에이전트가 "중복"되므로 둘 중 하나만 사용할 것.
#   --remove-legacy  과거 수동 복사본(~/.claude/skills/tokenlift, agents/ollama-delegate.md,
#                    agents/onprem-oracle.md)을 백업 후 제거한다(플러그인 전환 시 중복 방지).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_HOME="$HOME/.claude"
SKILLS_DIR="$CLAUDE_HOME/skills"
AGENTS_DIR="$CLAUDE_HOME/agents"
# 백업은 skills/agents 스캔 범위 "밖"에 둔다.
# (skills/ 안에 *.bak 디렉토리를 두면 그 안의 SKILL.md 때문에 중복 스킬로 인식됨)
BACKUP_DIR="$CLAUDE_HOME/.tokenlift-backup"

COPY_ASSETS=0
REMOVE_LEGACY=0
for arg in "$@"; do
  case "$arg" in
    --copy-assets) COPY_ASSETS=1 ;;
    --remove-legacy) REMOVE_LEGACY=1 ;;
    *) echo "알 수 없는 옵션: $arg (사용: --copy-assets | --remove-legacy)"; exit 2 ;;
  esac
done

echo "== TokenLift 설치 =="
echo "저장소: $REPO_ROOT"

backup_if_exists() { # <원본경로> <백업이름>
  if [ -e "$1" ]; then
    mkdir -p "$BACKUP_DIR"
    local dest="$BACKUP_DIR/$2"
    echo "  기존 항목 백업: $dest"
    rm -rf "$dest"
    cp -r "$1" "$dest"
  fi
}

# ── (선택) 레거시 수동 복사본 제거: 플러그인 전환 시 중복 방지 ──
if [ "$REMOVE_LEGACY" = "1" ]; then
  echo ""
  echo "== 레거시 수동 복사본 제거(백업 후) =="
  backup_if_exists "$SKILLS_DIR/tokenlift" "skills-tokenlift"
  rm -rf "$SKILLS_DIR/tokenlift" && echo "  제거: $SKILLS_DIR/tokenlift"
  for a in ollama-delegate.md onprem-oracle.md; do
    if [ -e "$AGENTS_DIR/$a" ]; then
      backup_if_exists "$AGENTS_DIR/$a" "$a"
      rm -f "$AGENTS_DIR/$a" && echo "  제거: $AGENTS_DIR/$a"
    fi
  done
  echo "  → 이제 플러그인 버전만 사용됩니다(/plugin install tokenlift@tokenlift)."
fi

# ── (레거시) 스킬/에이전트 수동 복사: 플러그인을 쓸 수 없는 환경 전용 ──
if [ "$COPY_ASSETS" = "1" ]; then
  echo ""
  echo "== (레거시) 스킬/서브에이전트 수동 복사 =="
  echo "  ⚠️ 플러그인과 병행 금지(중복). 가능하면 /plugin install 을 사용하세요."
  mkdir -p "$SKILLS_DIR" "$AGENTS_DIR"
  backup_if_exists "$SKILLS_DIR/tokenlift" "skills-tokenlift"
  rm -rf "$SKILLS_DIR/tokenlift"
  cp -r "$REPO_ROOT/skills/tokenlift" "$SKILLS_DIR/tokenlift"
  echo "  스킬 배포 완료 → $SKILLS_DIR/tokenlift"
  for agent_src in "$REPO_ROOT"/agents/*.md; do
    agent_name="$(basename "$agent_src")"
    backup_if_exists "$AGENTS_DIR/$agent_name" "$agent_name"
    cp "$agent_src" "$AGENTS_DIR/$agent_name"
    echo "  서브에이전트 배포 완료 → $AGENTS_DIR/$agent_name"
  done
fi

# ── CLI 전역 등록 (항상 수행; 플러그인은 CLI 를 설치하지 않는다) ──
echo ""
echo "== tokenlift CLI 전역 명령 등록(npm link) =="
if (cd "$REPO_ROOT" && npm link); then
  echo "  npm link 완료. 'tokenlift' 명령 사용 가능."
else
  echo "  npm link 실패(권한/환경). 대신 직접 실행하세요:"
  echo "    node \"$REPO_ROOT/bin/tokenlift.mjs\" <command>"
fi

# ── 환경 점검 ──
echo ""
echo "== 환경 점검(doctor) =="
node "$REPO_ROOT/bin/tokenlift.mjs" doctor || true

# ── 다음 단계 안내 ──
echo ""
echo "== 다음 단계: Claude Code 플러그인 설치(스킬·에이전트·훅 자동 등록) =="
echo "  Claude Code 안에서:"
echo "    /plugin marketplace add shonsubong/tokenlift"
echo "    /plugin install tokenlift@tokenlift"
echo "  (스킬은 /tokenlift:tokenlift 로, 보안 힌트 훅은 hooks/hooks.json 으로 자동 활성화)"
if [ "$COPY_ASSETS" = "1" ]; then
  echo ""
  echo "  (레거시 모드) 훅 수동 등록 — ~/.claude/settings.json 의 hooks.UserPromptSubmit:"
  echo "    { \"hooks\": { \"UserPromptSubmit\": [ { \"hooks\": [ { \"type\": \"command\","
  echo "      \"command\": \"node \\\"$REPO_ROOT/hooks/suggest-delegation.mjs\\\"\" } ] } ] } }"
fi
echo ""
echo "설치 완료."
