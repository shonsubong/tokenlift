# 17. 셋업 & 사용 가이드 (End-to-End)

TokenLift 를 사내에 처음 세팅하고 실제로 쓰는 **전 과정**을 한 문서로 정리한다. 각 항목의
상세는 관련 문서를 링크로 연결한다. 요약 흐름:

```
[검증] 기밀 판정 = 로컬 결정적 패턴 매칭(tokenlift route, 무LLM) — 항상 먼저. 기밀→사내 강제
[탐색] codebase-memory-mcp 그래프 (입력 토큰↓, 전부 로컬)
[실행] executor = 사내 GLM-5.2(NIM/vLLM, 무제한) → H200 → V100 — 사내망 직결(보안 예외)
[조언] advisor = Claude(Bedrock, $200/월) — "비민감" 설계·판단·최종 검토만
       — NemoClaw 게이트웨이 경유(결정적 정책 필터. 판단자가 아니라 집행자)
[차단] 민감 폴더는 Claude Code permissions.deny 로 애초에 읽기 차단(유출 원천 봉쇄)
```

> 배경/상세: [11. Providers](./11-providers.md) · [13. 멀티모델 에이전트](./13-multi-model-agents.md) ·
> [14. GLM×llama.cpp](./14-glm-llamacpp.md) · [15. NemoClaw 보안](./15-nemoclaw-windows-security.md) ·
> [16. GLM 온프렘 셋업](./16-glm-multiquant-team.md) · [18. 실행자/조언자·보안 라우팅](./18-executor-advisor.md)

---

## 1. 누가 무엇을 하나 (역할 분담)

| 역할 | 1회 작업 | 산출물 |
|---|---|---|
| **서버 관리자** | 온프렘 GLM-5.2 서빙(**NIM Docker 권장** / vLLM / llama.cpp) + V100·H200 Ollama | 사내망 `/v1` 엔드포인트 + 사용자 토큰 |
| **각 사용자(Windows PC)** | WSL2+NemoClaw 게이트웨이, TokenLift 설치, `secure init` | Bedrock 필터·온프렘 직결·민감폴더 차단이 적용된 Claude Code |
| **Claude Code(런타임)** | 의도 파악 → 탐색/위임/판단 오케스트레이션 | 검토·통합된 결과 |

---

## 2. 셋업 프로세스

### 2-A. (서버 관리자) 온프렘 GLM-5.2 서빙 — 1회

서빙 방식과 양자화를 하드웨어로 고른다(상세 [16](./16-glm-multiquant-team.md)):

| 경로 | HW / 양자화 | 명령 |
|---|---|---|
| **NIM Docker (공식, 가장 간단)** | 8×B200/H20/H200 — 양자화(fp8 등) 프로파일 **자동 선택** | `NGC_API_KEY=... bash scripts/run-glm-nim.sh` |
| vLLM + NVIDIA 공식 NVFP4 | **Blackwell**(B200/B300) `glm-5.2-nvfp4` | `PROFILE=nvfp4 bash scripts/run-glm-vllm.sh` |
| vLLM + Z.ai 공식 FP8 | **H200**(Hopper) `glm-5.2-fp8` | `PROFILE=fp8 bash scripts/run-glm-vllm.sh` |
| llama.cpp + Unsloth GGUF | 저VRAM/CPU offload `glm-5.2-q4/q2` | `bash scripts/run-glm-fleet.sh start` |

```bash
# 예: H200 클러스터에서 Z.ai FP8 서빙 + 멀티유저 토큰 + 사내망 공개
PROFILE=fp8 TP=8 PORT=8000 HOST=0.0.0.0 API_KEY="$TEAM_TOKEN" \
  bash scripts/run-glm-vllm.sh
# → http://<서버>:8000/v1 (served-model-name = glm-5.2-fp8)
```
> ⚠️ NVFP4 는 Blackwell 전용 — H200 에서는 안 뜬다. H200 은 `PROFILE=fp8`.
> (선택) V100/H200 Ollama, NemoClaw NIM 서빙은 [11](./11-providers.md)/[13](./13-multi-model-agents.md).

