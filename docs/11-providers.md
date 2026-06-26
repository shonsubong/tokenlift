# 11. 백엔드(Provider) 확장 — Ollama / NemoClaw(NIM)

TokenLift는 위임 대상 추론 백엔드를 **provider 추상화**로 분리한다. 기본은 로컬 **Ollama**이며,
사내 온프렘 **NVIDIA NemoClaw / NIM**(OpenAI 호환) 등 다른 백엔드로 손쉽게 전환·병행할 수 있다.

## 11.1 지원 백엔드 타입

| type | 대상 | 프로토콜 |
|---|---|---|
| `ollama` | 로컬 Ollama | Ollama REST (`/api/chat`, `/api/generate`) |
| `openai-compat` | **NemoClaw/NIM**, vLLM, TensorRT-LLM, TGI, **llama.cpp(`llama-server`)**, LocalAI | OpenAI 호환 (`/v1/chat/completions`, `/v1/completions`, `/v1/models`) |

> **GLM-5.2 등 대형 프런티어 오픈 모델**은 Ollama 미지원이라 `llama-server` 로 서빙하고
> `openai-compat` provider(`onprem-glm`)로 연동한다. 구동 스크립트·양자화·thinking 토글 등은
> **[14. GLM-5.2 를 llama.cpp 로 서빙](./14-glm-llamacpp.md)** 참조.

### openai-compat 확장 필드 (선택)
- `sampling`: 모델별 권장 샘플링 기본값 `{temperature, top_p, top_k, min_p, repeat_penalty}`.
  전역 `generation` 보다 우선하고 `--temp/--top-p` 등 명시 플래그보다는 낮은 우선순위.
  (예: GLM-5.2 → `temperature 1.0 / top_p 0.95 / top_k 40`)
- `extraBody`: 모든 요청 body 에 병합할 비표준 필드(예: llama.cpp `chat_template_kwargs`).
  호출별 값(`--think` 등)이 우선한다.

> NVIDIA **NemoClaw**는 NIM 기반의 엔터프라이즈 에이전트 플랫폼으로, 추론을 **OpenAI 호환
> 엔드포인트**로 노출한다(또는 그런 로컬 서버와 연동). 따라서 TokenLift는 `openai-compat`
> 어댑터로 NemoClaw/NIM에 위임한다.

## 11.2 동작 구조

```
bin/tokenlift.mjs
   └─ providers/index.mjs (getProviderProfile → createProvider)
        ├─ providers/ollama.mjs         (ollama-client 래핑)
        └─ providers/openai-compat.mjs  (NemoClaw/NIM/vLLM/TGI ...)
```

모든 provider 는 동일 인터페이스를 구현한다: `chat / generate / listModels / warmup / ping`.
CLI·라우터·로거는 이 인터페이스만 사용하므로 백엔드가 바뀌어도 상위 로직은 동일하다.

## 11.3 활성 백엔드 선택 (3가지)

```bash
# 1) 일회성: --provider 플래그
tokenlift gen "..." --provider nemoclaw

# 2) 세션/환경: 환경변수
export TOKENLIFT_PROVIDER=nemoclaw      # PowerShell: $env:TOKENLIFT_PROVIDER="nemoclaw"

# 3) 영구 기본값: 설정 파일
#    config/tokenlift.config.json 또는 ~/.tokenlift/config.json 의 "provider": "nemoclaw"
```

현재 설정 상태 확인:
```bash
tokenlift providers   # 설정된 백엔드 목록 + 활성 표시
```

## 11.4 NemoClaw / NIM 설정

`config/tokenlift.config.json`(팀) 또는 `~/.tokenlift/config.json`(개인)의
`providers.nemoclaw` 를 사내 환경에 맞게 수정한다.

```jsonc
{
  "provider": "ollama",                 // 기본은 ollama, 필요 시 "nemoclaw"
  "providers": {
    "nemoclaw": {
      "type": "openai-compat",
      "host": "http://nim.internal.company:8000",  // ← 사내 NIM/NemoClaw 게이트웨이
      "apiPath": "/v1",
      "apiKeyEnv": "NEMOCLAW_API_KEY",   // ← 이 환경변수에서 Bearer 키를 읽음(없으면 무인증)
      "supportsFIM": false,              // /v1/completions(FIM) 지원 시 true
      "models": [],                       // /v1/models 미지원 게이트웨이면 모델명 직접 나열
      "routing": {
        "default": "qwen/qwen2.5-coder-32b-instruct",
        "byTask": {
          "gen":      "qwen/qwen2.5-coder-32b-instruct",
          "test":     "qwen/qwen2.5-coder-32b-instruct",
          "explain":  "meta/llama-3.1-8b-instruct",
          "agent":    "nvidia/llama-3.1-nemotron-70b-instruct"
        }
      }
    }
  }
}
```

