# 18. 실행자/조언자 멀티에이전트 — 보안 우선 라우팅과 $200 예산 운영

TokenLift 의 목표 시나리오를 하나의 아키텍처로 정리한다:

> **사내 온프렘 환경에서 여러 개발자가 Windows PC 의 WSL2 위 Bedrock 기반 Claude Code 에
> TokenLift 스킬을 설치**해 쓴다. 별도 온프렘 서버에는 **공식 NIM Docker 로 GLM-5.2 양자화
> 모델**이 서빙되고(NemoClaw 연동 가능), **보안(기밀) 검증을 먼저** 한 뒤 — **기밀이면 자동으로
> 사내 GLM-5.2(실행자)**, **기밀이 없고 더 높은 지능이 필요하면 Bedrock Claude(조언자)** 가
> 협력하는 멀티모델·멀티에이전트 구조. 탐색은 codebase-memory-mcp 그래프로 입력 토큰을
> 아끼고, **개발의 대부분은 무제한 사내 GLM-5.2**, 한정 자원인 **Bedrock 은 한 달 $200** 로
> 버틴다.

## 18.1 전체 그림

```
개발자 PC (Windows + WSL2)                         사내 온프렘 서버
┌────────────────────────────────────┐            ┌─────────────────────────────┐
│ Claude Code(Bedrock) + tokenlift 스킬 │            │  GLM-5.2 (NIM Docker, 양자화) │
│                                    │            │  = 실행자 executor / oracle   │
│  ① 기밀 검증(route) ──────────────┼── 기밀 ────▶  개발 대부분·기밀 작업 무제한  │
│  ② 탐색 = 그래프(무료, 로컬)        │   직결(예외)  │  (H200/V100 Ollama 폴백)     │
│  ③ 판단/조언 = Claude ─────────────┼── 비민감 ──▶ AWS Bedrock (조언자 advisor)  │
│      └ NemoClaw 게이트웨이(필터)     │   필터 경유   │  $200/월 예산, 아껴 쓰기      │
└────────────────────────────────────┘            └─────────────────────────────┘
```

핵심 흐름 — **모든 요청은 ①기밀 검증을 먼저 거친다**:

| 판정 | 경로 | 근거 |
|---|---|---|
| 기밀 신호 있음 | **사내 GLM-5.2 강제** (`bedrockAllowed:false`) | 유출 방지 — 외부 전송 자체를 차단 |
| 기밀 없음 + 고난도 판단 | **Claude = 조언자(advisor)** | 최고 지능이 필요한 곳에만 예산 사용 |
| 기밀 없음 + 개발 실행 | **GLM-5.2 = 실행자(executor)** | 무제한·전기값, Claude 는 검토만 |
| 코드 현황 파악 | **codebase-memory-mcp 그래프** | 입력 토큰 ~99%↓, 전부 로컬 |

## 18.2 보안 우선 라우팅 — 3중 방어

1. **내용 기반(이 문서의 핵심)** — `tokenlift route` 의 `assessSensitivity()` 가 기밀 신호를
   감지: 개인키·시크릿 할당·AWS/NGC 키·`.internal` 호스트·주민번호·"사내기밀/대외비" 키워드
   (+ `config.security.sensitivePatterns` 사용자 패턴 — 프로젝트 코드명 등). 감지되면 라우팅이
   **사내 GLM-5.2 로 강제**되고 Bedrock 승급이 금지된다.
   ```bash
   tokenlift route "결제 모듈 설계 검토 (api_key=sk_live_... 포함)"
   # → 기밀도: 🔒 HIGH (secret-assignment) / Bedrock 전송: ❌ 금지 / oracle=onprem-glm
   ```
2. **경로 기반** — `tokenlift secure` 가 Claude Code `permissions.deny` 로 민감 폴더를 아예
   못 읽게 한다(읽지 못한 내용은 어떤 프롬프트에도 못 들어감). → [15](./15-nemoclaw-windows-security.md)
3. **게이트웨이(보조)** — 그래도 Bedrock 으로 나가는 트래픽은 NemoClaw 게이트웨이가 PII/시크릿
   redaction. → [15](./15-nemoclaw-windows-security.md)

스킬 규칙: Claude 자신도 기밀 파일을 Read 해 Bedrock 컨텍스트에 올리지 않는다 — 그래프 쿼리
(로컬)나 `tokenlift explain`(사내 모델) 요약만 받는다. 판단이 필요하면 **기밀을 제거·추상화한
질문**만 Claude 에게 보낸다.

## 18.3 실행자/조언자 패턴 (역할)

`tokenlift roles`:

