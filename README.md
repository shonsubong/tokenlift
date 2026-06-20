# TokenLift

> Claude Code(Bedrock)의 토큰 비용을, **코드 탐색은 지식 그래프(codebase-memory-mcp)로,
> 코드 생성은 로컬 Ollama / 온프렘 NVIDIA NemoClaw(NIM)로** 위임해 절감하는 Claude Code 스킬 + 브리지 CLI.

코드베이스 **이해·탐색**은 파일 통독 대신 지식 그래프 쿼리로(입력 토큰↓), **대량 생성**(테스트·
리팩터링·이식 등)은 로컬/온프렘 모델로(출력 토큰↓), **설계·보안·복잡 디버깅**만 Claude가 담당한다.

```
사용자 요청
   │
   ├─ 코드 탐색/이해/검색/영향분석  ──graph──►  codebase-memory-mcp   ← 입력 토큰 ~99%↓ (로컬)
   │
   ├─ 대량/반복 코드 생성          ─tokenlift─►  온프렘 GPU            ← 출력 토큰↓ (한계비용≈전기)
   │                                          │  (H200×8 / V100×8 위에서 Ollama·NemoClaw 서빙)
   │                                          ├─ coder  = V100  (대량·최저가)
   │                                          └─ oracle = H200  (어려운/대형) · 실패 시 체인 강등
   │
   └─ 고난도 판단(설계/보안/디버깅) ──────────►  Claude (Bedrock 전용)  ← 비싸지만 똑똑함
                                          (두 위임 결과의 검토·통합도 Claude)
```

**에이전트 팀(오케스트레이터-워커, oh-my-openagent 참조)** — Claude(lead)가 위임을 지휘하고,
비용 최소화 사다리 `그래프(무료) → V100(coder) → H200(oracle) → Bedrock(claude)` 에서 충분한
가장 싼 단계를 쓴다. `tokenlift roles` / `tokenlift route "<작업>"` 로 확인.

- 멀티모델 에이전트 라우팅 → [13. 멀티모델 에이전트](docs/13-multi-model-agents.md)
- 탐색 그래프 → [12. 코드 탐색 위임](docs/12-codebase-memory.md)
- 생성 백엔드(provider 추상화, `--provider`/`--role`) → [11. 백엔드 확장](docs/11-providers.md)

## 왜 절감되는가 — 3개의 기둥

Bedrock 과금에서 **출력 토큰이 입력의 약 5배**이고, 코드 탐색은 파일 반복 읽기로 **입력 토큰**을
크게 쓴다. TokenLift는 비싼 소비를 세 방향으로 옮긴다.

1. **탐색 위임(입력 절감)** — codebase-memory-mcp 지식 그래프에 구조 쿼리. 파일별 grep/read
   대신. 5개 쿼리 ≈ 3,400 토큰 vs 파일 탐색 ≈ 412,000 토큰(약 99%↓).
2. **생성 위임(출력 절감)** — 길게 생성되는 코드를 Ollama/NemoClaw가 만들고 Claude는 검토만.
3. **고난도 판단** — 설계·보안·디버깅·의사결정과 위 두 위임의 검토·통합은 Claude가 책임.

## 빠른 시작

```bash
# 0a) 탐색 그래프(권장): codebase-memory-mcp 설치 후 Claude Code 재시작
#     macOS/Linux:
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
#     이후 "이 프로젝트 인덱싱해줘" 한 번 → 탐색이 그래프로 처리됨

# 0b) 생성 백엔드: Ollama 실행 + 코드 모델
ollama serve
ollama pull qwen2.5-coder:14b

# 1) CLI 설치(글로벌 명령 등록)
cd TokenLift && npm link

# 2) 환경 점검
tokenlift doctor

# 3) 위임 실행 (생성)
tokenlift gen "Express 에러 핸들링 미들웨어" --lang ts
tokenlift test -f src/service.py -o tests/test_service.py

# 4) 누적 절감 확인
tokenlift stats

# (선택) 온프렘 NemoClaw/NIM 으로 위임
export NEMOCLAW_API_KEY=...                 # 인증이 필요하면
tokenlift gen "..." --provider nemoclaw     # providers.nemoclaw.host 를 사내 주소로 설정
```

Claude Code 스킬/서브에이전트 설치는 [설치 가이드](docs/08-installation.md) 참조:

```bash
# Windows PowerShell
./scripts/install.ps1
# macOS/Linux
bash scripts/install.sh
```

설치 후 Claude Code 에서 "토큰 아끼게 이 테스트 Ollama로 작성해줘" 처럼 요청하면
`tokenlift` 스킬이 자동 발동한다.

## 구성 요소

| 구성 | 위치 | 역할 |
|---|---|---|
| **탐색 그래프 통합** | `skills/tokenlift/` + [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 코드 탐색을 지식 그래프로(입력 토큰↓) — 기본 |
| 브리지 CLI | `bin/`, `src/` | 백엔드에 코딩 작업 위임(출력 토큰↓), 절감 로깅 |
| Provider 어댑터 | `src/providers/` | ollama / openai-compat(NemoClaw·NIM 등) 백엔드 추상화 |
| Claude Code 스킬 | `skills/tokenlift/` | 언제 그래프로 탐색하고 무엇을 위임할지 Claude 에게 지시 |
| 서브에이전트 | `agents/ollama-delegate.md` | 위임 작업을 격리 실행(그래프로 컨텍스트 수집) |
| 자동 감지 훅 | `hooks/suggest-delegation.mjs` | 프롬프트 분석 후 위임 힌트 주입(선택) |
| 설정 | `config/tokenlift.config.json` | 백엔드·모델 매핑·단가·임계값 |

## 문서

| # | 문서 | 내용 |
|---|---|---|
| 01 | [개요](docs/01-overview.md) | 문제정의·목표·절감 원리 |
| 02 | [아키텍처](docs/02-architecture.md) | 컴포넌트·데이터 흐름·설계 결정 |
| 03 | [라우팅 정책](docs/03-routing-policy.md) | 위임/유지 판단 기준 |
| 04 | [모델 가이드](docs/04-model-guide.md) | 작업별 로컬 모델 선택 |
| 05 | [구현 상세](docs/05-implementation.md) | 모듈·설정 스키마·입출력 계약 |
| 06 | [사용 방법](docs/06-usage.md) | 워크플로우·시나리오 예시 |
| 07 | [비용 분석](docs/07-cost-analysis.md) | 절감 계산·예시·한계 |
| 08 | [설치/설정](docs/08-installation.md) | CLI·스킬·에이전트·훅 설치 |
| 09 | [트러블슈팅](docs/09-troubleshooting.md) | 자주 겪는 문제 |
| 10 | [FAQ](docs/10-faq.md) | 자주 묻는 질문 |
| 11 | [백엔드 확장](docs/11-providers.md) | Ollama / NemoClaw(NIM) provider 설정 |
| 12 | [코드 탐색 위임](docs/12-codebase-memory.md) | codebase-memory-mcp 지식 그래프(기본) |
| 13 | [멀티모델 에이전트](docs/13-multi-model-agents.md) | 역할·에스컬레이션·온프렘 H200/V100 |

## 요구사항

- **Node.js 18+** (내장 `fetch` 사용, 외부 의존성 없음)
- **탐색 그래프(권장)**: [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (단일 바이너리, 로컬). 없으면 탐색 기둥은 자동 생략(평소대로 Read/Grep).
- **생성 백엔드 하나 이상**:
  - **Ollama 0.6+** (로컬/사내) + 코드 모델 (예: `qwen2.5-coder:14b`, `devstral:24b`)
  - **온프렘 GPU 클러스터** — 사내 **H200×8(oracle)** / **V100×8(coder)** 하드웨어 위에서
    **Ollama(여러 특화 모델)** 또는 **NemoClaw/NIM** 서빙. 역할별 폴백 체인으로 자동 강등.
    → [13. 멀티모델 에이전트](docs/13-multi-model-agents.md)
- **외부 모델은 Claude=AWS Bedrock 전용** (오케스트레이션·판단·검토 담당)

## 한계 (정직한 고지)

- 로컬 모델은 Claude보다 약하다. **위임 결과는 항상 Claude가 검토**해야 한다.
- 절감액은 **추정치**다(로컬 처리 토큰을 Bedrock 단가로 환산한 gross 값). 실제 절감은
  작업 성격·검토 비용에 따라 달라진다. → [비용 분석](docs/07-cost-analysis.md)
- 사소한 작업은 위임 왕복 지연이 절감보다 클 수 있다.

## 라이선스

MIT
