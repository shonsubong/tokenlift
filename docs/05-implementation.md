# 05. 구현 상세

무의존성 Node.js(ESM) 구현. Node 18+ 내장 `fetch`/`AbortController` 만 사용한다.

## 5.1 모듈 맵

| 파일 | 책임 | 주요 export |
|---|---|---|
| `bin/tokenlift.mjs` | 인자 파싱·명령 디스패치·입출력 라우팅 | `main()` |
| `src/config.mjs` | 설정 로딩/병합/메모이즈 | `loadConfig()`, `configPaths()` |
| `src/providers/index.mjs` | provider 프로파일 해석·어댑터 팩토리 | `getProviderProfile`, `createProvider`, `getProvider`, `resolveProviderName`, `listProviderNames` |
| `src/providers/ollama.mjs` | Ollama 어댑터(통합 인터페이스) | `createOllamaProvider` |
| `src/providers/openai-compat.mjs` | OpenAI 호환 어댑터(NemoClaw/NIM 등) | `createOpenAICompatProvider` |
| `src/ollama-client.mjs` | Ollama REST 저수준 호출 | `chat`, `generate`, `listModels`, `warmup`, `ping` |
| `src/router.mjs` | 기밀 신호 평가·역할/모델 선택·위임 추천 | `assessSensitivity()`, `pickModel()`, `recommend()`, `resolveRole()` |
| `src/tasks.mjs` | 태스크별 프롬프트 빌더 | `buildTask()`, `TASK_LIST` |
| `src/logger.mjs` | 사용량 로깅·절감 추정·월 예산 집계 | `estimateSavings`, `logUsage`, `readStats`, `formatStats` |
| `src/secure.mjs` | NemoClaw 보안 자동 적용(Claude settings 병합·백업·감사) | `getSecurity`, `buildGeneratedSettings`, `mergeSettings`, `auditPosture` |
| `src/util.mjs` | 파일IO·코드추출·stdin·포맷 | `extractCode`, `stripThink`, `readStdin`, ... |

### Provider 통합 인터페이스

모든 백엔드 어댑터는 동일 시그니처를 구현한다(상위 로직은 이것만 사용):

```
chat({model, messages, options, timeoutMs})            -> {content, inTokens, outTokens, durationMs, model, raw}
generate({model, prompt, suffix, options, timeoutMs})  -> {...}   // FIM
listModels({timeoutMs})                                -> [{name, ...}]
warmup({model, timeoutMs})                             -> {model, durationMs}
ping({timeoutMs})                                      -> boolean
name, type, supportsFIM
```

`openai-compat` 어댑터는 응답을 정규화한다: `choices[0].message.content` → content,
`usage.prompt_tokens/completion_tokens` → in/out 토큰, 소요시간은 wall-clock(`performance.now`).
자세한 설정/확장은 [11. 백엔드 확장](11-providers.md).

## 5.2 설정 스키마 (`tokenlift.config.json`)