### 2-B. (Windows 사용자 PC) NemoClaw 보안 게이트웨이 — 1회

Claude Code 의 외부 Bedrock 트래픽을 필터링하기 위한 게이트웨이(상세 [15](./15-nemoclaw-windows-security.md)):

```powershell
wsl --install -d Ubuntu-22.04          # + Docker Desktop(WSL 통합 ON), .wslconfig 메모리 ≥12GB
```
```bash
# WSL2(Ubuntu) 안에서 — Bedrock 인증 export 후 게이트웨이 기동
export AWS_BEARER_TOKEN_BEDROCK=...     # 또는 AWS_PROFILE / IAM 환경변수
npx nemoclaw init                       # ⚠️ WSL2 에선 --gpu 없이(게이트웨이는 GPU 불필요, #208)
```
정책에서 **온프렘=신뢰(필터 예외), Bedrock=필터** 로 둔다(예시 [15.2](./15-nemoclaw-windows-security.md)).
온보딩이 출력한 **게이트웨이 주소**(예: `http://localhost:8080`)를 기록.

### 2-C. (각 사용자) TokenLift 설치 + 설정 + 보안 자동 적용

```bash
# WSL2(Ubuntu) 안에서 실행 권장(경로/보안이 그 환경 기준으로 해석됨)
git clone <repo> && cd TokenLift
bash scripts/install.sh                 # 스킬/에이전트 배포 + tokenlift 전역 등록 + doctor
#   (Windows PowerShell: powershell -File scripts/install.ps1)
```

`~/.tokenlift/config.json`(개인 오버라이드)에 사내 값을 넣는다:
```jsonc
{
  "providers": {
    "onprem-glm":  { "host": "http://glm.internal:8000",
                     "routing": { "default": "glm-5.2-fp8" } },   // H200면 fp8
    "onprem-h200": { "host": "http://h200.internal:11434" },
    "onprem-v100": { "host": "http://v100.internal:11434" }
  },
  "security": {
    "gateway": { "url": "http://localhost:8080" },                // 2-B 게이트웨이
    "bedrock": { "region": "us-east-1" },
    "exemptHosts": ["glm.internal", "h200.internal", "v100.internal", "localhost", "127.0.0.1"],
    "sensitivePaths": ["/mnt/c/Users/<you>/Sensitive", "~/.aws/**", "~/.ssh/**", "**/.env", "**/*.pem"],
    "sensitivePatterns": ["project-falcon", "정산엔진v2", "/고객DB.*접속/i"]  // 사내 기밀 키워드/코드명(내용 기반 라우팅 차단)
  }
}
```
```bash
export ONPREM_API_KEY="사용자토큰"       # 서버 관리자에게 발급받은 Bearer
tokenlift secure init                    # Claude Code settings.json 에 보안 자동 주입(+백업)
# → Claude Code 재시작
```

### ✅ 셋업 완료 체크리스트
```bash
tokenlift providers                      # 백엔드 목록/활성 확인
tokenlift doctor --provider onprem-glm   # GLM 서버 연결/모델 확인
tokenlift secure doctor                  # 게이트웨이 경유·온프렘 예외·민감폴더 차단 = 모두 ✅
tokenlift models --provider onprem-glm   # served 모델(glm-5.2-fp8 등) 확인
# 보안 라우팅 실동작 검증 — 기밀이 사내로 강제되는지:
tokenlift route "정산 로직 검토 (api_key='sk_test_123' 포함)"
#   → 기밀도: 🔒 HIGH / Bedrock 전송: ❌ 금지 / 권장 백엔드: onprem-glm 이면 정상
```
전부 통과하면 준비 완료.

---

## 3. 사용 방법 (명령 + 예시)

> 전제: `tokenlift` 가 PATH 에 있음(install 로 등록). 없으면 `node <repo>/bin/tokenlift.mjs`.
> **stdout = 결과물만**, stderr = 메타(모델/토큰/절감). `-o`/`--apply` 시 stdout 은 저장 경로.

