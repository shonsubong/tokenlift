#!/usr/bin/env bash
# run-glm-llamacpp.sh — 사내 H200/V100 에서 GLM-5.2(744B MoE) 양자화 모델을
# llama.cpp(llama-server)로 띄워 OpenAI 호환 /v1 엔드포인트로 노출한다.
# TokenLift 의 provider 'onprem-glm'(type: openai-compat)이 이 서버에 위임한다.
#
# GLM-5.2 는 Ollama 로 부적합/미지원이라 llama.cpp 로 직접 서빙해야 한다.
# 모든 설정은 환경변수로 덮어쓸 수 있다(아래 기본값 참조).
#
# 사용:
#   bash scripts/run-glm-llamacpp.sh                 # 기본값으로 구동
#   QUANT=UD-Q2_K_XL PORT=8080 bash scripts/run-glm-llamacpp.sh
#   THINKING=off bash scripts/run-glm-llamacpp.sh    # 추론(thinking) 비활성화로 구동
#   DOWNLOAD=1 bash scripts/run-glm-llamacpp.sh      # GGUF 자동 다운로드 후 구동
#
# 참고: https://news.hada.io/topic?id=30760 (GLM-5.2 로컬 실행 가이드)
#       https://unsloth.ai/docs (GLM 계열 llama.cpp 실행 플래그)
set -euo pipefail

# ─────────────────────────── 설정(환경변수로 override) ───────────────────────────
# llama.cpp 바이너리. PATH 에 있으면 그대로, 아니면 LLAMA_SERVER 로 절대경로 지정.
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"

# HuggingFace GGUF 저장소 / 양자화 / 로컬 경로.
# ⚠️ 저장소·파일명은 실제 HF 배포명으로 확인할 것(아래는 Unsloth 동적 양자화 관례 기준).
MODEL_REPO="${MODEL_REPO:-unsloth/GLM-5.2-GGUF}"
QUANT="${QUANT:-UD-Q2_K_XL}"            # 1bit:UD-IQ1_S(~223GB) 2bit:UD-IQ2_M/UD-Q2_K_XL(~239GB) 4bit:UD-Q4_K_XL(거의 무손실)
MODEL_DIR="${MODEL_DIR:-$HOME/models/glm-5.2-gguf}"
# 직접 경로를 알면 MODEL_PATH 로 지정(분할 GGUF 는 첫 shard …-00001-of-000NN.gguf 를 가리킴).
MODEL_PATH="${MODEL_PATH:-}"

# 서빙 파라미터
ALIAS="${ALIAS:-glm-5.2}"               # /v1/models 가 노출할 모델 id (TokenLift onprem-glm 의 모델명과 일치)
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
NGL="${NGL:-99}"                        # GPU 로 올릴 레이어 수(99=가능한 전부)
CTX="${CTX:-16384}"                     # 컨텍스트 윈도우(GLM-5.2 최대 1M, VRAM/RAM 에 맞게)
PARALLEL="${PARALLEL:-1}"               # 동시 처리 슬롯(-np)

# 권장 샘플링(GLM-5.2 / Unsloth·Z.ai). TokenLift 도 provider.sampling 으로 동일하게 보냄.
TEMP="${TEMP:-1.0}"
TOP_P="${TOP_P:-0.95}"
TOP_K="${TOP_K:-40}"
MIN_P="${MIN_P:-0.0}"

# 메모리 절약 옵션
#  - N_CPU_MOE: 신버전 llama.cpp 의 MoE 전문가 레이어 CPU 오프로드 개수(--n-cpu-moe).
#    비우면 정규식 -ot ".ffn_.*_exps.=CPU" 로 전 전문가 텐서를 CPU(RAM)로 내린다.
#  - KV_QUANT: KV 캐시 양자화(q4_1/q8_0). 비우면 양자화 안 함(품질 우선). q4_1 ≈ 컨텍스트 3.5배.
N_CPU_MOE="${N_CPU_MOE:-}"
OFFLOAD_MOE="${OFFLOAD_MOE:-1}"         # 1이면 N_CPU_MOE 미지정 시 -ot 정규식으로 MoE→CPU
KV_QUANT="${KV_QUANT:-}"
FLASH_ATTN="${FLASH_ATTN:-on}"          # KV 양자화 사용 시 on 필요

# 추론(thinking): on(기본, 서버/템플릿 기본값) | off(--reasoning-budget 0 으로 강제 비활성화)
THINKING="${THINKING:-on}"

DOWNLOAD="${DOWNLOAD:-0}"               # 1이면 hf 로 GGUF 다운로드 시도

