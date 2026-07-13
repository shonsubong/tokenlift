# TokenLift

> Claude Code(Bedrock)의 토큰 비용을, **코드 탐색은 지식 그래프(codebase-memory-mcp)로,
> 코드 생성은 사내 온프렘 Ollama 서버(H200/V100) / NemoClaw(NIM)로** 위임해 절감하는 Claude Code 스킬 + 브리지 CLI.

코드베이스 **이해·탐색**은 파일 통독 대신 지식 그래프 쿼리로(입력 토큰↓), **대량 생성**(테스트·
리팩터링·이식 등)은 로컬/온프렘 모델로(출력 토큰↓), **설계·보안·복잡 디버깅**만 Claude가 담당한다.

```
사용자 요청 ─── ⓪ 기밀(보안) 검증 먼저: tokenlift route → 기밀이면 Bedrock 전송 금지
   │
   ├─ 코드 탐색/이해/검색/영향분석  ──graph──►  codebase-memory-mcp        ← 입력 토큰 ~99%↓ (로컬)
   │
   ├─ 개발 대부분(생성·수정·테스트·리팩터)      실행자 executor            ← 출력 토큰↓ (무제한)
   │   + 기밀 포함 작업 전부      ─tokenlift─►  사내 GLM-5.2 (NIM Docker, 양자화)
   │                                          │  · 사내망 직결(보안 예외) · 실패 시 H200→V100 강등
   │                                          └─ 경량 정형(요약/문서)은 coder=V100
   │
   └─ 비민감 + 고난도 판단(설계/트레이드오프) ──►  조언자 advisor = Claude (Bedrock, $200/월 예산)
                                       └─(보안 옵션) NemoClaw 게이트웨이 경유 → PII/정책 필터
                                          · 민감 폴더는 읽기 차단 · 위임 결과의 검토·통합도 Claude
```

**실행자/조언자 멀티에이전트** (oh-my-openagent·hermes-agent 참조) — Claude(lead)가 지휘하되
**개발 대부분은 실행자(사내 GLM-5.2, 무제한)**, **조언은 조언자(Claude, $200/월 예산)** 가 맡고,
**기밀은 자동으로 사내 강제**된다. 비용 사다리 `그래프(무료) → V100 → H200 → GLM-5.2(사내) →
Bedrock(최후)`. `tokenlift roles` / `tokenlift route "<작업>"` 로 확인. → [18. 실행자/조언자](docs/18-executor-advisor.md)

- ⭐ 처음이라면 → **[17. 셋업 & 사용 가이드(End-to-End)](docs/17-setup-and-usage.md)** (설치·사용·동작 프로세스 한 문서)
- 실행자/조언자 멀티에이전트·보안 우선 라우팅·$200 예산 → [18. 실행자/조언자](docs/18-executor-advisor.md)
- GLM-5.2 온프렘 셋업(NVIDIA 공식 NVFP4/FP8 vLLM 우선·멀티유저) → [16. GLM-5.2 온프렘 셋업](docs/16-glm-multiquant-team.md)
- NemoClaw 보안 게이트웨이 자동 적용(Bedrock 필터 / 온프렘 예외 / 민감폴더 차단) → [15. NemoClaw 보안(Windows/WSL2)](docs/15-nemoclaw-windows-security.md)
- GLM-5.2 를 llama.cpp 로 온프렘 서빙(프런티어 오픈 모델) → [14. GLM-5.2 × llama.cpp](docs/14-glm-llamacpp.md)
- 멀티모델 에이전트 라우팅 → [13. 멀티모델 에이전트](docs/13-multi-model-agents.md)
- 탐색 그래프 → [12. 코드 탐색 위임](docs/12-codebase-memory.md)
- 생성 백엔드(provider 추상화, `--provider`/`--role`) → [11. 백엔드 확장](docs/11-providers.md)

## 왜 절감되는가 — 3개의 기둥

Bedrock 과금에서 **출력 토큰이 입력의 약 5배**이고, 코드 탐색은 파일 반복 읽기로 **입력 토큰**을
크게 쓴다. TokenLift는 비싼 소비를 세 방향으로 옮긴다.

1. **탐색 위임(입력 절감)** — codebase-memory-mcp 지식 그래프에 구조 쿼리. 파일별 grep/read
   대신. 5개 쿼리 ≈ 3,400 토큰 vs 파일 탐색 ≈ 412,000 토큰(약 99%↓).
2. **생성 위임(출력 절감)** — 길게 생성되는 코드는 실행자(사내 GLM-5.2/Ollama)가 만들고 Claude는 검토만.
3. **고난도 판단** — 설계·트레이드오프·최종 검토는 조언자(Claude)가 책임 — 단 **기밀 없는 내용만**,
   그리고 **$200/월 예산** 안에서(기밀 포함 판단은 사내 GLM-5.2 가 담당).

## 보안 — NemoClaw 게이트웨이 (선택 · 사내 Windows/온프렘)

