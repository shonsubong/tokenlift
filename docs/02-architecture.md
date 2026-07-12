# 02. 아키텍처

## 2.1 구성 요소 개요

TokenLift는 4개 레이어로 구성된다.

```
┌──────────────────────────────────────────────────────────────┐
│ L1. Claude Code 통합 레이어                                     │
│   - skills/tokenlift/SKILL.md   : 위임 판단/절차 지시           │
│   - agents/ollama-delegate.md   : 위임 전용 서브에이전트         │
│   - hooks/suggest-delegation.mjs: 프롬프트 자동 감지(선택)       │
└───────────────┬──────────────────────────────────────────────┘
                │ Bash 호출
                ▼
┌──────────────────────────────────────────────────────────────┐
│ L2. 브리지 CLI 레이어 (bin/tokenlift.mjs)                       │
│   - 인자 파싱 / 명령 디스패치 / 입출력 계약                       │
└───────────────┬──────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│ L3. 코어 모듈 레이어 (src/)                                      │
│   config · router(기밀 우선 라우팅) · tasks · logger(월 예산)     │
│   secure(NemoClaw 보안 자동 적용) · util                         │
│   providers/  ← 백엔드 추상화 (index · ollama · openai-compat)   │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTP (REST) — provider 어댑터가 프로토콜 흡수
                ▼
┌──────────────────────────────────────────────────────────────┐
│ L4. 추론 백엔드 (provider)                                       │
│   ollama        : /api/chat · /api/generate · /api/tags         │
│   openai-compat : /v1/chat/completions · /v1/completions · /v1/models │
│   (NVIDIA NemoClaw/NIM, vLLM, TGI, llama.cpp, LocalAI ...)       │
└──────────────────────────────────────────────────────────────┘
```

## 2.2 디렉토리 구조

```
TokenLift/
├── bin/
│   └── tokenlift.mjs          # CLI 엔트리(인자 파싱·디스패치·입출력)
├── src/
│   ├── config.mjs             # 설정 로딩/병합(기본<패키지<사용자<env)
│   ├── providers/             # 백엔드 추상화 레이어
│   │   ├── index.mjs          #   프로파일 해석 + 어댑터 팩토리
│   │   ├── ollama.mjs         #   Ollama 어댑터(ollama-client 래핑)
│   │   └── openai-compat.mjs  #   OpenAI 호환 어댑터(NemoClaw/NIM/vLLM/TGI)
│   ├── ollama-client.mjs      # Ollama REST 저수준 클라이언트(chat/generate/tags/warmup)
│   ├── router.mjs             # 기밀 신호 평가 + task→역할/모델 선택 + 위임 추천
│   ├── tasks.mjs              # 태스크별 프롬프트 빌더
│   ├── logger.mjs             # 사용량 JSONL 로깅 + 절감 추정/월 예산 집계
│   ├── secure.mjs             # NemoClaw 보안 자동 적용(Claude settings 병합·감사)
│   └── util.mjs               # 파일IO·코드추출·stdin·포맷 유틸
├── config/
│   └── tokenlift.config.json  # 팀 기본 설정(백엔드·역할 체인·단가/예산·보안)
├── skills/tokenlift/
│   ├── SKILL.md               # 메인 스킬(트리거·판단·절차·보안 규칙)
│   └── reference/
│       ├── cli-reference.md    # CLI 전체 참조
│       ├── routing-rules.md    # 위임 판단 상세 규칙(기밀 우선)
│       └── codebase-memory.md  # 그래프 탐색 도구 참조
├── agents/
│   ├── ollama-delegate.md     # executor/coder 위임 서브에이전트
│   └── onprem-oracle.md       # oracle(어려운 추론) 서브에이전트
├── hooks/
│   └── suggest-delegation.mjs # UserPromptSubmit 자동감지 훅(선택)
├── scripts/
│   ├── install.ps1 / install.sh   # 설치(스킬/에이전트 배포 + npm link)
│   ├── run-glm-nim.sh             # GLM-5.2 NIM Docker 서빙(공식 컨테이너)
│   ├── run-glm-vllm.sh            # GLM-5.2 vLLM 서빙(NVFP4/FP8)
│   └── run-glm-fleet.sh (+conf)   # GLM-5.2 GGUF 멀티 tier 서빙(llama.cpp)
└── docs/                      # 본 문서 세트
```

## 2.3 데이터 흐름 (위임 1건)