| 목적 | 명령 예시 | 무슨 일이 일어나나 |
|---|---|---|
| 탐색/이해 | (Claude가 codebase-memory-mcp 도구 사용) | 파일 통독 대신 그래프 쿼리 → **입력 토큰↓** |
| 코드 생성 | `tokenlift gen "JWT 검증 미들웨어" --lang ts` | executor(GLM-5.2) 위임 → 코드만 반환 |
| 테스트 생성 | `tokenlift test -f src/pay.ts -o src/pay.test.ts` | 위임 후 파일 저장, Claude 는 검토만 |
| 리팩터링 | `tokenlift refactor "함수 분리" -f big.js --apply` | 동작 보존 리팩터 → 원본에 덮어쓰기 |
| 대용량 요약 | `tokenlift explain -f build.log "실패 원인 5줄"` | coder(V100), 수천 줄 대신 요약만 → **입력 토큰↓** |
| 어려운 추론 | `tokenlift gen "동시성 큐 알고리즘" --role oracle --think on` | **GLM-5.2**(oracle 1순위)로 위임, thinking on |
| 특정 모델 강제 | `tokenlift gen "..." --provider onprem-glm -m glm-5.2-fp8` | 라우팅 무시, 지정 모델 |
| 라우팅 추천 | `tokenlift route "결제 모듈 보안 설계"` | 역할/티어 + **기밀도·Bedrock 허용/금지** 판정(기밀→사내 강제, 비민감 설계→advisor) |
| 운영 | `tokenlift warmup --provider onprem-glm -m glm-5.2-fp8` · `tokenlift stats` | 선적재 · 누적 절감 |

**전형적 흐름(Claude 관점):** 탐색은 그래프 → 무거운 생성은 `tokenlift` 위임 → 반환 코드 검토 →
필요한 부분만 Claude 가 보정/통합. 상세 워크플로는 스킬(`skills/tokenlift/SKILL.md`).

---

## 4. 사용 시 내부 동작 프로세스 (Runtime Flow)

사용자가 Claude Code 에서 요청을 하면 다음 순서로 처리된다. **핵심: 온프렘 위임은 사내망 직결
(보안 예외), Claude 자신의 Bedrock 호출만 NemoClaw 게이트웨이로 필터링된다.**

```
사용자 요청
   │
   ▼
① Claude Code(TokenLift 스킬) 의도 파악 + 기밀 검증(tokenlift route)
   │   ⚠️ 기밀 "판정"은 LLM 이 아니라 로컬 결정적 패턴 매칭(assessSensitivity)이 수행
   │      — 밖으로 나가기 전에 판정해야 하므로. Claude 는 그 결과에 "복종"만 한다.
   │   기밀 신호 → 사내 강제(Bedrock 금지, ③으로) · 비민감 고난도 → 조언자 Claude(⑤로)
   ▼
② 코드 현황 필요? ── yes ──▶ codebase-memory-mcp 그래프 쿼리 (로컬, 입력 토큰↓)
   │ no
   ▼
③ 무거운 생성/반복 작업? ── yes ──▶ 역할/티어 결정 (tokenlift route / 휴리스틱)
   │                                   executor/oracle=GLM-5.2 / 경량 coder=V100 …
   │ no                                     │
   │                                        ▼
   │                          ④ tokenlift <task> 실행 (node CLI)
   │                             └ provider 체인 시도 → 온프렘 /v1 로 "직결"
   │                                (NO_PROXY 예외 → 게이트웨이/필터 안 거침)
   │                                실패 시 체인 다음 백엔드로 자동 강등
   │                                    │
   │                                    ▼  결과(코드/텍스트) stdout 반환
   ▼                                    │
⑤ Claude(Bedrock) 판단·검토 ◀───────────┘   ※ 비민감 내용만. 기밀 산출물 검토는
   │                                          원문 대신 요약·비식별 후 전달
   └ Claude Code 의 모델 호출 → ANTHROPIC_BEDROCK_BASE_URL = NemoClaw 게이트웨이
        → 게이트웨이 = "판단자"가 아니라 결정적 정책 집행자(정책 YAML·시크릿 패턴 차단,
          redaction/NemoGuard 분류 NIM 은 구성 옵션) → AWS Bedrock
        (민감 폴더는 permissions.deny 로 애초에 안 읽혀 프롬프트에 못 들어감)
   ▼
⑥ 검토·통합 → 사용자에게 결과 / tokenlift stats 에 절감 집계
```

