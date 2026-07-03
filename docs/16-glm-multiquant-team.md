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