| 역할 | 체인 | 담당 |
|---|---|---|
| lead | claude | 오케스트레이션(Claude Code 자신) — 계획·위임·통합 |
| explorer | codebase-memory-mcp | 탐색(무료) |
| **executor(실행자)** | **GLM-5.2 → H200 → V100** | **개발 대부분**: gen/edit/test/refactor/translate/review + 기밀 작업 전부 |
| coder | V100 → H200 | 경량 정형(explain/docs/fast/FIM) |
| oracle | GLM-5.2 → H200 → V100 → claude | 어려운 추론·전략 백업 |
| **advisor(조언자)** | claude | **비민감** 고난도 판단·설계 조언 — 예산 관리 대상 |
| reviewer | claude | 최종 검토(기밀 제거 후) |

동작: task 가 executor 로 분류되면 CLI 가 GLM-5.2(NIM)에 직결 위임하고, 연결 실패 시
H200→V100 으로 자동 강등한다. oracle 의 최후 폴백만 claude 다(기밀이면 그 승급도 금지).

## 18.4 oh-my-openagent / hermes-agent 에서 가져온 것

| 참조 | 원본 아이디어 | TokenLift 반영 |
|---|---|---|
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | Sisyphus(오케스트레이터)–Hephaestus(실행)–Prometheus/Metis(자문) 역할 팀 | lead–**executor**–**advisor** 역할 분리 |
| 〃 | "모델이 아니라 **카테고리**를 고른다"(deep/quick/ultrabrain) | task→역할(카테고리) 라우팅(`TASK_ROLE`), 모델은 역할 체인이 결정 |
| 〃 | fallback_models 폴백 체인 | roles.chain 자동 강등(이미 반영, executor 체인 추가) |
| 〃 | 막히면 상위 모델에 "전략 백업" 요청 | oracle(GLM-5.2) 전략 백업 — Bedrock 이전 단계 |
| 〃 | 저비용 구독 조합·컨텍스트 예산 절약 | $200/월 예산 운영 + 그래프 탐색으로 컨텍스트 절약 |
| [hermes-agent](https://github.com/nousresearch/hermes-agent) | "어떤 모델이든, 커스텀 엔드포인트, 로크인 없음" | provider 추상화(ollama/openai-compat/NIM/vLLM/llama.cpp) |
| 〃 | 격리 서브에이전트 병렬화 | `ollama-delegate`/`onprem-oracle` 서브에이전트 격리 실행 |
| 〃 | 승인·컨테이너 격리(안전) | NemoClaw 샌드박스/게이트웨이 + `tokenlift secure` |

## 18.5 $200/월 예산 운영

- `config.pricing.monthlyBudgetUsd`(기본 200) — 팀 단가에 맞게 조정.
- `tokenlift stats` 가 **이번 달** 위임 횟수·Bedrock 환산 절감액·예산 대비 지표를 보여준다:
  ```
  이번 달(2026-07): 위임 132회, Bedrock 환산 절감 $87.40
  월 Bedrock 예산: $200.00 — 위임이 없었다면 예산의 약 44% 를 추가 소비했을 양을 사내에서 처리
  ```
- **정직한 한계**: TokenLift 는 Claude Code 가 실제로 쓴 Bedrock 토큰을 볼 수 없다(그건
  `claude /cost` 로 확인). stats 의 수치는 "위임하지 않았다면 Bedrock 에서 썼을 양"의 환산이다.
  두 수치를 함께 보며 위임 비중을 조절한다.
- 운영 수칙(스킬에 내장): Claude 출력(긴 코드) 금지 → executor 위임, 탐색은 그래프,
  Claude 는 판단·조언·검토만. 30줄+ 코드가 필요하면 무조건 위임 먼저 고려.

## 18.6 셋업 요약 (역할자별)

| 역할 | 할 일 | 문서 |
|---|---|---|
| 서버 관리자 | GLM-5.2 NIM Docker 서빙(`run-glm-nim.sh`) 또는 vLLM(`run-glm-vllm.sh`), 토큰 발급 | [16](./16-glm-multiquant-team.md) |
| 각 개발자 | WSL2 + NemoClaw 게이트웨이, TokenLift 설치, `secure init`, config 에 사내 호스트 | [17](./17-setup-and-usage.md) · [15](./15-nemoclaw-windows-security.md) |
| 팀 공통 | `security.sensitivePatterns` 에 사내 기밀 키워드(프로젝트 코드명 등) 등록, `pricing.monthlyBudgetUsd` 조정 | 이 문서 |

검증: `tokenlift route "<기밀 포함 작업>"` → `Bedrock 전송: ❌ 금지` 확인,
`tokenlift roles` → executor/advisor 체인 확인, `tokenlift stats` → 월 예산 지표 확인.
