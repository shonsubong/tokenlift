# 14. GLM-5.2 를 llama.cpp 로 온프렘 서빙 + TokenLift 연동

GLM-5.2(Z.ai, 744B MoE / 40B 활성, 1M 컨텍스트)는 Claude Opus·GPT 급 벤치마크를 내는
**프런티어 오픈 모델**이다. Ollama 로는 부적합/미지원이라 **llama.cpp(`llama-server`)** 로
직접 서빙해야 한다. `llama-server` 는 OpenAI 호환 `/v1` 을 노출하므로, TokenLift 의
`openai-compat` provider 로 그대로 위임할 수 있다.

> 출처: [GeekNews — GLM-5.2 로컬 실행 가이드](https://news.hada.io/topic?id=30760),
> [Unsloth GLM Run Locally 문서](https://unsloth.ai/docs),
> [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp).

TokenLift 에서의 위치: **oracle 역할의 1순위(프런티어)**. 어려운 추론·대형 생성에서
`onprem-glm → onprem-h200 → onprem-v100 → claude` 순으로 폴백한다.

```
Claude(설계·검토)  →  onprem-glm = GLM-5.2 @ llama-server (/v1)  →  Claude(통합)
                      └ 어려운 추론/대형 생성을 Bedrock 대신 온프렘 프런티어로
```

## 14.1 양자화 선택 (메모리 요구)

| 양자화 | 크기(근사) | 정확도 | 필요 메모리(VRAM+RAM) | 권장 환경 |
|---|---|---|---|---|
| `UD-IQ1_S` (1bit) | ~223GB | ~76% | ~223GB | 메모리 빠듯할 때 |
| `UD-IQ2_M` / `UD-Q2_K_XL` (2bit) | ~239GB | ~82% | ~245GB | **H200 권장 시작점** |
| `UD-Q4_K_XL` (4bit) | ~380GB+ | 거의 무손실 | 372–475GB | 품질 우선(H200 다수) |

- **H200×8**(≈141GB×8 ≈ 1.1TB VRAM): 4bit 도 `-ngl 99` 전부 GPU 적재 가능(품질 최상).
  2bit 면 컨텍스트를 크게(수십만 토큰) 가져갈 여유가 생긴다.
- **V100×8**(32GB×8 = 256GB VRAM): Volta 라 저비트 동적 양자화 + **MoE CPU 오프로드**
  (`-ot`/`--n-cpu-moe`)로 2bit 를 끼워 넣는 수준. 속도는 H200 대비 크게 떨어진다 →
  GLM-5.2 는 H200 에 두고, V100 은 기존 coder(중소 모델)로 쓰는 편이 합리적.
- CPU 오프로드는 속도를 크게 떨어뜨린다. 가능한 한 VRAM 에 올리고, 부족분만 MoE 오프로드.

## 14.2 llama.cpp 빌드 (CUDA)

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
# 산출물: build/bin/llama-server, build/bin/llama-gguf-split
export PATH="$PWD/build/bin:$PATH"
```

## 14.3 모델 다운로드

```bash
pip install -U huggingface_hub
# 2bit 예시 (저장소·파일명은 실제 HF 배포명으로 확인)
hf download unsloth/GLM-5.2-GGUF --include "*UD-Q2_K_XL*" --local-dir ~/models/glm-5.2-gguf
```

분할(split) GGUF 는 **첫 shard** `…-00001-of-000NN.gguf` 를 지정하면 `llama-server` 가
나머지를 자동으로 이어 읽는다. 굳이 합치려면:

```bash
llama-gguf-split --merge GLM-5.2-...-00001-of-000NN.gguf merged.gguf
```

## 14.4 구동 — 제공 스크립트 사용 (권장)

리포의 [`scripts/run-glm-llamacpp.sh`](../scripts/run-glm-llamacpp.sh) 가 아래 핵심 플래그를
모두 조립한다. 환경변수로 덮어쓴다.

```bash
# 기본(2bit, 포트 8080, thinking on)
bash scripts/run-glm-llamacpp.sh

# 다운로드까지 한 번에 + 4bit + 컨텍스트 64k
DOWNLOAD=1 QUANT=UD-Q4_K_XL CTX=65536 bash scripts/run-glm-llamacpp.sh

# 추론(thinking) 비활성화로 구동(대량 코드 생성용, 빠르고 토큰 절약)
THINKING=off bash scripts/run-glm-llamacpp.sh

# VRAM 부족 시 MoE 전문가 레이어를 CPU(RAM)로 N개 오프로드 + KV 캐시 양자화로 컨텍스트 확장
N_CPU_MOE=24 KV_QUANT=q4_1 bash scripts/run-glm-llamacpp.sh

# 멀티 GPU(H200 4장만 사용)
CUDA_VISIBLE_DEVICES=0,1,2,3 bash scripts/run-glm-llamacpp.sh
```

주요 환경변수: `MODEL_REPO`, `QUANT`, `MODEL_DIR`, `MODEL_PATH`, `ALIAS`, `HOST`, `PORT`,
`NGL`, `CTX`, `TEMP/TOP_P/TOP_K/MIN_P`, `N_CPU_MOE`/`OFFLOAD_MOE`, `KV_QUANT`, `FLASH_ATTN`,
`THINKING`, `DOWNLOAD`.

## 14.5 구동 — 수동 명령 (참고)

```bash
llama-server \
  --model ~/models/glm-5.2-gguf/GLM-5.2-UD-Q2_K_XL-00001-of-000NN.gguf \
  --alias glm-5.2 \
  --host 0.0.0.0 --port 8080 \
  --jinja \                              # GLM chat 템플릿(멀티턴 안정) — 필수
  --n-gpu-layers 99 \
  --ctx-size 16384 \
  --temp 1.0 --top-p 0.95 --top-k 40 --min-p 0.0 \
  --flash-attn on \
  -ot ".ffn_.*_exps.=CPU" \              # (선택) MoE 전문가 → CPU. 신버전은 --n-cpu-moe N
  --cache-type-k q4_1 --cache-type-v q4_1 \   # (선택) KV 양자화 → 컨텍스트 ~3.5배
  --reasoning-budget 0                   # (선택) thinking 비활성화
```

- `--jinja` 는 **필수**(빠지면 멀티턴/툴콜 템플릿이 깨진다).
- thinking 을 켜면 응답이 `message.reasoning_content`(사고)와 `message.content`(최종답)로
  분리된다. TokenLift 어댑터는 `content`(최종답)를 취하고, 인라인 `<think>` 가 섞여 오면
  `stripThink` 로 제거한다.

## 14.6 TokenLift 연동

`onprem-glm` provider 가 기본 정의되어 있다(`config/tokenlift.config.json`,
`src/config.mjs`). `host` 를 사내 `llama-server` 주소로 바꾸고, **`models`/`routing` 의
모델 id 를 `llama-server --alias` 값(`glm-5.2`)과 일치**시키면 된다.

```jsonc
"providers": {
  "onprem-glm": {
    "type": "openai-compat",
    "host": "http://h200.internal:8080",   // ← llama-server 주소
    "apiPath": "/v1",
    "apiKeyEnv": "ONPREM_API_KEY",          // 인증 없으면 무시됨(에어갭)
    "supportsFIM": false,
    "models": ["glm-5.2"],                  // = --alias
    "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 40, "min_p": 0.0 },
    "routing": { "default": "glm-5.2", "byTask": { "reason": "glm-5.2", "gen": "glm-5.2" } }
  }
}
```

> `sampling` 은 GLM 권장 샘플링을 provider 에 중앙 고정한다. TokenLift 전역 기본값
> (`generation.temperature` 0.1)보다 우선하고, `--temp`/`--top-p` 등 **명시 플래그보다는
> 낮은** 우선순위다. 즉 별도 플래그 없이도 GLM 이 올바른 샘플링으로 돈다.

점검·사용:

```bash
tokenlift providers                     # onprem-glm 이 보이는지
tokenlift doctor --provider onprem-glm  # 연결/모델(/v1/models) 점검
tokenlift models --provider onprem-glm

# 어려운 추론을 GLM-5.2 로 위임(oracle 1순위). 실패 시 h200→v100→claude 자동 강등
tokenlift gen "동시성 안전한 작업 큐 구현" --role oracle --think on
tokenlift route "대규모 모듈 알고리즘 재설계"   # oracle=onprem-glm 추천 확인

# 직접 지정
tokenlift refactor "거대 함수 분리" -f big.ts --provider onprem-glm --apply
```

### thinking(추론) 토글 — 두 가지 층위
- **구동 시(전역)**: `THINKING=off` (→ `--reasoning-budget 0`). 그 서버는 thinking 없이 응답.
- **호출 시(요청별)**: `--think on|off`. openai-compat 백엔드에 `chat_template_kwargs:
  {enable_thinking}` 로 전달된다. 대량 코드 생성은 `--think off`(빠름/저토큰), 어려운 추론은
  `--think on` 을 권장. (모델/버전에 따라 요청별 비활성화가 안 먹으면 구동 시 `THINKING=off` 로.)

## 14.7 트러블슈팅

| 증상 | 원인/조치 |
|---|---|
| 멀티턴에서 템플릿 오류 | `--jinja` 누락. 반드시 추가. |
| OOM(메모리 부족) | 양자화 낮추기(4bit→2bit→1bit), `--ctx-size` 축소, `N_CPU_MOE`↑ 또는 `-ot` MoE 오프로드, `KV_QUANT=q4_1`. |
| 너무 느림 | CPU 오프로드 과다. VRAM 에 더 올리기(양자화↓/GPU 추가), `--ctx-size` 축소, GLM 은 H200 에. |
| thinking 이 안 꺼짐 | 모델/버전 이슈. 구동 시 `THINKING=off`(`--reasoning-budget 0`)로 강제. |
| `tokenlift doctor` 모델 미확인 | `--alias` 와 config `models`/`routing` 모델 id 불일치. 일치시킬 것. |
| 응답에 `<think>` 가 섞임 | reasoning 미분리. TokenLift 가 `stripThink` 로 제거하지만, `--reasoning-format auto`(jinja 기본)면 `reasoning_content` 로 분리된다. |
| usage(토큰) 0 으로 기록 | 일부 빌드가 usage 미반환. 절감 추정만 영향. |

## 14.8 비용/운영 메모

- GLM-5.2 풀 양자화 서빙은 **상시 구동 비용이 크다**(대용량 메모리 점유). 어려운 작업이
  몰릴 때만 띄우고, 평소 대량·정형 생성은 V100(coder, 중소 모델)으로 처리하는 하이브리드가
  비용 효율적이다. 실제 운영에서는 렌탈/API 가 더 쌀 수도 있으니 워크로드로 판단할 것.
- 연속 위임 전 `tokenlift warmup -m glm-5.2 --provider onprem-glm` 로 모델을 적재해 둔다
  (콜드 로드가 길다 — `--timeout` 을 넉넉히).