> ⚠️ **모델명은 실제 배포된 NIM 모델 ID와 일치해야 한다.** 기본값은 NVIDIA 카탈로그 예시일
> 뿐이다. `tokenlift models --provider nemoclaw` 로 서버가 제공하는 모델 목록을 확인하라.

### API 키 (인증)

NIM/NemoClaw가 인증을 요구하면 키를 **환경변수로** 둔다(설정 파일에 비밀을 저장하지 않음).

```bash
export NEMOCLAW_API_KEY="nvapi-xxxxxxxx"   # bash
$env:NEMOCLAW_API_KEY="nvapi-xxxxxxxx"      # PowerShell
```

어댑터는 키가 있으면 `Authorization: Bearer <키>` 헤더를 붙이고, 없으면 무인증으로 호출한다
(에어갭 로컬 서버 대비). 키 변수명은 `apiKeyEnv` 로 바꿀 수 있다.

## 11.5 점검 / 사용

```bash
# 연결·모델 점검 (활성 또는 --provider 지정)
tokenlift doctor --provider nemoclaw
tokenlift models --provider nemoclaw

# 위임 실행
tokenlift test -f src/payment.ts -o src/payment.test.ts --provider nemoclaw
tokenlift gen  "결제 검증 로직" --provider nemoclaw -m qwen/qwen2.5-coder-32b-instruct

# 누적 통계는 provider 별로 집계됨
tokenlift stats
```

## 11.6 하이브리드 운영 (Ollama + NemoClaw)

태스크별로 백엔드를 나눠 쓸 수 있다. 예: 가벼운 작업은 사내 V100 서버, 무거운/대형 모델이
필요한 작업은 H200 서버(또는 NIM).

```bash
# 빠른 보일러플레이트는 V100 서버(coder)
tokenlift gen "DTO 클래스" --role coder

# 대형 모델이 유리한 복잡 생성은 사내 NIM
tokenlift gen "도메인 서비스 구현체 일괄" --provider nemoclaw -m nvidia/llama-3.1-nemotron-70b-instruct
```

> NemoClaw 자체도 "민감도 기반 라우팅"(고민감→로컬 Nemotron, 저민감→클라우드)을 제공한다.
> TokenLift의 위임과 결합하면 **Claude(설계) → NemoClaw/Ollama(생산) → Claude(검토)** 의
> 다단 비용 최적화가 가능하다.

## 11.7 새 백엔드 추가

대부분의 온프렘 서빙(vLLM, TGI, TensorRT-LLM, LocalAI)은 OpenAI 호환이므로 `openai-compat`
타입으로 `providers.<name>` 만 추가하면 된다.

```jsonc
"providers": {
  "vllm": { "type": "openai-compat", "host": "http://vllm.internal:8000", "apiPath": "/v1",
            "routing": { "default": "Qwen/Qwen2.5-Coder-32B-Instruct" } }
}
```

OpenAI 호환이 아닌 백엔드(예: Triton KServe v2)는 `src/providers/` 에 새 어댑터 모듈을 만들고
`providers/index.mjs` 의 `createProvider` 스위치에 타입을 등록하면 된다. 통합 인터페이스
(`chat/generate/listModels/warmup/ping`)만 구현하면 CLI·라우터·로거는 수정이 필요 없다.

## 11.8 제약 / 주의

- **FIM(`complete`)**: OpenAI `/v1/completions` 의 `suffix` 에 의존한다. 일부 NIM/모델은
  미지원이다. 미지원이면 `gen`/`edit` 로 대체하라(`supportsFIM:false` 시 경고 출력).
- **모델 목록**: 일부 게이트웨이는 `/v1/models` 를 막아둔다. 그 경우 `providers.<name>.models`
  에 모델명을 직접 나열하면 `models`/`doctor` 가 그 목록을 사용한다.
- **`keep_alive`/`num_ctx`**: Ollama 전용 개념이라 `openai-compat` 에선 무시된다(서버측 설정).
- **토큰/절감 집계**: OpenAI 응답의 `usage.prompt_tokens`/`completion_tokens` 를 사용한다.
  일부 서버가 usage 를 안 주면 0 으로 기록될 수 있다.
