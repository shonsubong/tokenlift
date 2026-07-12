# 03. 라우팅 정책

"무엇을 사내 모델로 보내고, 무엇을 Claude(Bedrock)가 직접 할 것인가"의 기준 문서.
**기밀(보안) 검증이 항상 먼저**다. (스킬 내부용 요약은
`skills/tokenlift/reference/routing-rules.md`, 패턴 상세는 [18. 실행자/조언자](18-executor-advisor.md).)

## 3.1 판단 알고리즘 (기밀 우선)

```
입력: 작업 설명
0) 기밀(민감) 신호 평가 ──────────── assessSensitivity() — 항상 먼저
        │
1) 고난도 판단 신호 포함?
        ├─ yes + 기밀 ──►  사내 GLM-5.2(oracle) — Bedrock 전송 금지
        └─ yes + 비민감 ─►  Claude = 조언자(advisor) 직접 처리
        │ no
2) 위임(개발) 신호?      ── yes ──►  사내 위임 — executor(GLM-5.2) / 경량은 coder(V100)
        │ no                        (기밀이면 경량도 executor 로 승급, Bedrock 승급 금지)
3) (애매)  ├─ 기밀 ─────►  사내 executor 강제
           └─ 비민감 ───►  기본 Claude (안전 우선)
```

이 로직은 `src/router.mjs` 의 `assessSensitivity()`/`recommend()` 로 구현되어 있고,
`tokenlift route "<설명>"` 이 **기밀도와 Bedrock 전송 허용/금지**까지 알려준다.

## 3.2 기밀(민감) 신호 — 외부 전송 금지 (최우선)

다음이 감지되면 **어떤 경우에도 Bedrock 으로 보내지 않고 사내 GLM-5.2 가 처리**한다:

- 개인키(`BEGIN PRIVATE KEY`) / 시크릿 할당(`api_key=...`) / AWS·NGC 키 패턴
- 사내 호스트(`*.internal`) / 주민등록번호 형태 / "사내기밀·대외비·confidential" 키워드
- `config.security.sensitivePatterns` 의 사용자 정의 패턴(프로젝트 코드명 등)

판단(설계·보안 검토)이 필요한 기밀 내용은 사내 최고지능(GLM-5.2, oracle)이 맡고, Claude 에게는
**기밀을 제거·추상화한 질문만** 보낸다. (폴더 수준 차단은 `tokenlift secure` 가 담당 — [15](15-nemoclaw-windows-security.md))

## 3.3 고난도 판단 신호 → 조언자(advisor, 비민감일 때만)

다음 키워드/의도가 보이면(그리고 기밀이 아니면) **Claude = 조언자**가 직접:

`아키텍처 / architecture / 설계 / design / 전략 / 보안 판단 / 취약점 / 인증 /
복잡한 디버깅 / root cause / 근본 원인 / 왜(why) / 트레이드오프 / 의사결정 / 마이그레이션 계획 /
전체 시스템(system-wide)`

이유: 고난도 추론·광범위 영향·정확성/위험이 핵심. 단 Claude 는 **$200/월 예산 자원**이므로
판단·조언·검토만 하고 긴 코드 생성은 executor 에 위임한다.

## 3.4 위임 신호 (task 분류 → 실행자)

task 가 감지되면 역할(카테고리)로 라우팅된다: **개발 실행(gen/edit/test/refactor/translate/
review) → executor(GLM-5.2→H200→V100)**, 경량 정형(explain/docs/fast/complete) → coder(V100),
난도 신호(알고리즘·대규모·동시성) → oracle.

| task | 트리거 키워드(일부) |
|---|---|
| `test` | 테스트, unit test, 테스트 코드 작성 |
| `translate` | 이식, 포팅, port, 변환, convert to |
| `refactor` | 리팩터, refactor, 이름 변경, rename, 일괄, bulk |
| `review` | 리뷰, review, 검토 |
| `docs` | 문서, docstring, 주석, comment |
| `explain` | 요약, summarize, 설명, explain, what does |
| `gen` | 생성, 작성, 구현, implement, 스캐폴드, boilerplate |
| `edit` | 수정, 변경, 추가, edit, change |

