---
name: tokenlift
description: >-
  Claude Code(Bedrock)의 토큰 비용을 줄인다. (1) 코드베이스 탐색/이해는 codebase-memory-mcp
  지식 그래프를 "기본"으로 사용해 파일 통독 대신 구조 쿼리로 입력 토큰을 절감하고, (2) 대량
  코드 생성·테스트·리팩터링·이식 등 무거운 출력 작업은 로컬 Ollama/온프렘 NemoClaw 로 위임하며,
  (3) 설계·보안·복잡 디버깅 등 고난도 판단만 Claude 가 직접 한다. 코드 탐색/검색/영향분석,
  "토큰 아끼기", "Ollama/로컬로 돌려", "그래프로 찾아", "비용 절감" 요청 시 사용.
---

# TokenLift — 그래프 탐색 + 로컬 위임으로 Bedrock 토큰 절감

## 핵심 원리 (왜 토큰이 절감되는가) — 3개의 기둥

Bedrock 과금에서 **출력 토큰이 입력의 약 5배** 비싸고, 코드베이스 탐색은 파일을 반복해서
읽느라 **입력 토큰**을 크게 쓴다. TokenLift는 비싼 토큰 소비를 세 방향으로 옮긴다.

1. **탐색 위임 (입력 절감) — `codebase-memory-mcp` 지식 그래프 [기본]**
   코드를 "이해/탐색"할 때 파일을 통째로 읽거나 grep 을 반복하지 말고, 로컬 지식 그래프에
   구조 쿼리를 던진다. 5개 구조 쿼리 ≈ 3,400 토큰 vs 파일별 탐색 ≈ 412,000 토큰(약 99% 절감,
   논문 기준 10× 절감). 모든 처리는 로컬, 코드는 외부로 나가지 않는다.
2. **생성 위임 (출력 절감) — `tokenlift` CLI → Ollama/NemoClaw**
   길게 생성되는 코드(보일러플레이트, 테스트, 리팩터링 결과)를 로컬/온프렘 모델이 생성.
   Claude 는 짧은 결과만 읽고 검토 → 비싼 **출력 토큰**을 아낌.
3. **고난도 판단 — Claude(Bedrock)**
   설계·보안·복잡 디버깅·의사결정과, 위 두 위임 결과의 **검토·통합**만 Claude 가 담당.

Claude 의 역할은 **오케스트레이션 + 판단 + 검토**로 축소된다. 탐색은 그래프가, 생성은 로컬이 맡는다.

## 코드 탐색은 지식 그래프 먼저 (기본 규칙)

코드베이스를 이해·검색·추적해야 할 때 **먼저 `codebase-memory-mcp` 도구를 쓴다. 파일 통독/
대량 grep 은 그래프로 답이 안 나올 때만.** (MCP 가 연결돼 있지 않으면 평소처럼 처리)

1. **인덱스 확인/생성** — `mcp__codebase-memory-mcp__list_projects` 로 현재 프로젝트가
   인덱싱됐는지 확인. 없으면 `index_repository(repo_path)` 1회 실행(평균 수 초~밀리초).
2. **구조 파악** — `get_architecture` 로 레이어/진입점/핫스팟/패키지 경계/클러스터를 한 번에.
3. **심볼 찾기** — `search_graph(query="자연어")`(BM25) 또는 `search_code` 로 정의/구현 위치를
   파일 통독 없이. grep/glob 대신 사용.
4. **관계 추적** — `trace_path`(호출자/피호출자·데이터흐름·교차서비스)로 영향분석. grep 대신.
5. **정확히 한 조각만 읽기** — 위치 확정 후 `get_code_snippet(qualified_name)` 으로 해당
   함수/클래스만. 파일 전체 Read 대신.
6. **변경 영향** — `detect_changes` 로 git diff 의 영향 범위/리스크. `query_graph`(Cypher)로
   복잡도·병목·다중홉 분석.

