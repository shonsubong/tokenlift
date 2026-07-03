# 16. GLM-5.2 온프렘 셋업 — NVIDIA 공식 양자화 우선 · 멀티유저

GLM-5.2 를 사내에 서빙하고 **여러 TokenLift 사용자**가 공유 엔드포인트로 쓰게 만든다.
**NVIDIA 공식 양자화(NVFP4) + vLLM 을 우선 경로**로, 저VRAM 환경은 Unsloth GGUF + llama.cpp
를 대안으로 둔다. NemoClaw 는 GLM-5.2 를 직접 호스팅하지 않고, 이 서버로 라우팅한다
(`vllm-local` / `compatible-endpoint`).

> 출처: [nvidia/GLM-5.2-NVFP4](https://huggingface.co/nvidia/GLM-5.2-NVFP4) ·
> [zai-org/GLM-5.2-FP8](https://huggingface.co/zai-org/GLM-5.2-FP8) ·
> [vLLM GLM-5.2 recipe](https://recipes.vllm.ai/zai-org/GLM-5.2) ·
> [unsloth/GLM-5.2-GGUF](https://huggingface.co/unsloth/GLM-5.2-GGUF) ·
> [NemoClaw: Use a Local Inference Server](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/inference/use-local-inference)

## 16.1 어떤 양자화를 쓸까 — 하드웨어로 결정

| 양자화(model id) | 만든 곳 | 엔진 | 필요 HW | 언제 |
|---|---|---|---|---|
| **NVFP4** `glm-5.2-nvfp4` ([nvidia/GLM-5.2-NVFP4](https://huggingface.co/nvidia/GLM-5.2-NVFP4)) | **NVIDIA 공식** | vLLM/SGLang | **Blackwell 전용**(B200/B300/GB200) | **1순위**. Blackwell 있으면 이것 |
| **FP8** `glm-5.2-fp8` ([zai-org/GLM-5.2-FP8](https://huggingface.co/zai-org/GLM-5.2-FP8)) | **Z.ai 공식** | vLLM/SGLang | **H200/H20(Hopper) 네이티브 FP8** | **H200 이면 이것**(8×H200 적재) |
| GGUF `glm-5.2-q4`/`q2` ([unsloth/GLM-5.2-GGUF](https://huggingface.co/unsloth/GLM-5.2-GGUF)) | Unsloth(커뮤니티) | llama.cpp/Ollama | 광범위(CPU offload) | 저VRAM·혼합·에어갭 대안 |

> ⚠️ **NVFP4 는 Blackwell 전용**입니다. FP4 텐서코어가 Blackwell(B200/GB200 등)에만 있어
> **H200(Hopper)에서는 실행되지 않습니다.** H200 클러스터면 **Z.ai 공식 FP8**(`glm-5.2-fp8`)을
> 쓰세요 — Hopper 네이티브 FP8 이라 가속 손실이 없고 8×H200 에 적재됩니다.

### Ollama 로는? — 온프렘 GLM-5.2 는 지원 안 됨(중요)

TokenLift 의 다른 모델(qwen/deepseek 등)은 온프렘 Ollama 로 서빙하지만, **GLM-5.2 는 Ollama 로
온프렘(로컬) 구동이 사실상 불가**하다:
- 공식 Ollama 라이브러리 [`ollama.com/library/glm-5.2`](https://ollama.com/library/glm-5.2) 는
  현재 **`glm-5.2:cloud` 태그뿐**이고, 이는 **Z.ai 클라우드로 라우팅**된다(추론이 외부에서 실행 →
  데이터가 사내망을 벗어남 → **온프렘/프라이버시 목적에 부적합**). 로컬 양자화 태그(q4/q2)는 없다.
- Unsloth GGUF 를 Modelfile 로 수동 임포트하는 건 이론상 가능하나, 744B 분할 GGUF 라 실무적으로
  비권장(공식 방법 없음, 대용량 메모리 필요).
- **결론**: 온프렘 GLM-5.2 는 **vLLM(NVFP4/FP8) 또는 llama.cpp(GGUF)** 로 서빙한다. NemoClaw 도
  GLM-5.2 는 `ollama-local` 이 아니라 **`vllm-local` / `compatible-endpoint`** 로 이 서버에 연결한다.
  (`ollama-local` 경로 자체는 존재하지만 GLM-5.2 로컬 태그가 없어 이 모델엔 쓸 수 없다.)

## 16.2 우선 경로 — vLLM 서빙 (NVIDIA 공식 NVFP4 / Z.ai FP8)

[`scripts/run-glm-vllm.sh`](../scripts/run-glm-vllm.sh) 가 프로파일별로 vLLM 을 구동한다.
vLLM 은 연속 배칭으로 **멀티유저 동시성**이 우수하다.

```bash
# Blackwell(B200/B300): NVIDIA 공식 NVFP4  (1순위)
PROFILE=nvfp4 TP=8 PORT=8000 API_KEY="$TEAM_TOKEN" bash scripts/run-glm-vllm.sh

# H200(Hopper): Z.ai 공식 FP8
PROFILE=fp8   TP=8 PORT=8000 API_KEY="$TEAM_TOKEN" bash scripts/run-glm-vllm.sh
```

내부적으로 실행되는 핵심 명령(자동 조립):
```bash
vllm serve nvidia/GLM-5.2-NVFP4 \
  --served-model-name glm-5.2-nvfp4 \
  --tensor-parallel-size 8 --enable-expert-parallel --trust-remote-code \
  --reasoning-parser glm45 --tool-call-parser glm47 --enable-auto-tool-choice \
  --kv-cache-dtype fp8_e4m3 --max-model-len 131072 \
  --host 0.0.0.0 --port 8000            # FP8 은 zai-org/GLM-5.2-FP8 + kv fp8_e5m2
```
- vLLM 이 checkpoint 에서 **양자화를 자동 감지**(별도 `--quantization` 불필요).
- `--served-model-name` = TokenLift `onprem-glm` 의 model id 와 일치시킬 것(`glm-5.2-nvfp4`/`fp8`).
- 멀티유저: `--host 0.0.0.0`(사내망 공유), 동시성은 `MAX_NUM_SEQS`(=`--max-num-seqs`)로 조정.
- 인증: `API_KEY`(→ `--api-key`) 로 Bearer 토큰. 각 사용자는 `ONPREM_API_KEY` 로 동일 값 사용.
- vLLM 0.19.0+ 필요(GLM-5.2 MoE 지원). 모델은 최초 실행 시 HF 에서 자동 다운로드.

### NVIDIA NIM Docker — 공식 컨테이너 (가장 간단)

GLM-5.2 는 **NVIDIA 공식 NIM Docker 컨테이너**로도 제공된다(NGC 카탈로그
[`nim/zai-org/glm-5.2`](https://catalog.ngc.nvidia.com/orgs/nim/zai-org/containers/glm-5.2)).
NIM-for-LLMs 런타임 + **SGLang 프로파일**로 돌고, OpenAI 호환 `/v1` 을 노출한다. 가중치를
직접 받아 vLLM 을 세팅하는 것보다 간단하다.

**양자화 지원 — 예, NIM 은 양자화를 "기본"으로 쓴다.** NIM 은 감지한 HW 에 맞는 최적 프로파일을
자동 선택하는데, **양자화 엔진(fp8 등)이 있으면 메모리·지연·처리량 이점 때문에 기본으로 그것을
고른다**(양자화 엔진도 fp16 과 동일 정확도 기준으로 검증됨). 프로파일 이름의 숫자 포맷이
정밀도다(`fp8`=8bit 양자화 vs `fp16`=비양자화). GLM-5.2 는 **FP8 이 권장 배포**이고 Blackwell 에선
**NVFP4** 도 가능하다. NIM 정밀도 선호순위: `MXFP4 > FP8 > INT8 > FP16 > BF16 > … > NVFP4`,
백엔드 선호: `tensorrt_llm > vllm > sglang`.
- 프로파일 목록: `docker run ... <image> list-model-profiles`
- 특정 프로파일 강제: `-e NIM_MODEL_PROFILE=<id>` (예: fp8 프로파일 고정) — `scripts/run-glm-nim.sh`
  의 `NIM_MODEL_PROFILE` 로 전달.

```bash
# NGC API 키 발급(ngc.nvidia.com) 후
NGC_API_KEY=nvapi-... bash scripts/run-glm-nim.sh
# 내부적으로:
#   docker login nvcr.io -u '$oauthtoken' -p $NGC_API_KEY
#   docker run --rm --gpus all --ipc=host -e NGC_API_KEY=$NGC_API_KEY \
#     -v ~/.cache/nim:/opt/nim/.cache -p 8000:8000 nvcr.io/nim/zai-org/glm-5.2:<tag>
```
- **HW**: 8×B200 / 8×H20 / 8×H200 또는 GPU 메모리 900GB+, 디스크 **736GB+**.
- **model id**: 기동 후 `curl -s http://localhost:8000/v1/models` 로 확인해 TokenLift `onprem-glm`
  의 `models`/`routing.default` 와 (NemoClaw 연결 시) `NEMOCLAW_MODEL` 에 그 값을 쓴다.
- ⚠️ 정확한 이미지 org/경로/**태그**는 NGC 카탈로그 페이지에서 확인해 교체할 것(프로덕션은 고정 태그).

> **정리 — GLM-5.2 의 두 가지 NVIDIA 배포**:
> 1) **NIM Docker**(`nvcr.io/nim/zai-org/glm-5.2`) = 공식 **컨테이너**(SGLang, HW별 프로파일 자동).
> 2) **NVFP4 체크포인트**([`nvidia/GLM-5.2-NVFP4`](https://huggingface.co/nvidia/GLM-5.2-NVFP4)) =
>    **가중치**(Docker 아님). vLLM(`vllm/vllm-openai`)·SGLang(`lmsysorg/sglang`) 공개 이미지로 실행.

### NemoClaw 에 붙이기 — NVIDIA 공식 NVFP4 (정확 절차)

NVIDIA 는 GLM-5.2 를 [`nvidia/GLM-5.2-NVFP4`](https://huggingface.co/nvidia/GLM-5.2-NVFP4)
(가중치, vLLM 공식 지원)와 **NIM Docker**(`nvcr.io/nim/zai-org/glm-5.2`)로 배포했다. NemoClaw 는
이 모델을 **직접 호스팅하지 않고**, 위에서 띄운 **OpenAI 호환 `/v1` 서버(NIM · vLLM · llama.cpp)**
에 아래 두 경로 중 하나로 붙는다(NVIDIA 문서 기준).

**경로 A — compatible-endpoint (권장): 내가 띄운 vLLM 에 연결**
```bash
# 1) 위 16.2 로 vLLM 서빙 (served-model-name = glm-5.2-nvfp4, 포트 8000)
# 2) NemoClaw 온보드에서 "Other OpenAI-compatible endpoint" 선택
nemoclaw onboard        # → Endpoint URL / Model ID / API Key 입력

# 비대화형(동일):
NEMOCLAW_PROVIDER=custom \
  NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:8000/v1 \
  NEMOCLAW_MODEL=glm-5.2-nvfp4 \
  COMPATIBLE_API_KEY="$TEAM_TOKEN" \
  nemoclaw onboard --non-interactive
```
- **Endpoint URL**: 샌드박스에서 호스트로 닿는 주소 — 보통 `http://host.openshell.internal:8000/v1`
  (localhost 아님. 샌드박스→`inference.local`→OpenShell L7 프록시→이 URL 로 포워딩).
- **Model ID**(`NEMOCLAW_MODEL`): vLLM `--served-model-name` 과 **정확히 일치**(`glm-5.2-nvfp4`).
  서버의 `/v1/models` 가 반환하는 값이다.
- **API Key**: vLLM 을 `--api-key` 로 띄웠으면 그 토큰, 아니면 `dummy` 가능.
- 확인: `nemoclaw <name> status` 의 "Inference" 행.

**경로 B — managed vLLM (실험): NemoClaw 가 vLLM 을 직접 관리**
```bash
NEMOCLAW_EXPERIMENTAL=1 NEMOCLAW_VLLM_MODEL=<레지스트리 slug> nemoclaw onboard
```
- NemoClaw 가 `nemoclaw-vllm` 컨테이너를 시작/재시작하고 `/v1/models` 로 모델을 기록한다.
- 기존에 `localhost:8000` 에 vLLM 이 떠 있으면 그걸 사용할 수도 있다.

**주의**
- ⚠️ **NVFP4 는 Blackwell 전용** — H200 이면 `PROFILE=fp8`(zai-org/GLM-5.2-FP8)로 서빙하고
  `NEMOCLAW_MODEL=glm-5.2-fp8` 로 붙인다.
- **콜드 로드 타임아웃**: `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` 를 넉넉히. compatible-endpoint 가
  이 값을 미반영해 60s 로 끊기는 이슈(#2403)가 있으니 스트림이 끊기면 버전 확인.
- 이 절차는 **NemoClaw 가 감싸는 에이전트(OpenClaw/Hermes)** 의 추론을 GLM-5.2 로 보내는 것이다.
  **TokenLift/Claude Code** 는 `onprem-glm` provider 로 vLLM 에 **직결**하며(보안 예외, docs/15),
  NemoClaw 게이트웨이는 외부 Bedrock 트래픽에만 관여한다 — 둘은 별개 경로다.

## 16.3 대안 경로 — GGUF + llama.cpp (저VRAM/혼합)

Blackwell 도 없고 8×H200 FP8 적재도 어려운 환경은 Unsloth GGUF 를 llama.cpp 로 서빙한다
(양자화 tier q4/q2, MoE CPU 오프로드). fleet 스크립트로 여러 tier 를 띄운다:

```bash
HOST=0.0.0.0 API_KEY="$TEAM_TOKEN" bash scripts/run-glm-fleet.sh start
bash scripts/run-glm-fleet.sh status
```
매니페스트([`scripts/glm-fleet.example.conf`](../scripts/glm-fleet.example.conf))에서 tier(alias/
quant/port)를 정의한다. tier 별 크기: q2(UD-IQ2_M)~239GB, q4(UD-Q4_K_XL) 거의 무손실, q8(Q8_0)
~801GB. ⚠️ 대형 tier 여러 개 동시 적재는 대개 불가 → 노드로 나누거나 메모리에 맞는 것만.
자세한 llama.cpp 플래그는 [14. GLM-5.2 × llama.cpp](./14-glm-llamacpp.md).

이 경로를 쓰면 TokenLift 에 GGUF 용 provider 를 별도로 둔다(`~/.tokenlift/config.json`):
```jsonc
"providers": {
  "onprem-glm-gguf": {
    "type": "openai-compat", "host": "http://gpu.internal:8084", "apiPath": "/v1",
    "apiKeyEnv": "ONPREM_API_KEY", "timeoutMs": 1800000,
    "models": ["glm-5.2-q4", "glm-5.2-q2"],
    "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 40 },
    "routing": { "default": "glm-5.2-q4", "byTask": { "explain": "glm-5.2-q2", "docs": "glm-5.2-q2" } }
  }
}
```
사용: `tokenlift gen "..." --provider onprem-glm-gguf`.

## 16.4 TokenLift 설정 (onprem-glm = vLLM/NVIDIA 우선)

기본 `onprem-glm` 은 vLLM 엔드포인트를 가리키고 NVIDIA 공식 NVFP4 를 default 로 둔다.
**H200 이면 default 를 `glm-5.2-fp8` 로 한 줄만 바꾸면 된다.**

```jsonc
"onprem-glm": {
  "type": "openai-compat",
  "host": "http://h200.internal:8000",      // ← vLLM 엔드포인트
  "apiPath": "/v1", "apiKeyEnv": "ONPREM_API_KEY", "timeoutMs": 1800000,
  "models": ["glm-5.2-nvfp4", "glm-5.2-fp8"],
  "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 40, "min_p": 0.0 },
  "routing": { "default": "glm-5.2-nvfp4" }  // H200 은 "glm-5.2-fp8"
}
```
- vLLM 은 단일 모델이 높은 동시성으로 모든 task 를 처리 → task 별 tier 라우팅이 불필요.
  호출별로 강제하려면 `-m glm-5.2-fp8`.
- Oracle 역할 1순위(`onprem-glm → onprem-h200 → onprem-v100 → claude`)라 어려운 추론·대형
  생성이 이 서버로 위임된다.

```bash
tokenlift models  --provider onprem-glm       # served 모델 확인
tokenlift doctor  --provider onprem-glm        # 연결 점검
tokenlift gen "동시성 안전한 작업 큐" --role oracle --think on
```

## 16.5 멀티유저 온보딩 (각 사용자 PC)

서버 관리자는 16.2(또는 16.3)로 1회 서빙한다. 각 사용자는:

1. 공유 엔드포인트를 가리키게 한다(`~/.tokenlift/config.json`, 팀 기본을 덮어씀):
   ```jsonc
   { "providers": { "onprem-glm": { "host": "http://glm.internal:8000",
                                    "routing": { "default": "glm-5.2-fp8" } } } }
   ```
2. 발급받은 토큰:
   ```bash
   export ONPREM_API_KEY="사용자토큰"     # bash / WSL2
   $env:ONPREM_API_KEY="사용자토큰"        # PowerShell
   ```
3. 점검·사용:
   ```bash
   tokenlift doctor --provider onprem-glm
   tokenlift warmup --provider onprem-glm -m glm-5.2-fp8   # 콜드 로드 미리(대형은 김)
   ```

Windows 사용자는 [15. NemoClaw 보안](./15-nemoclaw-windows-security.md) 의 `tokenlift secure`
로 외부 Bedrock 은 게이트웨이 필터, **온프렘 GLM(vLLM) 엔드포인트는 `exemptHosts` 직결(예외)**
로 둔다. 사내 GLM 위임은 필터 없이 빠르게, 외부 Bedrock 만 보안 필터를 거친다.

## 16.6 주의
- **HW 매칭이 최우선**: NVFP4=Blackwell, FP8=H200(Hopper). 잘못 고르면 안 뜨거나 느리다.
- **model id 일치**: vLLM `--served-model-name` = TokenLift `models`/`routing` id.
- **콜드 로드/타임아웃**: 대형 모델은 로드가 길다. `timeoutMs`(30분) 유지, warmup 활용.
  NemoClaw `compatible-endpoint` 는 `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` 미반영 이슈(#2403)
  가 있으니 스트림이 60s 로 끊기면 버전/설정 확인.
- **동시성**: vLLM `--max-num-seqs` 또는 GGUF 경로면 llama-server `-np` 로 사용자 수에 맞게.
