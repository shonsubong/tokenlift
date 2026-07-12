# 06. 사용 방법

## 6.0 코드 탐색은 그래프 먼저 (기본)

코드베이스를 **이해·검색·추적**해야 할 때는 파일 통독 전에 `codebase-memory-mcp` 지식 그래프를
쓴다(입력 토큰 ~99%↓). 스킬이 이를 기본으로 유도한다.

```
"인증 로직이 어디서 호출되는지 찾아줘"
   → (그래프) search_graph → trace_path 로 호출자 추적, 파일 통독 없이 답
"이 모듈 구조 설명해줘"
   → (그래프) get_architecture 한 번으로 레이어·진입점·핫스팟 파악
"내 변경이 뭘 깨뜨릴 수 있어?"
   → (그래프) detect_changes 로 영향 범위·리스크
```
처음 한 번 "이 프로젝트 인덱싱해줘"(`index_repository`)면 충분하다. 자세히 → [12. 코드 탐색 위임](12-codebase-memory.md).
MCP 가 없으면 평소대로 Read/Grep 으로 동작한다.

## 6.1 생성 위임 방식 3가지

| 방식 | 설명 | 적합 상황 |
|---|---|---|
| **A. 스킬 자동 발동** | Claude Code 가 요청을 보고 `tokenlift` 스킬을 스스로 사용 | 평소 |
| **B. 서브에이전트 위임** | 무거운 생성 작업을 `ollama-delegate` 에이전트로 격리 실행 | 대량/멀티파일 |
| **C. 수동 CLI** | 터미널에서 `tokenlift` 직접 실행 | CI/스크립트/단독 사용 |

## 6.2 방식 A — Claude Code 스킬 (권장)

설치 후([08](08-installation.md)), 평소처럼 요청하면 된다. 위임 의도를 드러내면 더 확실히 발동한다.

```
"이 service.py에 대한 단위테스트 작성해줘. 토큰 아끼게 Ollama로 돌려."
"이 5천 줄 로그에서 에러 원인만 요약해줘 (로컬로)."
"이 파이썬 유틸을 Go로 이식해줘."
```

Claude 는 내부적으로 다음을 수행한다:
1. **기밀 검증 + 위임 적합성 판단**(라우팅 규칙) → 2. `tokenlift <task>` 실행 →
3. 결과 검토 → 4. 파일 통합 → 5. 요약 보고.

설계/복잡 디버깅 같은 고난도 판단은(기밀이 없을 때) Claude(조언자)가 직접 처리한다.
**기밀(키/고객정보/사내 코드명 등)이 포함되면 판단까지 사내 GLM-5.2 가 담당**하고 Claude 에겐
기밀을 제거한 요약만 전달된다. → [03. 라우팅 정책](03-routing-policy.md) · [18. 실행자/조언자](18-executor-advisor.md)

## 6.3 방식 B — 서브에이전트

```
"ollama-delegate 에이전트로 src/ 하위 5개 서비스의 테스트를 모두 생성해줘."
```

서브에이전트는 메인 대화 컨텍스트를 더럽히지 않고 위임을 격리 실행한 뒤, 산출 경로와
주의점만 간결히 보고한다(생성 코드 전문을 메인 컨텍스트로 끌어오지 않음 → 추가 절감).

## 6.4 방식 C — 수동 CLI

### 코드 생성
```bash
tokenlift gen "JWT 검증 Express 미들웨어, 만료/서명 오류 구분" --lang ts
```

### 파일 수정 (그 파일에 덮어쓰기)
```bash
tokenlift edit "모든 공개 함수에 입력 검증 추가" -f src/api.js --apply
```

### 단위 테스트 → 파일 저장
```bash
tokenlift test -f src/payment.ts -o src/payment.test.ts
```

### 일괄 리팩터링
```bash
tokenlift refactor "콜백을 async/await로 변환, 동작 보존" -f legacy.js --apply
```

### 언어 이식
```bash
tokenlift translate -f util.py --lang python --to go -o util.go
```

### 대용량 파일 요약 (입력 토큰 절감)
```bash
tokenlift explain -f huge_module.ts "핵심 데이터 흐름과 외부 의존성만"
cat build_error.log | tokenlift explain "실패 원인 후보 5줄로"
```

### FIM (중간 코드 채우기)
```bash
tokenlift complete --prefix "def fib(n):
    if n < 2: return n
    return " --suffix ""
```

## 6.5 권장 운영 절차

```bash
# 1) (세션 시작) 환경 점검
tokenlift doctor

# 2) (연속 위임 전) 모델 워밍업 — 콜드로드 지연 제거
tokenlift warmup -m qwen2.5-coder:14b

# 3) 위임 실행 (같은 모델로 묶으면 빠름)
tokenlift test -f a.ts -o a.test.ts
tokenlift test -f b.ts -o b.test.ts

# 4) (수시) 절감 확인
tokenlift stats
```

## 6.6 입출력 활용 팁 (Claude/스크립트용)

- 기본은 stdout 으로 결과가 나오므로 파이프/리다이렉트로 받을 수 있다:
  ```bash
  tokenlift gen "..." > out.ts
  ```
- 기계 처리에는 `--json` 사용:
  ```bash
  tokenlift gen "..." --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).outTokens))'
  ```
- 메타 출력(토큰/비용)이 거슬리면 `-q`.

## 6.7 실전 시나리오: 알림 모듈 (하이브리드)

```
1) [Claude] 인터페이스/에러 전략/보안 요건 설계
2) [Ollama] 채널 구현체 생성
   tokenlift warmup -m qwen2.5-coder:14b
   tokenlift gen "Notifier 인터페이스 구현: EmailChannel" --lang ts -o src/email.ts
   tokenlift gen "Notifier 인터페이스 구현: SmsChannel"   --lang ts -o src/sms.ts
3) [Ollama] 테스트 생성
   tokenlift test -f src/email.ts -o src/email.test.ts
   tokenlift test -f src/sms.ts   -o src/sms.test.ts
4) [Claude] 보안 점검(자격증명 처리 등)·통합·최종 검토
5) tokenlift stats 로 절감 확인
```

가장 비싼 부분(2,3의 대량 코드 출력)이 로컬에서 처리되어 Bedrock 출력 토큰을 크게 아낀다.

## 6.8 자주 쓰는 한 줄

```bash
tokenlift route "<무엇을 할지>"   # 위임할지/어떤 모델인지 추천
tokenlift models                  # 설치 모델 + 매핑 확인
tokenlift stats                   # 누적 절감
```
