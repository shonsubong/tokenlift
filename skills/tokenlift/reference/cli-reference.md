# TokenLift CLI 전체 참조

`tokenlift` 는 사내 온프렘 Ollama 서버(H200/V100) 또는 NemoClaw 에 코딩 작업을 위임하는 무의존성 Node CLI 다.

## 설치 / 호출 방법

> 스킬/서브에이전트/훅은 **플러그인**으로 설치된다(`/plugin install tokenlift@tokenlift`).
> 아래는 플러그인이 설치하지 않는 **CLI(tokenlift 명령)** 의 호출 방법이다.

세 가지 방법 중 하나로 호출한다.

1. **글로벌 명령 (권장)** — 저장소에서 한 번 등록하면 어디서나 `tokenlift` 사용:
   ```bash
   cd <설치경로>/TokenLift && bash scripts/install.sh   # npm link(실패 시 Windows shim)
   tokenlift doctor
   ```
2. **직접 실행** — 링크 없이:
   ```bash
   node "<설치경로>/TokenLift/bin/tokenlift.mjs" doctor
   ```
3. **환경변수 경로** — `TOKENLIFT_HOME` 지정 후:
   ```bash
   node "$TOKENLIFT_HOME/bin/tokenlift.mjs" doctor   # bash
   node "$env:TOKENLIFT_HOME\bin\tokenlift.mjs" doctor   # PowerShell
   ```

## 입출력 계약 (Claude 가 알아야 할 핵심)

- **stdout = 결과물만.** 코드 태스크는 코드펜스가 제거된 순수 코드, 분석 태스크는 텍스트.
  → Claude 는 stdout 을 그대로 받아 사용/통합하면 된다.
- **stderr = 메타정보.** 사용 모델, 토큰 in/out, 소요시간, 절감 추정액. 결과물을 오염시키지 않음.
- `-o <path>` 또는 `--apply` 사용 시 stdout 에는 **저장된 파일 경로**가 출력된다.
- `--json` 사용 시 stdout 에 `{task, model, payload, inTokens, outTokens, estimate, ...}` JSON.

## 명령 목록

### 코딩 위임 (stdout = 코드)
| 명령 | 용도 | 대표 예시 |
|---|---|---|
| `gen` | 명세로 새 코드 생성 | `tokenlift gen "JWT 미들웨어" --lang ts` |
| `edit` | 파일을 지시대로 수정(전체 반환) | `tokenlift edit "널체크 추가" -f a.js --apply` |
| `test` | 단위 테스트 생성 | `tokenlift test -f svc.py -o tests/test_svc.py` |
| `refactor` | 동작 보존 리팩터링 | `tokenlift refactor "함수 분리" -f big.js --apply` |
| `translate` | 언어/프레임워크 이식 | `tokenlift translate -f a.py --lang python --to go` |
| `complete` | FIM(중간 코드 채우기) | `tokenlift complete --prefix "def f(" --suffix "):"` |

### 분석/문서 (stdout = 텍스트)
| 명령 | 용도 | 대표 예시 |
|---|---|---|
| `explain` | 코드/로그 요약·설명 (입력토큰 절감) | `tokenlift explain -f huge.ts "데이터 흐름"` |
| `review` | 로컬 코드 리뷰 | `tokenlift review -f patch.diff` |
| `docs` | 문서/주석 생성 | `tokenlift docs "API 사용법" -f api.ts` |
| `ask` | 임의 프롬프트 | `tokenlift ask "이 정규식 의미"` |

### 라우팅/운영
| 명령 | 용도 |
|---|---|
| `route "<설명>"` | 위임 여부 + 역할 + 백엔드/모델 + 비용티어 추천 (`--json` 가능) |
| `roles` | 에이전트 역할→백엔드 매핑 + 비용 에스컬레이션 사다리 |
| `providers` | 설정된 백엔드(provider) 목록 + 활성 표시 |
| `models` | (활성 provider) 모델 목록 + task→model 매핑 |
| `doctor` | Node/설정/백엔드 연결/필수 모델 점검 (`--provider` 가능) |
| `warmup -m <model>` | 모델을 메모리에 선적재(연속 위임 전 권장) |
| `stats` | 누적 위임 횟수·토큰·Bedrock 환산 절감액(백엔드별) |
| `secure init\|doctor\|status` | NemoClaw 보안 게이트웨이 자동 적용/점검(Bedrock→게이트웨이, 온프렘 예외, 민감폴더 차단). `docs/15` 참조 |
| `help` | 도움말 |

## 플래그