```
1. Claude 가 무거운 코딩 작업을 식별 (SKILL.md 규칙)
2. Bash: tokenlift test -f svc.py -o test_svc.py
3. bin/tokenlift.mjs
     → config.loadConfig()        # provider/모델 매핑/단가/타임아웃
     → providers.getProvider()    # 활성 provider 어댑터 생성(기본 ollama)
     → router.pickModel('test', profile)   # provider 라우팅에서 모델 결정
     → util.readFileSafe('svc.py')
     → tasks.buildTask('test', {files})    # system+user 프롬프트
     → provider.chat(...)         # ollama→/api/chat | openai-compat→/v1/chat/completions
4. 백엔드가 코드 생성 → {content, inTokens, outTokens, durationMs} 로 정규화

5. util.extractCode(content)      # ```펜스 제거, <think> 제거
6. logger.estimateSavings + logUsage  # ~/.tokenlift/usage.jsonl 기록
7. 출력:
     stdout = 저장 경로(또는 코드 본문)   ← Claude 가 받음
     stderr = model/토큰/시간/절감 추정    ← 메타(결과 비오염)
8. Claude 가 결과 검토 후 통합
```

## 2.4 입출력 계약 (설계 핵심)

브리지는 **stdout 을 순수 결과물 전용**으로 사용한다. 이것이 Claude 통합의 핵심이다.

| 모드 | stdout | stderr |
|---|---|---|
| 코드 태스크(기본) | 코드펜스 제거된 순수 코드 | model·토큰·시간·절감 |
| `-o`/`--apply` | 저장된 파일 경로 | 동일 |
| 분석 태스크 | 텍스트(요약/리뷰) | 동일 |
| `--json` | 전체 메타 포함 JSON | (없음) |
| `--quiet` | 결과물 | (억제) |

→ Claude 는 stdout 만 신뢰해 받으면 되고, 메타는 노이즈로 섞이지 않는다.

## 2.5 주요 설계 결정

| 결정 | 선택 | 이유 / 트레이드오프 |
|---|---|---|
| 위임 방식 | **외부 CLI 셸아웃** | 생성이 로컬에서 일어나야 Bedrock 토큰이 실제로 절감됨. 서브에이전트만으론 여전히 Claude 가 생성 → 절감 안 됨 |
| 런타임 | **Node ESM, 무의존성** | Node 18+ 내장 `fetch` 사용. 설치 마찰 최소화, 공급망 위험 0 |
| 출력 채널 분리 | **stdout=결과 / stderr=메타** | Claude 가 결과만 깔끔히 캡처 |
| 라우팅 | **설정 기반 task→model 매핑** | 사내 모델 구성에 맞게 JSON 만 수정 |
| **백엔드 추상화** | **provider 어댑터(통합 인터페이스)** | Ollama·OpenAI호환(NemoClaw/NIM)을 동일 인터페이스로. 백엔드 교체 시 상위 로직 불변 |
| 자동 위임 판단 | **키워드 휴리스틱(LLM 미사용)** | 즉시·무비용. 정밀도는 낮으나 안전(애매하면 Claude) |
| 절감 측정 | **로컬 처리 토큰 × Bedrock 단가** | 단순·투명. gross 추정임을 명시 |
| 실패 처리 | **친절한 에러 + Claude fallback** | 백엔드 다운 시 작업이 막히지 않음 |

## 2.6 의존성 / 상호작용

- **외부 런타임(생성)**: Ollama 또는 OpenAI 호환 백엔드(최소 1개). 없으면 친절한 오류 반환.
- **외부 MCP(탐색·권장)**: `codebase-memory-mcp` — 코드 탐색을 지식 그래프로 처리하는 별도
  서버. **TokenLift CLI 와 독립**이며 스킬 레벨에서 상호 보완(그래프=입력 절감, CLI=출력 절감).
  미연결 시 탐색은 Read/Grep 으로 graceful 동작.
- **외부 패키지**: 없음. Node 표준 라이브러리만 사용.
- **상태**: `~/.tokenlift/usage.jsonl`(로그), `~/.tokenlift/config.json`(개인 설정, 선택).
  그래프 인덱스는 codebase-memory-mcp 가 `~/.cache/codebase-memory-mcp/` 에 관리.
- **Claude Code**: 스킬/에이전트/훅 파일을 `~/.claude/` 하위로 배포(설치 스크립트).

## 2.7 확장 지점

- **새 태스크 추가**: `tasks.mjs` 에 케이스 + provider `routing.byTask` 매핑 + `bin` 디스패치.
- **새 모델 라우팅**: 해당 provider 의 `routing.byTask` 수정만으로 적용.
- **원격 Ollama/사내 게이트웨이**: `OLLAMA_HOST` 또는 `--host` 로 지정.
- **OpenAI 호환 백엔드(NemoClaw/NIM, vLLM, TGI ...)**: `config.providers.<name>` 에
  `type: "openai-compat"` 로 추가만 하면 됨. → [11. 백엔드 확장](11-providers.md)
- **비-OpenAI 백엔드(Triton 등)**: `src/providers/` 에 어댑터 모듈 추가 +
  `providers/index.mjs` 의 `createProvider` 에 타입 등록. 통합 인터페이스만 구현하면 됨.
