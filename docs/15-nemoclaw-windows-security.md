# 15. NemoClaw 보안 게이트웨이 자동 적용 (Windows/WSL2)

Windows PC 의 **Claude Code(Bedrock)** 트래픽을 **NemoClaw 추론 게이트웨이**로 우회시켜
PII redaction·정책 필터를 강제하고, **사내 온프렘 LLM(H200/V100/GLM)** 은 직결(보안 예외),
**민감 폴더/파일** 은 아예 못 읽게 차단한다. 이 모든 걸 `tokenlift secure` 가 자동화한다.

```
Claude Code(+TokenLift)  ──Bedrock 호출──▶  NemoClaw 게이트웨이(필터) ──▶ AWS Bedrock  [보안]
        │                └─온프렘 호출(NO_PROXY 직결)──────────────────▶ 사내 H200/V100 [예외]
        └─ permissions.deny / sandbox → 민감 폴더 읽기 차단 (유출 원천 봉쇄)
```

> 배경·아키텍처 상세는 대화 로그 및 [14. GLM-5.2 × llama.cpp](./14-glm-llamacpp.md) 참조.
> 여기서는 **자동 적용 절차**만 다룬다.

## 15.1 동작 원리 (무엇이 자동인가)

TokenLift 설정의 `security` 블록이 **단일 소스**다. `tokenlift secure init` 이 이 값으로
Claude Code 의 `settings.json` 을 **안전 병합**(기존 설정 보존 + 백업)한다:

| security 항목 | 생성되는 Claude Code 설정 | 효과 |
|---|---|---|
| `gateway.url` | `env.ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDE_CODE_USE_BEDROCK=1` | Bedrock 트래픽이 게이트웨이 경유 → **필터 적용** |
| `exemptHosts` | `env.NO_PROXY` | 온프렘/로컬은 프록시 우회 → **직결(예외)** |
| `sensitivePaths` | `permissions.deny: Read(...)` + `sandbox.filesystem.denyRead` | 민감 폴더 **읽기 차단** |

핵심: **"게이트웨이를 거치면 보안, 안 거치면 예외"**. 온프렘은 `NO_PROXY` 로 직결해 구조적으로
예외 처리하고, Bedrock 만 게이트웨이로 보낸다. 유출의 진짜 방어선은 필터가 아니라 **폴더를
애초에 못 읽게 하는 `deny`** 다(읽지 못한 내용은 어떤 프롬프트에도 못 들어간다).

## 15.2 1회 준비 — NemoClaw 게이트웨이 (WSL2, TokenLift 밖의 작업)

TokenLift 가 대신 해줄 수 없는 부분(NemoClaw 설치/기동/정책)이다.

```powershell
# Windows PowerShell
wsl --install -d Ubuntu-22.04
# Docker Desktop 설치 → Settings > Resources > WSL Integration 에서 Ubuntu ON
# .wslconfig 에 WSL2 메모리 ≥ 12GB 권장 (16GB RAM/4코어/50GB 디스크)
```

```bash
# WSL2(Ubuntu) 안에서 — Bedrock 인증을 먼저 export 후 온보딩
export AWS_BEARER_TOKEN_BEDROCK=...   # 또는 AWS_PROFILE / 표준 IAM 환경변수
npx nemoclaw init
# ⚠️ Issue #208: WSL2 에서 onboard 가 --gpu 를 강제해 샌드박스가 안 뜬다.
#    게이트웨이만 쓰면 GPU 불필요 → --gpu 없이 게이트웨이를 기동한다.
```

NemoClaw 정책(YAML)에서 **Bedrock 은 필터 대상**, **온프렘 H200 은 신뢰 provider**로 둔다
(정확한 스키마는 배포 버전의 network-policy 문서 확인):

```yaml
inference:
  providers:
    onprem_h200: { endpoint: "http://h200.internal:8080/v1", trusted: true }   # 예외
    bedrock:     { endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com" } # 필터
  routing:
    - match: { provider: onprem_h200 }
      filters: []
    - match: { provider: bedrock }
      filters: [pii_redaction, secret_scan, prompt_injection]
```

온보딩이 출력한 **게이트웨이 주소**(예: `http://localhost:8080`)를 기록한다 → 다음 단계에서 사용.

## 15.3 자동 적용 — TokenLift `secure`

> **반드시 WSL2(Claude Code 가 실행되는 환경) 안에서** 실행한다. `~` 등 경로가 그 환경 기준으로
> 해석되어야 하기 때문이다.