상세 도구·예시는 `reference/codebase-memory.md` 참조. 이렇게 모은 "정확한 컨텍스트"를 필요 시
생성 위임(아래)의 입력으로 넘기면 입력·출력 토큰을 동시에 아낀다.

## 에이전트 협업 & 멀티모델 라우팅 (역할 분담)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) 식 **오케스트레이터-워커**
모델. **Claude(Bedrock)는 "AI 팀 리드"** 로서 직접 다 하지 않고 컨텍스트를 린하게 유지하며
싸고 빠른 백엔드에 위임한다. 제약: 외부 모델은 **Claude=Bedrock 전용**, 온프렘은 **H200×8 /
V100×8** 로 오픈모델을 서빙(OpenAI 호환). 비용은 항상 **가장 싼 충분한 단계**부터.

**H200×8 / V100×8 은 하드웨어**이고, 그 위에서 **Ollama(여러 특화 모델)** 또는 **NemoClaw**
를 서빙한다. 역할마다 **폴백 체인**(OmO fallbackChain 반영)을 두고, 앞에서부터 호출 가능한
백엔드를 쓰되 **실패하면 다음으로 자동 강등**한다.

| 역할 | 폴백 체인 | 담당 | CLI |
|---|---|---|---|
| **lead** (오케스트레이터) | claude | 의도파악·계획·위임·통합 | (Claude 자신) |
| **explorer** | codebase-memory-mcp | 코드 탐색/검색/영향분석 | MCP 그래프 |
| **executor** (실행자) | **GLM-5.2 → H200 → V100** | **개발 대부분**·기밀 포함 작업(사내 전용) | `--role executor` |
| **coder** | **V100 → H200** | 경량·정형 생성(요약/문서/FIM) | `--role coder` |
| **oracle** | **GLM-5.2 → H200 → V100 → claude** | 어려운 추론·대형 생성 | `--role oracle` |
| **advisor** (조언자) | claude | **비민감** 고난도 판단·설계 조언 | (Claude 자신) |
| **reviewer** | claude | 보안·최종 검토·의사결정(기밀 제거 후) | (Claude 자신) |

**실행자/조언자 패턴** (oh-my-openagent 의 Hephaestus/Prometheus 대응): 개발의 대부분은
**실행자 = 사내 GLM-5.2**(무제한·기밀 안전)가 수행하고, **조언자 = Claude(Bedrock)** 는
기밀 없는 고난도 판단·설계 조언·최종 검토에만 아껴 쓴다(월 예산 관리 대상).

**비용 최소화 에스컬레이션 사다리** (싼 → 비싼):
`그래프(무료) → V100(coder) → H200 → GLM-5.2(executor/oracle, 사내 무제한) → Bedrock(claude)`.
충분히 처리되는 가장 싼 단계에서 멈춘다. 한 단계가 막히면(연결 실패→자동 강등, 품질 부족→
수동 승급) 다음 단계로. **Bedrock 은 최후**(판단·보안·최종검토 전용).

규칙:
- 개발 실행(생성·수정·테스트·리팩터·이식) → `--role executor`(GLM-5.2). 경량 정형(요약/문서) →
  `--role coder`(V100). 어려운 추론·알고리즘·성능/동시성 → `--role oracle`.
  `tokenlift route "<작업>"` 가 역할·티어·**기밀도**를 추천한다.
- 여러 작업은 **병렬 위임**으로 메인 컨텍스트를 아낀다(`ollama-delegate`/`onprem-oracle`
  서브에이전트로 격리 실행 — hermes-agent 의 "격리 서브에이전트 병렬화" 패턴).