| 플래그 | 의미 |
|---|---|
| `-p, --provider <name>` | 백엔드 선택 (`ollama`/`nemoclaw`/`onprem-h200`/`onprem-v100`). 미지정 시 `config.provider` |
| `--role <name>` | 역할로 백엔드 자동 선택 (`coder`=V100 / `oracle`=H200). `--provider` 가 우선 |
| `-m, --model <name>` | 사용할 모델 강제 지정(라우팅 무시). 모델명은 백엔드별로 다름 |
| `-f, --file <path>` | 입력 파일(여러 번 반복 가능) |
| `-o, --out <path>` | 결과를 파일로 저장(stdout 엔 경로) |
| `--apply` | (edit/refactor) 단일 입력파일에 결과를 덮어쓰기 |
| `--lang <l>` | 소스 언어 힌트 |
| `--to <l>` | (translate) 대상 언어 / (complete) suffix |
| `--prefix`, `--suffix` | (complete) FIM 접두/접미 |
| `--host <url>` | 백엔드 호스트 override |
| `--timeout <ms>` | 요청 타임아웃(기본 600000) |
| `--temp <n>` | temperature (미지정 시 provider 권장값 또는 0.1) |
| `--top-p <n>` | top-p(nucleus) 샘플링 |
| `--top-k <n>` | top-k 샘플링 |
| `--min-p <n>` | min-p 샘플링 |
| `--think <on\|off>` | 추론(thinking) 토글 — GLM/llama.cpp(openai-compat) 전용 |
| `--num-ctx <n>` | 컨텍스트 윈도우 토큰 수(ollama) |
| `--json` | 기계 판독용 JSON 출력 |
| `-q, --quiet` | stderr 메타 출력 억제 |
| `--no-log` | 사용량 로깅 비활성화 |

## 백엔드(provider) & 에이전트 역할

> H200×8/V100×8 은 하드웨어. 그 위에서 **Ollama(특화 모델)** 또는 **NemoClaw** 서빙.

| provider | 대상 | type | 역할 | 모델 태그 예시 |
|---|---|---|---|---|
| `ollama` | 로컬 Ollama | ollama | (보조 coder) | `qwen2.5-coder:14b` |
| `onprem-v100` | V100×8 클러스터 Ollama | ollama | **coder**(대량·최저가) | `qwen2.5-coder:14b` |
| `onprem-h200` | H200×8 클러스터 Ollama | ollama | **oracle**(어려운/대형) | `qwen2.5-coder:32b`, `deepseek-r1:70b` |
| `onprem-glm` | GLM-5.2 @ llama.cpp(`llama-server`) | openai-compat | **oracle 1순위**(프런티어) | `glm-5.2` |
| `nemoclaw` | NIM (OpenAI 호환) | openai-compat | (온프렘 대안) | `qwen/qwen2.5-coder-32b-instruct` |

역할은 **폴백 체인**으로 동작(실패 시 자동 강등): **executor(실행자)=GLM-5.2→H200→V100**(개발
대부분·기밀 작업), coder=V100→H200(경량), oracle=GLM-5.2→H200→V100→claude, **advisor(조언자)=
claude**(비민감 고난도 판단, $200/월 예산). `tokenlift route` 가 **기밀도**를 함께 판정해 기밀이면
Bedrock 전송을 금지하고 사내로 강제한다(`config.security.sensitivePatterns` 로 패턴 추가).
GLM-5.2 서빙·연동은 `docs/16-glm-multiquant-team.md`, 패턴 상세는 `docs/18-executor-advisor.md` 참조.
```bash
tokenlift roles                          # 역할→폴백 체인 + 비용 에스컬레이션 사다리
tokenlift route "<작업>"                  # 역할/티어/폴백 추천
tokenlift test -f a.ts --role coder      # V100(실패시 자동 강등)로 대량 위임
tokenlift gen "알고리즘 구현" --role oracle # H200 로 어려운 작업 위임
```
비용 사다리: 그래프(무료) → V100(coder) → H200 → GLM-5.2(executor/oracle, 사내 무제한) → Bedrock(claude, $200/월).
설정/모델/인증은 `docs/11-providers.md`, 역할·GPU·비용은 `docs/13-multi-model-agents.md` 참조.

## 환경변수

| 변수 | 효과 |
|---|---|
| `OLLAMA_HOST` / `TOKENLIFT_HOST` | Ollama 호스트 |
| `TOKENLIFT_PROVIDER` | 활성 백엔드(provider) |
| `TOKENLIFT_MODEL` | 기본 모델 오버라이드 |
| `TOKENLIFT_TIMEOUT_MS` | 기본 타임아웃 |
| `TOKENLIFT_NO_LOG=1` | 로깅 비활성화 |
| `NEMOCLAW_API_KEY` | nemoclaw Bearer 키(또는 `apiKeyEnv` 로 지정한 변수) |
| `ONPREM_API_KEY` | onprem-h200 / onprem-v100 Bearer 키(인증 시) |
| `TOKENLIFT_HOME` | 직접 실행 시 저장소 경로 |

## 설정 파일

우선순위(낮음→높음): 내장 기본값 < `config/tokenlift.config.json`(팀 기본) < `~/.tokenlift/config.json`(개인) < 환경변수.
모델 매핑, 단가(`pricing`), 임계값, 로깅 위치를 여기서 조정한다. 자세한 키는 `docs/05-implementation.md` 참조.

## Claude 사용 패턴 예시

```bash
# 1) 연속 위임 전 워밍업
tokenlift warmup -m qwen2.5-coder:14b

# 2) 테스트 생성을 위임하고 파일로 저장
tokenlift test -f src/payment.ts -o src/payment.test.ts
#  → Claude 는 저장된 테스트를 Read 로 검토 후 필요한 부분만 보정

# 3) 대용량 로그 요약(입력 토큰 절감)
tokenlift explain -f build_error.log "실패 원인 후보만 5줄로"
#  → Claude 는 원문 수천 줄 대신 요약만 받아 판단
```