```jsonc
{
  "provider": "ollama",               // 활성 백엔드(ollama | nemoclaw | ...)
  "ollama": {                          // 기본(ollama) 백엔드 — 하위호환 위해 최상위 유지
    "host": "http://localhost:11434", // Ollama 엔드포인트
    "timeoutMs": 600000,              // 요청 타임아웃(대형 모델 콜드로드 대비)
    "keepAlive": "30m",              // 모델 메모리 상주 시간
    "numCtx": 8192                    // 기본 컨텍스트 윈도우
  },
  "providers": {                       // 추가 백엔드 (ollama 외)
    "nemoclaw": {                      // OpenAI 호환(NVIDIA NemoClaw/NIM 등)
      "type": "openai-compat",
      "host": "http://localhost:8000",
      "apiPath": "/v1",
      "apiKeyEnv": "NEMOCLAW_API_KEY", // 이 환경변수에서 Bearer 키
      "supportsFIM": false,
      "models": [],                    // /v1/models 미지원 시 수동 목록
      "routing": { "default": "qwen/qwen2.5-coder-32b-instruct", "byTask": { "...": "..." } }
    }
  },
  "routing": {                         // ollama 의 라우팅(하위호환)
    "default": "qwen2.5-coder:14b",  // task 매핑 없을 때
    "byTask": { "gen": "qwen2.5-coder:14b", "...": "..." },
    "fallback": "gemma3:4b"          // (예비) 라우팅 실패 대비
  },
  "pricing": {                        // 절감 추정용 Bedrock 단가(USD/1M)
    "label": "claude-sonnet-on-bedrock",
    "inputPer1M": 3.0,
    "outputPer1M": 15.0
  },
  "thresholds": {                     // Claude 가 참고하는 위임 임계값
    "delegateMinOutputLines": 30,
    "delegateMinFileLines": 300,
    "delegateMinFiles": 3
  },
  "generation": { "temperature": 0.1, "topP": 0.9 },
  "logging": { "enabled": true, "file": "~/.tokenlift/usage.jsonl" }
}
```

### 설정 병합 우선순위

```
내장 DEFAULTS  <  config/tokenlift.config.json(패키지/팀)  <  ~/.tokenlift/config.json(개인)  <  환경변수
```

`config.mjs` 의 `deepMerge()` 가 객체는 재귀 병합, 배열/원시값은 덮어쓴다.

### 환경변수 오버라이드

| 변수 | 키 |
|---|---|
| `OLLAMA_HOST` / `TOKENLIFT_HOST` | `ollama.host` |
| `TOKENLIFT_MODEL` | `routing.default` |
| `TOKENLIFT_TIMEOUT_MS` | `ollama.timeoutMs` |
| `TOKENLIFT_NO_LOG=1` | `logging.enabled=false` |
| `TOKENLIFT_PROVIDER` | `provider` (활성 백엔드) |
| `NEMOCLAW_API_KEY`* | nemoclaw Bearer 키 (*`apiKeyEnv` 로 변경 가능) |

## 5.3 Ollama 클라이언트

- **`chat()`** → `POST /api/chat` (`stream:false`). 반환을 정규화:
  `{ content, inTokens(prompt_eval_count), outTokens(eval_count), durationMs(total_duration/1e6), model, raw }`.
- **`generate()`** → `POST /api/generate`. `suffix` 지정 시 **FIM(중간 채우기)**.
- **`listModels()`** → `GET /api/tags`. 이름/크기/파라미터/계열 추출.
- **`warmup()`** → 빈 프롬프트 `generate` 로 모델만 메모리 적재.
- **`ping()`** → 헬스 체크.
- **에러 처리**: 타임아웃(`AbortController`)은 안내 메시지, 연결거부(`ECONNREFUSED`)는
  "Ollama 실행 확인" 가이드를 담은 `OllamaError` 로 변환.

## 5.4 태스크 프롬프트 빌더 (`tasks.mjs`)

각 태스크는 `{mode, system, user}` (또는 FIM 은 `{mode:'fim', prompt, suffix}`)를 만든다.

설계 포인트:
- **코드 태스크 시스템 프롬프트**(`CODE_ONLY_SYSTEM`)는 "설명 없이 단일 코드펜스만" 출력을
  강제한다. 로컬 모델이 잡담을 붙이는 경향을 억제.
- `edit`/`refactor` 는 "**전체 파일** 반환"을 명시(부분 발췌 방지).
- `translate` 는 소스(`--lang`)→대상(`--to`) 언어를 명시.
- `explain`/`review` 는 한국어로 **구조화된 항목** 요약/발견사항만 출력.
- 입력 파일들은 `--- FILE: path ---` 헤더로 직렬화해 다중 파일 컨텍스트 제공.

## 5.5 라우터 (`router.mjs`)