- 막혔을 때 Claude 가 계속 헛도는 대신 **oracle(GLM-5.2)에 전략 백업**을 요청(OmO 의 "GPT 5.2
  전략 백업"을 온프렘 프런티어 오픈모델로 대체).
- 현재 팀 구성은 `tokenlift roles`, 백엔드는 `tokenlift providers` 로 확인.

## 보안 우선 라우팅 (기밀 = 사내 강제) — 위임 전 반드시 검증

**모든 위임/판단 전에 다룰 내용의 기밀성을 먼저 평가한다.** `tokenlift route "<작업>"` 가
기밀 신호(개인키·시크릿·`.internal` 호스트·주민번호·"사내기밀/대외비" 등 + `config.security.
sensitivePatterns` 사용자 패턴)를 감지해 `기밀도`와 `Bedrock 전송 허용/금지`를 알려준다.

| 기밀도 | 처리 |
|---|---|
| **기밀 신호 있음(HIGH)** | **사내 GLM-5.2(executor/oracle)로 강제.** Claude(Bedrock) 프롬프트에 기밀 원문을 넣지 않는다 — 판단이 필요하면 기밀을 제거·추상화한 질문만 Claude 에게. |
| 기밀 없음 + 고난도 판단 | **advisor(Claude)** 가 직접 — 설계·트레이드오프·최종 검토 |
| 기밀 없음 + 개발 실행 | **executor(GLM-5.2)** 위임 — 결과만 Claude 가 검토 |

- Claude(에이전트 자신)도 이 규칙을 따른다: 기밀 파일/내용을 Read 해서 Bedrock 컨텍스트에
  올리지 말고, 그래프 쿼리(로컬)나 `tokenlift explain`(사내 모델) 결과 요약만 받는다.
- 폴더 수준 차단은 `tokenlift secure`(permissions.deny)가 담당 — 이 규칙은 그 보조(내용 기반).

## Bedrock 예산 관리 ($200/월) — Claude 는 아껴 쓰는 자원

Bedrock(Claude) 토큰은 **한 달 $200 예산** 안에서 버텨야 하는 한정 자원이다. 원칙:
- **Claude 의 출력(코드)을 최소화**한다 — 긴 코드는 항상 executor(GLM-5.2)가 생성하고 Claude
  는 검토·보정만. Claude 가 30줄 넘는 코드를 직접 쓰려 하면 위임을 먼저 고려.
- 탐색은 그래프(무료), 실행은 사내(전기값), Claude 는 판단·조언(예산)에만.
- `tokenlift stats` 가 이번 달 위임 절감액과 예산 대비 지표를 보여준다. 실제 소비는
  Claude Code `/cost` 로 확인하고, 초과 조짐이면 위임 비중을 더 높인다.

## 보안 게이트웨이 자동 적용 (Windows/WSL2 · NemoClaw)

사내 Windows PC 에서 Claude Code(Bedrock)를 쓸 때, **외부 Bedrock 트래픽은 NemoClaw
게이트웨이를 경유(PII redaction/정책 필터)**하고 **사내 온프렘 LLM(H200/V100/GLM)은
직결(보안 예외)**, **민감 폴더는 읽기 차단**하도록 강제한다. TokenLift 가 이를 자동화한다.

**세션 시작 시(사내 환경 판단되면) 먼저 점검한다:**
```bash
tokenlift secure doctor      # 게이트웨이 경유 + 온프렘 예외 + 민감폴더 차단 적용 여부
```
- 미충족(❌)이면 사용자에게 알리고 `tokenlift secure init` 적용을 제안한다(기존 settings.json
  보존 + 백업, 멱등). 적용 후 Claude Code 재시작이 필요하다.
- 적용 대상/게이트웨이 주소/민감 경로는 `config.security` 가 단일 소스다(`tokenlift secure status`).
- **왜 안전한가**: Bedrock 만 게이트웨이로 보내고 온프렘은 `NO_PROXY` 직결로 예외 처리한다.
  민감 폴더 유출의 실질 방어선은 `permissions.deny`(읽기 자체 차단)이며, 게이트웨이 필터는 보조다.
- TokenLift 위임 자체가 Bedrock 사용을 줄이므로(탐색=그래프, 생성=온프렘) 외부 노출 표면이 작다.

상세: `docs/15-nemoclaw-windows-security.md`.

## 위임 판단 규칙 (가장 중요)

| 작업 성격 | 처리 주체 | 이유 |
|---|---|---|
| **코드 탐색/이해/검색/호출추적/영향분석** | **codebase-memory-mcp (그래프)** | 파일 통독 대신 구조 쿼리 → 입력 토큰 ~99%↓ |
| 명세가 명확한 코드 생성, 보일러플레이트, 스캐폴딩 | **Ollama/NemoClaw** | 출력 多, 판단 少 |
| 단위 테스트 생성 | **Ollama/NemoClaw** | 반복적·패턴적 |
| 일괄 리팩터링(이름변경, 패턴치환, 함수분리) | **Ollama/NemoClaw** | 기계적·대량 |
| 언어/프레임워크 이식(translate) | **Ollama/NemoClaw** | 규칙 기반 변환 |
| 대용량 비코드 파일/로그 요약 | **Ollama** (`explain`) | 입력 컨텍스트 절감 |
| docstring/주석/문서 초안 | **Ollama/NemoClaw** | 정형적 생성 |
| **아키텍처·시스템 설계, API/인터페이스 설계** | **Claude(advisor)** | 고난도 판단(단, 현황 파악은 그래프로) |
| **복잡한 디버깅(근본원인 추적), 전체시스템 영향 분석** | **Claude(advisor)** | 깊은 추론 |
| **보안 로직의 "판단"(인증/권한/취약점)** | **Claude(advisor)** — 기밀 원문 제거 후 | 위험·정확성 |
| **기밀(민감) 데이터/코드가 포함된 모든 작업** | **사내 GLM-5.2(executor)** — Bedrock 전송 금지 | 유출 방지(보안 우선 라우팅) |
| **요구사항 모호, 트레이드오프 의사결정** | **Claude(advisor)** | 맥락·책임 |
| **위임 산출물의 최종 검토·통합** | **Claude** | 품질 게이트 |

판단이 애매하면 `tokenlift route "<작업 설명>"` 으로 추천을 받거나, 기본적으로 Claude가 처리한다.

휴리스틱 임계값(이 이상이면 위임 고려): 생성 코드 30줄+, 처리 파일 300줄+, 동일 패턴 3파일+.

## 표준 작업 절차

0. **탐색(필요 시) — 그래프 먼저.** 코드 현황을 알아야 하면 `codebase-memory-mcp` 로
   인덱스 확인 → `get_architecture`/`search_graph`/`trace_path`/`get_code_snippet` 으로
   필요한 부분만 파악한다(파일 통독 금지).
1. **감지** — 요청 중 위 표의 "Ollama/NemoClaw" 행에 해당하는 무거운 생성 작업을 식별한다.
2. **위임** — 해당 부분만 잘라 `tokenlift <task>` 로 로컬 실행한다(아래 명령 참조).
   직접 코드를 길게 생성하지 말 것 — 그게 토큰 절감의 핵심이다. 그래프로 모은 정확한
   컨텍스트(스니펫)를 지시/입력으로 넘기면 더 정확하고 더 싸다.
3. **검토** — 로컬 모델은 Claude보다 약하다. 반환된 코드를 **반드시 검토**한다:
   요구사항 충족 여부, 명백한 버그, 스타일 일치, 보안 문제. 필요한 부분만 Claude가 보정한다.
4. **통합** — 검증된 결과를 파일에 반영한다(`-o`/`--apply` 로 모델이 직접 쓰게 하거나,
   stdout 을 받아 Claude가 Edit 으로 반영).
5. **보고** — 무엇을 그래프로 파악하고 무엇을 위임·검토했는지 간단히 알린다.
   `tokenlift stats` 로 누적 절감 확인.

## CLI 빠른 참조

> 전제: `tokenlift` 가 PATH에 있어야 한다(`npm link` 설치 시). 없으면
> `node "<설치경로>/bin/tokenlift.mjs"` 로 호출한다. 설치는 `reference/cli-reference.md` 참조.

```bash
# 코드 생성 (stdout = 코드)
tokenlift gen "Express 에러 핸들링 미들웨어" --lang ts

# 파일 수정 후 그 파일에 덮어쓰기
tokenlift edit "모든 함수에 입력 검증 추가" -f src/api.js --apply

# 단위 테스트 생성 → 파일로 저장
tokenlift test -f src/service.py -o tests/test_service.py

# 일괄 리팩터링 (동작 보존)
tokenlift refactor "거대 함수를 작은 함수로 분리" -f big.js --apply

# 언어 이식
tokenlift translate -f util.py --lang python --to go -o util.go

# 대용량 파일 요약 (입력 토큰 절감)
tokenlift explain -f huge_module.ts "핵심 데이터 흐름만"

# 라우팅 추천 (위임할지/모델 무엇)
tokenlift route "결제 모듈 단위테스트 작성"

# 백엔드 선택 (사내 Ollama 서버 기본: --role coder=V100 / oracle=H200)
tokenlift gen "..." --role oracle          # 사내 H200 서버로 위임(실패 시 체인 강등)
tokenlift gen "..." --provider nemoclaw   # NemoClaw/NIM(OpenAI 호환)로 위임
tokenlift providers  # 설정된 백엔드 목록/활성 확인

# 운영
tokenlift models     # (활성 provider) 모델 + 라우팅 매핑
tokenlift doctor     # 환경 점검 (--provider 로 특정 백엔드 점검)
tokenlift warmup -m qwen2.5-coder:14b   # 모델 선적재(연속 위임 전 권장)
tokenlift stats      # 누적 절감 통계(백엔드별 집계)
tokenlift secure doctor  # NemoClaw 보안 게이트웨이 적용 점검 (init 로 자동 적용)
```

**백엔드(provider):** 기본은 로컬 `ollama`. 사내 온프렘 `nemoclaw`(NVIDIA NemoClaw/NIM,
OpenAI 호환)로 위임하려면 `--provider nemoclaw`. 어느 백엔드든 stdout=결과물 계약은 동일하다.
설정/모델명은 `reference/cli-reference.md` 와 `docs/11-providers.md` 참조.

자세한 플래그/모델 매핑/예시는 같은 폴더의 참고 문서를 읽어라:
- `reference/codebase-memory.md` — 지식 그래프(codebase-memory-mcp) 도구·탐색 워크플로우
- `reference/cli-reference.md` — 전체 명령·플래그·백엔드·설치
- `reference/routing-rules.md` — 위임 판단 상세 규칙과 예시

## 검토 원칙 (필수)

- 로컬 모델 산출물을 **그대로 신뢰하지 말 것.** 항상 Claude가 정확성을 책임진다.
- 보안·인증·결제·데이터 무결성 관련 코드는 위임하더라도 **Claude가 반드시 재검토**한다.
- 위임 결과가 요구와 다르면, 재위임(프롬프트 보강)하거나 Claude가 직접 마무리한다.
- 연속으로 여러 번 위임할 땐 먼저 `tokenlift warmup` 으로 모델을 적재해 지연을 줄인다.

## 운영 팁

- 같은 모델을 연속 사용하면 빠르다(모델 교체 시 재적재 비용 발생). 한 세션에선 가능한
  하나의 코드 모델(`qwen2.5-coder:14b`)로 묶어 위임한다.
- 백엔드(사내 Ollama 서버)가 꺼져 있으면 `tokenlift doctor` 가 알려준다. 역할 체인이 자동
  강등되며, 모두 불가면 Claude가 직접 처리하거나 사용자에게 사내 서버 점검을 요청한다.
- 가벼운 작업은 로컬 `ollama`, 대형 모델이 필요한 작업은 사내 `nemoclaw` 로 나눠 위임할 수 있다.