> 분류 순서가 중요하다. 구체적 태스크(test/translate/...)를 범용(gen/edit)보다 **먼저**
> 검사한다. 그래야 "테스트 코드 작성"이 `gen` 이 아닌 `test` 로 분류된다.

## 3.5 위임 임계값

사소한 작업까지 위임하면 왕복 지연이 절감보다 커진다. 다음 이상일 때 위임을 권장한다
(`config.thresholds`):

| 항목 | 기본값 | 의미 |
|---|---|---|
| `delegateMinOutputLines` | 30 | 생성 코드가 30줄 이상 예상 |
| `delegateMinFileLines` | 300 | 처리 대상 파일이 300줄 이상 |
| `delegateMinFiles` | 3 | 동일 패턴이 3개 파일 이상 |

이 값은 휴리스틱이며 `tokenlift route` 자동 판단에는 반영되지 않는 "Claude 용 가이드"다.
Claude 는 SKILL.md 의 이 기준을 보고 사람처럼 판단한다.

## 3.6 결정 매트릭스 (요약)

| 작업 | 주체(역할) | 명령 |
|---|---|---|
| 명세 명확한 구현체/보일러플레이트 | executor(GLM-5.2) | `gen` |
| 단위 테스트 | executor(GLM-5.2) | `test` |
| 일괄 리팩터링 | executor(GLM-5.2) | `refactor` |
| 언어/프레임워크 이식 | executor(GLM-5.2) | `translate` |
| 대용량 파일/로그 요약 | coder(V100) | `explain` |
| 문서/주석 | coder(V100) | `docs` |
| **기밀(민감) 데이터 포함 — 전부** | **사내 GLM-5.2 강제(Bedrock 금지)** | 해당 task |
| 시스템/API 설계(비민감) | Claude(advisor) | — |
| 복잡 디버깅·근본원인(비민감) | Claude(advisor) | — |
| 보안 로직의 "판단"(기밀 제거 후) | Claude(advisor) | — |
| 모호한 요구·트레이드오프 | Claude(advisor) | — |
| **위임 결과 검토·통합** | Claude | — |

## 3.7 하이브리드 워크플로우 (현실 패턴)

대부분 작업은 한쪽으로 딱 떨어지지 않는다. **조언(설계)=Claude → 실행=executor(GLM-5.2) →
검토=Claude** 로 쪼갠다.

```
"결제 알림 모듈 만들어줘"
 ├─ Claude(advisor)   : 인터페이스·에러전략·보안요건 설계     (고난도, 짧은 출력)
 ├─ executor(GLM-5.2) : 채널 구현체 3종 생성  tokenlift gen ... --role executor
 ├─ executor(GLM-5.2) : 각 구현체 테스트 생성  tokenlift test ... --role executor
 └─ Claude            : 보안 점검·통합·최종 검토               (책임)
```

## 3.8 안전장치

- **기밀이 최우선.** 기밀 신호가 있으면 위 어떤 규칙보다 먼저 사내 강제(Bedrock 전송 금지).
- **기본값은 Claude.** 위임 신호가 불명확(하고 비민감)하면 위임하지 않는다.
- **보안 민감 코드**는 위임하더라도 Claude 재검토를 필수로 한다(단, 기밀 원문은 재검토
  프롬프트에 넣지 말고 요약·비식별화 후).
- **백엔드 장애 시** 체인 자동 강등(GLM→H200→V100), 전부 불가면 Claude 가 직접(비민감일 때만).
- 자동 감지 훅은 **힌트만 주입**하며 실제 실행을 강제하지 않는다(Claude 가 최종 판단).

## 3.9 라우팅 커스터마이즈

`config/tokenlift.config.json`(팀) 또는 `~/.tokenlift/config.json`(개인)에서:

```jsonc
{
  "routing": {
    "default": "qwen2.5-coder:14b",
    "byTask": { "test": "deepcoder:latest", "gen": "devstral:24b" }
  },
  "thresholds": { "delegateMinOutputLines": 20 }
}
```

자세한 모델 선택은 [04. 모델 가이드](04-model-guide.md) 참조.