사내에서 Claude Code(Bedrock)를 쓸 때, **외부 Bedrock 트래픽만 NemoClaw 추론 게이트웨이로
필터**(PII redaction·정책)하고, **온프렘 위임은 직결(예외)**, **민감 폴더는 아예 읽기 차단**한다.
TokenLift 가 이 설정을 자동 적용·점검한다. 원리:

- **Bedrock = 보안**: Claude Code 의 Bedrock 호출이 게이트웨이를 경유(`ANTHROPIC_BEDROCK_BASE_URL`)
  → 게이트웨이가 요청/응답의 PII·시크릿을 redaction, 정책 필터 적용 후 AWS Bedrock 으로 전달.
- **온프렘 = 예외**: GLM-5.2/H200/V100 위임은 `NO_PROXY` 로 직결 → 필터를 안 거쳐 빠르고, 사내
  신뢰망이라 코드 원문 전송 OK.
- **유출 원천 차단**: 민감 폴더는 `permissions.deny`(읽기 차단)로 애초에 프롬프트에 못 들어간다
  (게이트웨이 redaction 은 보조 방어선 — 진짜 보증은 "못 읽게" 하는 것).

```bash
tokenlift secure status   # 적용될 보안 설정 미리보기
tokenlift secure init     # Claude Code settings.json 에 자동 주입(기존 설정 보존 + 백업)
tokenlift secure doctor   # 게이트웨이 경유·온프렘 예외·민감폴더 차단 = 모두 ✅ 점검
```

> NemoClaw 는 GLM-5.2 를 직접 호스팅하지 않는다 — 게이트웨이가 당신이 띄운 온프렘 GLM-5.2
> 서버(vLLM/llama.cpp)로 라우팅할 뿐이다. 설치·정책·한계 상세 →
> [15. NemoClaw 보안(Windows/WSL2)](docs/15-nemoclaw-windows-security.md).

## 빠른 시작

```bash
# 0a) 탐색 그래프(권장): codebase-memory-mcp 설치 후 Claude Code 재시작
#     macOS/Linux:
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
#     이후 "이 프로젝트 인덱싱해줘" 한 번 → 탐색이 그래프로 처리됨

# 0b) 생성 백엔드: 사내 H200/V100 Ollama 서버 (관리자가 최신 오픈모델을 pull 해 둠)
#     ~/.tokenlift/config.json 의 providers.onprem-h200|onprem-v100.host 를 사내 주소로 설정
#     (로컬 PC 에 Ollama 를 둘 필요 없음)

# 1) CLI 설치(글로벌 명령 등록) — 플러그인은 CLI 를 설치하지 않으므로 별도 1회
bash scripts/install.sh        # Windows: powershell -File scripts/install.ps1

# 1b) Claude Code 플러그인 설치(스킬·서브에이전트·보안 힌트 훅 "자동 등록")
#     Claude Code 안에서:
#       /plugin marketplace add shonsubong/tokenlift
#       /plugin install tokenlift@tokenlift
#     (업데이트도 /plugin 으로 — install 스크립트 재실행 불필요)

# 2) 환경 점검 (기본 백엔드 = 사내 onprem-v100)
tokenlift doctor
tokenlift providers   # 설정된 사내 서버/활성 확인

# 3) 위임 실행 (역할로 비용최적 서버 자동선택, 실패 시 체인 강등)
tokenlift gen "Express 에러 핸들링 미들웨어" --lang ts --role coder    # = V100 서버
tokenlift gen "락-프리 큐 알고리즘 구현" --role oracle                  # = H200 서버
tokenlift test -f src/service.py -o tests/test_service.py --role coder

# 4) 누적 절감 확인
tokenlift stats
```

> **배포 형태 = Claude Code 플러그인.** 이 저장소가 곧 마켓플레이스다
> (`.claude-plugin/marketplace.json`). `/plugin install tokenlift@tokenlift` 하나로
> 스킬(`/tokenlift:tokenlift`)·서브에이전트 2종·보안 힌트 훅(hooks/hooks.json)이 자동
> 등록되고, 버전 업데이트도 `/plugin` 으로 관리된다. 플러그인을 쓸 수 없는 환경만
> `install.sh --copy-assets`(레거시 수동 복사). 상세: [설치 가이드](docs/08-installation.md).

설치 후 Claude Code 에서 "토큰 아끼게 이 테스트 Ollama로 작성해줘" 처럼 요청하면
`tokenlift` 스킬이 자동 발동한다.

## 구성 요소