**1) 설정 맞추기** — `~/.tokenlift/config.json`(개인) 또는 `config/tokenlift.config.json`(팀)의
`security` 를 사내 값으로 교체한다. 특히:
- `gateway.url` = 15.2 에서 기록한 게이트웨이 주소
- `bedrock.region` = 실제 리전
- `exemptHosts` = 온프렘 provider 의 host (기본 `h200.internal`, `v100.internal`)
- `sensitivePaths` = **유출 금지 폴더**(예: `/mnt/c/Users/<you>/Sensitive`)

**2) 미리보기 → 적용 → 점검**
```bash
tokenlift secure status          # 적용될 env/deny/sandbox 미리보기
tokenlift secure init --dry-run  # 실제 변경 내역만 출력(쓰지 않음)
tokenlift secure init            # settings.json 안전 병합(+ .bak 백업)
# → Claude Code 재시작
tokenlift secure doctor          # 게이트웨이 도달성 + 적용 여부 점검
```

`secure init` 은 **기존 settings.json 을 보존**한다(우리 키만 설정/갱신, deny/denyRead 는 합집합).
멱등하므로 여러 번 실행해도 안전하고, 변경이 없으면 "변경 없음"만 출력한다.

`secure doctor` 통과 예:
```
게이트웨이(http://localhost:8080): ✅ 응답(HTTP 200)
  ✅ Bedrock → 게이트웨이 우회
  ✅ 온프렘 예외(NO_PROXY 직결)
  ✅ 민감 폴더 유출 차단(permissions.deny)
보안 태세 정상 ✅
```

## 15.4 TokenLift 위임과의 관계 (왜 잘 맞는가)

TokenLift 는 원래 **Bedrock 사용을 최소화**한다(탐색=그래프, 생성=온프렘 위임). 따라서
게이트웨이가 지켜야 할 외부 트래픽 표면이 작다.
- **온프렘 위임(예외)**: `onprem-v100/h200/glm` 은 `host` 로 직결 → `exemptHosts`(NO_PROXY)에
  들어가 필터를 거치지 않는다. 사내 신뢰망이므로 코드 원문 전송 OK.
- **Bedrock(보안)**: `lead`/`reviewer` = Claude 자신(Bedrock). Claude Code 가 게이트웨이를
  경유하므로 TokenLift 스킬이 유발하는 Claude 호출도 자동으로 필터를 통과한다.

결과: `그래프(무료) → V100 → H200 → GLM-5.2(온프렘, 예외) → Bedrock(게이트웨이 보안)`.

> **참고 — 두 가지 "NemoClaw 연결"을 구분**: 이 문서(15)는 **보안 게이트웨이**(외부 Bedrock
> 트래픽 필터)다. 반면 NemoClaw 를 **추론 provider**로 써서 감싸는 에이전트(OpenClaw/Hermes)의
> 추론을 **NVIDIA 공식 GLM-5.2(NVFP4)/vLLM 로 보내는** 연결은 별개이며, 정확 절차
> (compatible-endpoint / managed vLLM, onboard 명령·env)는 [16. GLM 온프렘 셋업](./16-glm-multiquant-team.md#nemoclaw-에-붙이기--nvidia-공식-nvfp4-정확-절차) 참조.

## 15.5 한계 / 주의 (정직하게)

- **게이트웨이 redaction 은 보조 방어선**이다(PII/시크릿 *패턴* 기반, 우회 가능). 특정 폴더가
  새지 않는 **진짜 보증은 `sensitivePaths` 의 deny/denyRead**(읽기 자체 차단)다. 둘을 함께 쓴다.
- `exemptHosts` 는 config 의 온프렘 provider `host` 와 **정확히 일치**해야 예외가 성립한다.
- `secure init` 은 NemoClaw 를 설치/기동하지 않는다(15.2 는 수동). TokenLift 는 **Claude Code
  쪽 설정 자동화 + 점검**만 담당한다.
- WSL2 네트워킹상 게이트웨이가 `h200.internal` 에 닿는지 `secure doctor` + 수동 확인 권장.

## 15.6 참고
- [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) · [WSL2 onboard --gpu 이슈 #208](https://github.com/NVIDIA/NemoClaw/issues/208)
- [Network Policy 커스터마이즈(NVIDIA Docs)](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/network-policy/customize-network-policy)
- Claude Code: `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `NO_PROXY`, `permissions.deny`, `sandbox.filesystem`
