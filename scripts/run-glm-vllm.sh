#!/usr/bin/env bash
# run-glm-vllm.sh — GLM-5.2 를 vLLM 으로 서빙(OpenAI 호환 /v1). NVIDIA 공식 양자화 우선.
# TokenLift 의 onprem-glm provider(및 NemoClaw vllm-local/compatible-endpoint)가 이 서버로 위임한다.
# vLLM 은 연속 배칭으로 멀티유저 동시성이 우수 → 사내 공유 서빙에 적합.
#
# 프로파일(PROFILE):
#   nvfp4  NVIDIA 공식 NVFP4 (nvidia/GLM-5.2-NVFP4) — ⚠️ Blackwell(B200/B300/GB200) 전용.
#          NVFP4 텐서코어가 Blackwell 에만 있어 H200(Hopper)에서는 실행 불가.
#   fp8    Z.ai 공식 FP8 (zai-org/GLM-5.2-FP8) — H200/H20(Hopper) 네이티브 FP8. 8xH200 적재.
#
# 사용:
#   PROFILE=nvfp4 bash scripts/run-glm-vllm.sh          # Blackwell: NVIDIA 공식 NVFP4
#   PROFILE=fp8   bash scripts/run-glm-vllm.sh          # H200: Z.ai 공식 FP8
#   TP=8 PORT=8000 API_KEY="$TOKEN" bash scripts/run-glm-vllm.sh
#
# 참고: https://huggingface.co/nvidia/GLM-5.2-NVFP4 · https://huggingface.co/zai-org/GLM-5.2-FP8
#       https://recipes.vllm.ai/zai-org/GLM-5.2
set -euo pipefail

PROFILE="${PROFILE:-nvfp4}"          # nvfp4(기본, NVIDIA 공식/Blackwell) | fp8(Z.ai/H200)
VLLM="${VLLM:-vllm}"                  # vllm 실행 파일(또는 python -m vllm.entrypoints...)

# 프로파일 기본값(개별 env 로 override 가능)
case "$PROFILE" in
  nvfp4)
    MODEL="${MODEL:-nvidia/GLM-5.2-NVFP4}"
    SERVED_NAME="${SERVED_NAME:-glm-5.2-nvfp4}"
    KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-fp8_e4m3}"   # NVFP4 권장
    ARCH_NOTE="Blackwell(B200/B300/GB200) 전용 — H200(Hopper) 불가"
    ;;
  fp8)
    MODEL="${MODEL:-zai-org/GLM-5.2-FP8}"
    SERVED_NAME="${SERVED_NAME:-glm-5.2-fp8}"
    KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-fp8_e5m2}"   # Hopper FP8 권장
    ARCH_NOTE="H200/H20(Hopper) 네이티브 FP8"
    ;;
  *) echo "❌ 알 수 없는 PROFILE: '$PROFILE' (nvfp4 | fp8)" >&2; exit 2 ;;
esac

TP="${TP:-8}"                        # tensor-parallel size(GPU 수)
HOST="${HOST:-0.0.0.0}"              # 멀티유저 공유는 0.0.0.0
PORT="${PORT:-8000}"                 # vLLM 기본 포트
MAX_MODEL_LEN="${MAX_MODEL_LEN:-131072}"   # 컨텍스트(최대 1048576 = 1M)
GPU_UTIL="${GPU_UTIL:-0.92}"         # --gpu-memory-utilization
MAX_NUM_SEQS="${MAX_NUM_SEQS:-}"     # (선택) 동시 시퀀스 상한
API_KEY="${API_KEY:-}"              # (선택) 멀티유저 Bearer 토큰(--api-key)
EXTRA_ARGS="${EXTRA_ARGS:-}"        # (선택) 추가 vLLM 인자

# 사전 점검
if ! command -v "$VLLM" >/dev/null 2>&1; then
  echo "❌ vllm 실행 파일을 찾을 수 없습니다: '$VLLM'" >&2
  echo "   설치: pip install -U vllm   (vLLM 0.19.0+ 가 GLM-5.2 MoE 를 지원)" >&2
  exit 1
fi

# GLM-5.2 공통 파서/기능 플래그. vLLM 은 checkpoint 에서 양자화를 자동 감지(--quantization 불필요).
ARGS=(
  serve "$MODEL"
  --served-model-name "$SERVED_NAME"
  --tensor-parallel-size "$TP"
  --enable-expert-parallel
  --trust-remote-code
  --reasoning-parser glm45        # GLM thinking → reasoning_content 로 분리
  --tool-call-parser glm47
  --enable-auto-tool-choice
  --kv-cache-dtype "$KV_CACHE_DTYPE"
  --max-model-len "$MAX_MODEL_LEN"
  --gpu-memory-utilization "$GPU_UTIL"
  --host "$HOST" --port "$PORT"
)
[[ -n "$MAX_NUM_SEQS" ]] && ARGS+=( --max-num-seqs "$MAX_NUM_SEQS" )
[[ -n "$API_KEY" ]] && ARGS+=( --api-key "$API_KEY" )
# shellcheck disable=SC2206
[[ -n "$EXTRA_ARGS" ]] && ARGS+=( $EXTRA_ARGS )

echo "🚀 GLM-5.2 vLLM 서빙  (profile=$PROFILE)"
echo "   model    : $MODEL"
echo "   arch     : $ARCH_NOTE"
echo "   served-id: $SERVED_NAME  (TokenLift onprem-glm model id 와 일치)"
echo "   listen   : http://$HOST:$PORT/v1   | tp=$TP | max-len=$MAX_MODEL_LEN | kv=$KV_CACHE_DTYPE"
echo "   auth     : $([[ -n "$API_KEY" ]] && echo on || echo off) | 멀티유저: vLLM 연속 배칭"
if [[ "$PROFILE" == "nvfp4" ]]; then
  echo "   ⚠️  NVFP4 는 Blackwell 전용입니다. H200 라면 PROFILE=fp8 로 실행하세요."
fi
echo
echo "   NemoClaw 연결(compatible-endpoint):"
echo "     NEMOCLAW_PROVIDER=custom NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:$PORT/v1 \\"
echo "       NEMOCLAW_MODEL=$SERVED_NAME COMPATIBLE_API_KEY=\"\$TOKEN\" nemoclaw onboard --non-interactive"
echo "   TokenLift 연결: onprem-glm.host=http://<이 서버>:$PORT  models=[$SERVED_NAME]"
echo
echo "+ $VLLM ${ARGS[*]}"
exec "$VLLM" "${ARGS[@]}"