| 구성 | 위치 | 역할 |
|---|---|---|
| **플러그인 패키지** | `.claude-plugin/plugin.json` (+`marketplace.json`) | 스킬·에이전트·훅을 `/plugin install` 로 배포·버전 관리 |
| **탐색 그래프 통합** | `skills/tokenlift/` + [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 코드 탐색을 지식 그래프로(입력 토큰↓) — 기본 |
| 브리지 CLI | `bin/`, `src/` | 백엔드에 코딩 작업 위임(출력 토큰↓), 절감 로깅 |
| Provider 어댑터 | `src/providers/` | ollama / openai-compat(NemoClaw·NIM 등) 백엔드 추상화 |
| Claude Code 스킬 | `skills/tokenlift/` | 언제 그래프로 탐색하고 무엇을 위임할지 Claude 에게 지시 |
| 서브에이전트 | `agents/ollama-delegate.md` | 위임 작업을 격리 실행(그래프로 컨텍스트 수집) |
| 자동 감지 훅 | `hooks/` (`hooks.json` + `suggest-delegation.mjs`) | 기밀 경고·위임 힌트 주입 — 플러그인 설치 시 **자동 등록** |
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
| 14 | [GLM-5.2 × llama.cpp](docs/14-glm-llamacpp.md) | GLM-5.2 양자화 모델 llama-server 서빙 + onprem-glm 연동 |
| 15 | [NemoClaw 보안(Windows/WSL2)](docs/15-nemoclaw-windows-security.md) | Bedrock→게이트웨이 필터 / 온프렘 예외 / 민감폴더 차단 자동 적용(`tokenlift secure`) |
| 16 | [GLM-5.2 온프렘 셋업](docs/16-glm-multiquant-team.md) | NVIDIA 공식 NVFP4/Z.ai FP8 vLLM 우선(`run-glm-vllm.sh`) + GGUF 대안 + 멀티유저 |
| 17 | [셋업 & 사용 가이드](docs/17-setup-and-usage.md) | ⭐ 설치·사용·런타임 동작 프로세스를 한 문서로(End-to-End, 예시·플로우 포함) |
| 18 | [실행자/조언자](docs/18-executor-advisor.md) | 보안 우선 라우팅(기밀→사내 GLM 강제)·executor/advisor 패턴·$200/월 예산 운영 |

## 요구사항

- **Node.js 18+** (내장 `fetch` 사용, 외부 의존성 없음)
- **탐색 그래프(권장)**: [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (단일 바이너리, 로컬). 없으면 탐색 기둥은 자동 생략(평소대로 Read/Grep).
- **생성 백엔드(사내 온프렘 Ollama 서버)**:
  - 사내 **H200 서버(oracle)** / **V100 서버(coder)** 에 **Ollama + 최신 오픈 모델 다수**가
    pull 되어 있다고 가정(로컬 PC 아님). `config.providers.onprem-h200|onprem-v100.host` 를
    사내 주소로 설정. 같은 서버를 **NemoClaw/NIM** 으로 서빙해도 됨(openai-compat).
  - 역할별 폴백 체인으로 자동 강등. → [13. 멀티모델 에이전트](docs/13-multi-model-agents.md)
  - (선택) 로컬 PC 에 Ollama 가 있으면 `--provider ollama` 로 개발용 사용 가능.
- **GLM-5.2(프런티어, oracle 1순위)는 Ollama 가 아니라 NIM Docker / vLLM / llama.cpp 로 서빙**한다:
  - **NVIDIA 공식 Docker** = **NIM 컨테이너**([`nvcr.io/nim/zai-org/glm-5.2`](https://catalog.ngc.nvidia.com/orgs/nim/zai-org/containers/glm-5.2),
    SGLang·HW별 프로파일 자동, OpenAI 호환) — 가장 간단(`scripts/run-glm-nim.sh`).
  - vLLM = **NVIDIA 공식 NVFP4**(`nvidia/GLM-5.2-NVFP4` 가중치, Blackwell) 또는
    **Z.ai 공식 FP8**(`zai-org/GLM-5.2-FP8`, H200). 대안 = **llama.cpp**(Unsloth GGUF).
  - ⚠️ **Ollama 로는 온프렘(로컬) GLM-5.2 양자화가 지원되지 않는다.** 공식 Ollama 라이브러리의
    [`glm-5.2`](https://ollama.com/library/glm-5.2) 는 **`:cloud` 태그뿐이며 Z.ai 클라우드로
    라우팅**된다(데이터가 외부로 나감 → 온프렘/프라이버시 목적에 부적합). 로컬 양자화 태그는 없다.
    NemoClaw 도 GLM-5.2 는 `vllm-local`/`compatible-endpoint` 로 이 vLLM/llama.cpp 서버에 연결한다.
    → [16. GLM-5.2 온프렘 셋업](docs/16-glm-multiquant-team.md)
- **외부 모델은 Claude=AWS Bedrock 전용** (오케스트레이션·판단·검토 담당)

## 한계 (정직한 고지)

- 로컬 모델은 Claude보다 약하다. **위임 결과는 항상 Claude가 검토**해야 한다.
- 절감액은 **추정치**다(로컬 처리 토큰을 Bedrock 단가로 환산한 gross 값). 실제 절감은
  작업 성격·검토 비용에 따라 달라진다. → [비용 분석](docs/07-cost-analysis.md)
- 사소한 작업은 위임 왕복 지연이 절감보다 클 수 있다.

## 라이선스

MIT