# ─────────────────────────── 사전 점검 ───────────────────────────
if ! command -v "$LLAMA_SERVER" >/dev/null 2>&1 && [[ ! -x "$LLAMA_SERVER" ]]; then
  echo "❌ llama-server 를 찾을 수 없습니다: '$LLAMA_SERVER'" >&2
  echo "   빌드: git clone https://github.com/ggml-org/llama.cpp && cmake -B build -DGGML_CUDA=ON && cmake --build build -j" >&2
  echo "   또는 LLAMA_SERVER=/path/to/llama-server 로 지정하세요." >&2
  exit 1
fi

# ─────────────────────────── (선택) GGUF 다운로드 ───────────────────────────
if [[ "$DOWNLOAD" == "1" ]]; then
  if command -v hf >/dev/null 2>&1; then HF=hf
  elif command -v huggingface-cli >/dev/null 2>&1; then HF=huggingface-cli
  else
    echo "❌ DOWNLOAD=1 이지만 hf/huggingface-cli 가 없습니다. pip install -U huggingface_hub" >&2
    exit 1
  fi
  echo "⬇️  $MODEL_REPO ($QUANT) → $MODEL_DIR 다운로드 중..."
  mkdir -p "$MODEL_DIR"
  "$HF" download "$MODEL_REPO" --include "*${QUANT}*" --local-dir "$MODEL_DIR"
fi

# ─────────────────────────── 모델 경로 결정(분할 GGUF 첫 shard 탐색) ───────────────────────────
if [[ -z "$MODEL_PATH" ]]; then
  # 우선 …-00001-of-000NN.gguf (분할) 그다음 단일 .gguf
  MODEL_PATH="$(ls "$MODEL_DIR"/*"${QUANT}"*-00001-of-*.gguf 2>/dev/null | head -n1 || true)"
  if [[ -z "$MODEL_PATH" ]]; then
    MODEL_PATH="$(ls "$MODEL_DIR"/*"${QUANT}"*.gguf 2>/dev/null | head -n1 || true)"
  fi
fi
if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
  echo "❌ GGUF 모델 파일을 찾을 수 없습니다." >&2
  echo "   MODEL_DIR=$MODEL_DIR / QUANT=$QUANT 에서 탐색 실패." >&2
  echo "   - DOWNLOAD=1 로 받거나, MODEL_PATH 로 첫 shard(.gguf)를 직접 지정하세요." >&2
  echo "   - 분할 파일은 …-00001-of-000NN.gguf 를 가리키면 llama-server 가 자동으로 이어 읽습니다." >&2
  exit 1
fi

# ─────────────────────────── 인자 조립 ───────────────────────────
ARGS=(
  --model "$MODEL_PATH"
  --alias "$ALIAS"
  --host "$HOST" --port "$PORT"
  --jinja                              # GLM 올바른 chat 템플릿(멀티턴 안정) — 필수
  --n-gpu-layers "$NGL"
  --ctx-size "$CTX"
  --parallel "$PARALLEL"
  --temp "$TEMP" --top-p "$TOP_P" --top-k "$TOP_K" --min-p "$MIN_P"
)

# Flash Attention
[[ -n "$FLASH_ATTN" ]] && ARGS+=( --flash-attn "$FLASH_ATTN" )

# MoE 전문가 레이어 CPU 오프로드(대형 모델을 제한된 VRAM 에 적재)
if [[ -n "$N_CPU_MOE" ]]; then
  ARGS+=( --n-cpu-moe "$N_CPU_MOE" )
elif [[ "$OFFLOAD_MOE" == "1" ]]; then
  ARGS+=( -ot ".ffn_.*_exps.=CPU" )
fi

# KV 캐시 양자화(컨텍스트 확장)
if [[ -n "$KV_QUANT" ]]; then
  ARGS+=( --cache-type-k "$KV_QUANT" --cache-type-v "$KV_QUANT" )
fi

# 추론(thinking) 비활성화
if [[ "$THINKING" == "off" ]]; then
  ARGS+=( --reasoning-budget 0 )
fi

# ─────────────────────────── 구동 ───────────────────────────
echo "🚀 GLM-5.2 llama-server 구동"
echo "   model   : $MODEL_PATH"
echo "   alias   : $ALIAS  (TokenLift onprem-glm 모델 id 와 일치해야 함)"
echo "   listen  : http://$HOST:$PORT/v1"
echo "   ctx     : $CTX | ngl: $NGL | sampling: temp $TEMP / top_p $TOP_P / top_k $TOP_K"
echo "   thinking: $THINKING | kv_quant: ${KV_QUANT:-none} | moe_offload: ${N_CPU_MOE:-${OFFLOAD_MOE:+regex}}"
echo "   (멀티 GPU 는 CUDA_VISIBLE_DEVICES 로 가시 GPU 지정 → -ngl 99 가 자동 분산)"
echo
echo "+ $LLAMA_SERVER ${ARGS[*]}"
exec "$LLAMA_SERVER" "${ARGS[@]}"