### 시나리오 A — 위임(테스트 생성)
`tokenlift test -f src/pay.ts` →
① executor 역할 → ④ GLM-5.2 로 **직결** 위임(실패 시 H200→V100 강등) → 테스트 코드 반환 →
⑤ Claude 가 검토(보안 로직이면 보정) → ⑥ 저장. **Bedrock 은 검토에만, 코드 원문은 사내에 머묾.**

### 시나리오 B — 어려운 추론(oracle → GLM-5.2)
`tokenlift gen "동시성 큐 알고리즘" --role oracle --think on` →
③ oracle → ④ `onprem-glm`(vLLM, glm-5.2-fp8) **직결**, 체인 `GLM→H200→V100→claude` →
GLM-5.2 가 추론(reasoning_content 분리)하여 구현 반환 → ⑤ Claude 검토.

### 시나리오 C — 보안(기밀 강제 + Bedrock 필터 vs 온프렘 예외)
**기밀이 감지되면(①) 판단까지 사내 GLM-5.2 가 담당**하고 Bedrock 으로는 아예 가지 않는다.
비민감 설계/판단만 ⑤에서 Claude(Bedrock)가 하며, 이때 **게이트웨이가 프롬프트를 필터**하고,
`Sensitive/` 폴더는 `secure init` 이 넣은 `permissions.deny` 로 **읽기 자체가 차단**되어
유출 경로가 원천 차단된다. 반면 GLM/H200/V100 위임은 `NO_PROXY` 로 **직결(예외)** — 필터
지연 없이 빠르다.

---

## 5. 검증 / 트러블슈팅 빠른 참조

| 증상 | 확인 |
|---|---|
| 위임이 Claude 로만 감 | `tokenlift route "<작업>"` 로 신호 확인. 비민감 설계/판단 키워드는 의도적으로 advisor(Claude). 기밀인데 Claude 로 가면 버그 — sensitivePatterns 확인 |
| GLM 연결 실패 | `tokenlift doctor --provider onprem-glm` — host/토큰/서버 기동 확인 |
| GLM 이 안 뜸(vLLM) | NVFP4 를 H200 에 올렸는지 확인 → `PROFILE=fp8` 로 재서빙 |
| 보안 미적용 | `tokenlift secure doctor` → ❌면 `tokenlift secure init` 후 Claude Code 재시작 |
| 온프렘이 느림/필터됨 | `security.exemptHosts` 에 온프렘 host 포함됐는지(= NO_PROXY 직결) |
| 스트림 60s 끊김 | NemoClaw `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT`/버전(#2403), `timeoutMs` 확인 |
| 콜드 로드 김 | `tokenlift warmup --provider onprem-glm -m <model>` 로 선적재 |

---

## 6. 관련 문서
- 설치 상세 → [08. Installation](./08-installation.md)
- 사용 상세 → [06. Usage](./06-usage.md) · 라우팅 → [03. Routing Policy](./03-routing-policy.md)
- 백엔드/역할 → [11. Providers](./11-providers.md) · [13. 멀티모델 에이전트](./13-multi-model-agents.md)
- GLM 서빙 → [14. llama.cpp](./14-glm-llamacpp.md) · [16. 온프렘 셋업(NVIDIA 우선)](./16-glm-multiquant-team.md)
- 보안 → [15. NemoClaw 보안(Windows/WSL2)](./15-nemoclaw-windows-security.md) · [18. 실행자/조언자·보안 우선 라우팅·$200 예산](./18-executor-advisor.md)