- **`pickModel(task, config, override)`**: override > `byTask[task]` > `default`.
- **`assessSensitivity(text, config)`**: 기밀 신호 감지 → `{sensitive, matches}`.
  내장 패턴(개인키/시크릿/AWS·NGC 키/`.internal`/주민번호/기밀 키워드) +
  `config.security.sensitivePatterns`(문자열 포함 또는 `/정규식/i`).
- **`recommend(description, config)`**: 키워드 휴리스틱으로
  `{route, role, task, model, confidence, reason, sensitivity, bedrockAllowed, sensitiveMatches?}` 반환.
  순서 = ⓪ 기밀 평가(항상) → ① 고난도 신호(기밀이면 사내 oracle 강제, 비민감이면 advisor)
  → ② 위임 신호(구체 task 우선; 기밀이면 executor 승급) → ③ 기본(기밀=executor / 비민감=Claude).

## 5.6 로거 (`logger.mjs`)

- **`estimateSavings({inTokens, outTokens, pricing})`**:
  `grossUsd = in*inputPer1M/1e6 + out*outputPer1M/1e6` (Bedrock 환산 대체비용, gross).
- **`logUsage(entry, config)`**: `~/.tokenlift/usage.jsonl` 에 `{ts, task, model, inTokens,
  outTokens, grossUsd, durationMs}` 한 줄 append. 로깅 실패는 무시(본 작업 비방해).
- **`readStats`/`formatStats`**: JSONL 집계 → 총량/태스크별/모델별 통계.

> 비용 추정의 의미와 한계는 [07. 비용 분석](07-cost-analysis.md)에서 자세히 다룬다.

## 5.7 유틸 (`util.mjs`) — 견고성 포인트

- **`extractCode(text)`**: ```` ```lang ... ``` ```` 블록만 추출(여러 개면 연결), 없으면 원문.
- **`stripThink(text)`**: `<think>`/`<thinking>` 추론 블록 제거(r1/qwq 대응).
- **`readStdin(graceMs=400)`**: 파이프 입력 지원. **비대화형 셸에서 입력이 없을 때
  EOF 무한 대기하지 않도록**, 첫 데이터가 유예시간 내 없으면 빈 문자열로 반환.
  (실제 파이프는 즉시 데이터를 흘리므로 안전.)
- **`expandHome` / `writeFileSafe` / `readFileSafe`**: `~` 확장 + 상위 디렉토리 자동 생성.

## 5.8 CLI 디스패치 (`bin/tokenlift.mjs`)

1. `parseArgs()`: `--flag val`, `-x` 별칭, 불리언 플래그(`--quiet/--json/--apply/--no-log`),
   나머지는 위치인자(`_`). 음수 인자 오인 방지 처리 포함.
2. 운영 명령(`models/stats/doctor/warmup/route`)을 먼저 분기.
3. 태스크 명령: 위치인자→(없으면)stdin 으로 instruction 확보, `-f` 파일 로드.
4. `complete` 는 `generate`(FIM), 그 외는 `chat`.
5. 결과 가공: 코드 태스크는 `extractCode`, 그 외는 `stripThink`.
6. 출력 라우팅: `--json` / `-o|--apply`(파일+경로) / 기본(stdout 결과) + stderr 메타.
7. 사용량 로깅.

## 5.9 코드 규모 / 의존성

- 외부 npm 의존성: **0개**.
- 런타임: Node 18+ (내장 `fetch`, `AbortController`, ESM).
- 상태 파일: `~/.tokenlift/usage.jsonl`, (선택)`~/.tokenlift/config.json`.

## 5.10 테스트 현황 (정직한 고지)

현재 자동화된 단위 테스트는 포함되어 있지 않다. 검증은 실제 Ollama 호출 기반 수동
스모크 테스트로 수행했다(doctor/models/route/gen/explain/complete/stats/hook 동작 확인).
프로덕션 도입 시 `tasks.buildTask`·`router.recommend`·`util.extractCode`/`stripThink`
순수 함수에 대한 단위 테스트 추가를 권장한다.
