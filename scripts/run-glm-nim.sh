#!/usr/bin/env bash
# run-glm-nim.sh — GLM-5.2 를 NVIDIA 공식 NIM Docker 컨테이너로 서빙(OpenAI 호환 /v1).
# NGC 카탈로그의 GLM-5.2 NIM 을 pull/run 한다. 양자화는 NIM 이 HW 에 맞는 프로파일
# (SGLang 백엔드, FP8/NVFP4 등)로 내부 최적화한다 — 사용자가 quant 를 직접 고르지 않는다.
# TokenLift onprem-glm(openai-compat) / NemoClaw(compatible-endpoint) 가 이 서버에 붙는다.
#
# 사용:
#   NGC_API_KEY=nvapi-... bash scripts/run-glm-nim.sh
#   NGC_API_KEY=... TAG=<태그> PORT=8000 bash scripts/run-glm-nim.sh
#
# 참고: https://catalog.ngc.nvidia.com/orgs/nim/zai-org/containers/glm-5.2
#       https://docs.nvidia.com/nim/large-language-models/latest/  (배포 상세)
set -euo pipefail

# NGC NIM 이미지. 정확한 org/경로/태그는 위 NGC 카탈로그 페이지에서 확인해 교체할 것.
IMAGE="${IMAGE:-nvcr.io/nim/zai-org/glm-5.2}"
TAG="${TAG:-latest}"                       # ⚠️ 프로덕션은 NGC 의 고정 버전 태그 권장
PORT="${PORT:-8000}"
CACHE_HOST="${CACHE_HOST:-$HOME/.cache/nim}"   # 모델 가중치 캐시(재기동 시 재다운로드 방지)
CACHE_CONTAINER="${CACHE_CONTAINER:-/opt/nim/.cache}"  # NIM 버전에 따라 다를 수 있음(문서 확인)
NAME="${NAME:-glm-5.2-nim}"
SHM="${SHM:-16g}"
# 양자화/엔진 프로파일. 비우면 NIM 이 HW 에 맞는 최적 프로파일 자동 선택(양자화 fp8 등 우선).
# 특정 프로파일 강제 시 id 지정. 목록: LIST=1 bash scripts/run-glm-nim.sh
NIM_MODEL_PROFILE="${NIM_MODEL_PROFILE:-}"
LIST="${LIST:-0}"

# 인증 키(필수). NGC(ngc.nvidia.com)에서 발급.
if [[ -z "${NGC_API_KEY:-}" ]]; then
  echo "❌ NGC_API_KEY 가 필요합니다. NGC 에서 API 키를 발급해 export 하세요." >&2
  echo "   export NGC_API_KEY=nvapi-..." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker 를 찾을 수 없습니다. Docker + nvidia-container-toolkit 를 설치하세요." >&2
  exit 1
fi

echo "🔐 nvcr.io 로그인..."
echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin

mkdir -p "$CACHE_HOST"

# 사용 가능한 (양자화 포함) 프로파일 목록만 출력하고 종료
if [[ "$LIST" == "1" ]]; then
  echo "📋 사용 가능한 model profile(양자화 fp8/nvfp4 등 포함):"
  exec docker run --rm --gpus all -e NGC_API_KEY="$NGC_API_KEY" "$IMAGE:$TAG" list-model-profiles
fi

echo "🚀 GLM-5.2 NIM 서빙"
echo "   image : $IMAGE:$TAG"
echo "   listen: http://0.0.0.0:$PORT/v1  (OpenAI 호환)"
echo "   cache : $CACHE_HOST → $CACHE_CONTAINER"
echo "   HW    : 8×B200 / 8×H20 / 8×H200 또는 GPU 메모리 900GB+, 디스크 736GB+ 필요"
echo "   (최초 기동은 가중치 다운로드/커널 컴파일로 오래 걸릴 수 있음)"
echo

RUN=(
  docker run --rm --name "$NAME"
  --gpus all --ipc=host --shm-size "$SHM"
  -e NGC_API_KEY="$NGC_API_KEY"
)
[[ -n "$NIM_MODEL_PROFILE" ]] && RUN+=( -e NIM_MODEL_PROFILE="$NIM_MODEL_PROFILE" )
RUN+=(
  -v "$CACHE_HOST:$CACHE_CONTAINER"
  -p "$PORT:8000"
  "$IMAGE:$TAG"
)
[[ -n "$NIM_MODEL_PROFILE" ]] && echo "   profile: $NIM_MODEL_PROFILE (강제)" || echo "   profile: 자동 선택(양자화 fp8 우선). 목록: LIST=1 bash scripts/run-glm-nim.sh"
echo "+ ${RUN[*]}"
echo
echo "   기동 후 model id 확인: curl -s http://localhost:$PORT/v1/models | jq -r '.data[].id'"
echo "   → 그 id 를 TokenLift onprem-glm 의 models/routing.default 와 NemoClaw NEMOCLAW_MODEL 에 사용"
echo "   NemoClaw 연결: NEMOCLAW_PROVIDER=custom \\"
echo "     NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:$PORT/v1 \\"
echo "     NEMOCLAW_MODEL=<위 id> COMPATIBLE_API_KEY=\"\$NGC_API_KEY\" nemoclaw onboard --non-interactive"
echo
exec "${RUN[@]}"
