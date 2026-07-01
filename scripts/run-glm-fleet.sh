#!/usr/bin/env bash
# run-glm-fleet.sh — GLM-5.2 여러 양자화(tier)를 한 번에 서빙한다.
# 각 tier 는 별도 llama-server 인스턴스(고유 alias/port)로 뜨고, TokenLift 의
# onprem-glm provider 가 task 별로 적절한 tier(model id)로 라우팅한다. 여러 사용자가
# 사내망의 공유 엔드포인트로 접속한다.
#
# ⚠️ 메모리 주의: GLM-5.2 는 tier 당 217GB(1bit)~801GB(8bit) 다. 한 노드에 여러 대형
#    tier 를 "동시" 적재하는 건 대개 불가능하다. 실제로는 (a) 노드별로 tier 를 나누거나
#    (b) 메모리에 맞는 1~2개 tier 만 고르거나 (c) llama-swap 으로 온디맨드 로드한다.
#    이 스크립트는 매니페스트에 적힌 tier 를 그대로 띄우므로, 노드 메모리에 맞게 구성할 것.
#
# 사용:
#   bash scripts/run-glm-fleet.sh start   [manifest]   # 매니페스트의 각 tier 기동(백그라운드)
#   bash scripts/run-glm-fleet.sh print   [manifest]   # 실행할 명령만 출력(드라이런)
#   bash scripts/run-glm-fleet.sh status  [manifest]   # 각 tier 헬스체크(/health)
#   bash scripts/run-glm-fleet.sh stop    [manifest]   # 기동한 tier 종료(PID 파일 기반)
#
# 매니페스트(기본 scripts/glm-fleet.example.conf): '#' 주석 무시, 공백 구분 컬럼
#   alias           quant        port  ngl  n_cpu_moe  ctx
#   glm-5.2-q4      UD-Q4_K_XL   8084  99   0          16384
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ONE="$HERE/run-glm-llamacpp.sh"
ACTION="${1:-status}"
MANIFEST="${2:-$HERE/glm-fleet.example.conf}"
RUN_DIR="${RUN_DIR:-$HOME/.tokenlift/glm-fleet}"   # PID/로그 저장
HOST_BIND="${HOST:-0.0.0.0}"                        # 멀티유저 공유는 0.0.0.0
API_KEY="${API_KEY:-}"                              # 전 tier 공통 Bearer(선택)

mkdir -p "$RUN_DIR"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ 매니페스트를 찾을 수 없습니다: $MANIFEST" >&2
  exit 1
fi

# 매니페스트를 한 줄씩 순회하며 콜백 실행: alias quant port ngl n_cpu_moe ctx
foreach_tier() {
  local cb="$1"
  while read -r alias quant port ngl n_cpu_moe ctx _rest; do
    [[ -z "${alias:-}" || "${alias:0:1}" == "#" ]] && continue
    "$cb" "$alias" "$quant" "$port" "${ngl:-99}" "${n_cpu_moe:-0}" "${ctx:-16384}"
  done < "$MANIFEST"
}

_env_for() {  # 공통 env 조립(에코용)
  local alias="$1" quant="$2" port="$3" ngl="$4" n_cpu_moe="$5" ctx="$6"
  printf 'ALIAS=%s QUANT=%s PORT=%s NGL=%s N_CPU_MOE=%s CTX=%s HOST=%s%s' \
    "$alias" "$quant" "$port" "$ngl" "$n_cpu_moe" "$ctx" "$HOST_BIND" \
    "$([[ -n "$API_KEY" ]] && echo ' API_KEY=***')"
}

tier_print() {
  echo "• $(_env_for "$@")  bash $RUN_ONE"
}

tier_start() {
  local alias="$1" quant="$2" port="$3" ngl="$4" n_cpu_moe="$5" ctx="$6"
  local log="$RUN_DIR/$alias.log" pidf="$RUN_DIR/$alias.pid"
  if [[ -f "$pidf" ]] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "↺ 이미 실행 중: $alias (pid $(cat "$pidf"))"; return
  fi
  echo "▶ 기동: $alias ($quant) :$port → $log"
  ALIAS="$alias" QUANT="$quant" PORT="$port" NGL="$ngl" \
    N_CPU_MOE="$([[ "$n_cpu_moe" == "0" ]] && echo '' || echo "$n_cpu_moe")" \
    CTX="$ctx" HOST="$HOST_BIND" API_KEY="$API_KEY" \
    nohup bash "$RUN_ONE" >"$log" 2>&1 &
  echo $! > "$pidf"
}

tier_status() {
  local alias="$1" quant="$2" port="$3"
  local url="http://localhost:$port/health"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$url" 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then echo "✅ $alias ($quant) :$port  건강함";
  else echo "❌ $alias ($quant) :$port  응답없음(HTTP $code)"; fi
}

tier_stop() {
  local alias="$1"; local pidf="$RUN_DIR/$alias.pid"
  if [[ -f "$pidf" ]]; then
    local pid; pid="$(cat "$pidf")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "⏹ 종료: $alias (pid $pid)"; fi
    rm -f "$pidf"
  else echo "· PID 없음(미기동?): $alias"; fi
}

case "$ACTION" in
  print)  echo "# GLM-5.2 fleet (매니페스트: $MANIFEST)"; foreach_tier tier_print ;;
  start)  echo "# GLM-5.2 fleet 기동 (로그/PID: $RUN_DIR)"; foreach_tier tier_start
          echo; echo "→ 상태: bash $0 status $MANIFEST" ;;
  status) echo "# GLM-5.2 fleet 상태"; foreach_tier tier_status ;;
  stop)   echo "# GLM-5.2 fleet 종료"; foreach_tier tier_stop ;;
  *) echo "사용: $0 {start|print|status|stop} [manifest]" >&2; exit 2 ;;
esac
