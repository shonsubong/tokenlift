# 07. 비용 분석

## 7.1 절감 추정 방식

TokenLift는 **사내 온프렘 Ollama 서버가 처리한 토큰을, 만약 Bedrock(Claude)이 처리했다면 들었을 비용**
으로 환산해 절감액을 추정한다.

```
grossUsd = inTokens  × inputPer1M  / 1,000,000
         + outTokens × outputPer1M / 1,000,000
```

- `inTokens` = Ollama 가 읽은 프롬프트 토큰(`prompt_eval_count`)
- `outTokens` = Ollama 가 생성한 토큰(`eval_count`)
- 단가는 `config.pricing`(기본: Sonnet 가정 $3/$15 per 1M). **사내 실제 단가로 바꿔라.**

## 7.2 "gross" 의 의미와 한계 (정직한 고지)

이 값은 **상한선에 가까운 총량(gross) 추정치**다. 실제 순절감(net)은 다음 때문에 더 작다.

1. **재읽기 비용** — Claude 가 Ollama 결과를 검토하려면 그 출력을 입력으로 다시 읽는다.
   `재읽기 ≈ outTokens × inputPer1M`. 출력 단가($15)보다 입력 단가($3)가 싸므로
   생성 위임은 여전히 크게 이득이지만 0은 아니다.
2. **검토/보정 비용** — Claude 가 수정·보강하면 추가 토큰이 든다.
3. **품질 재작업** — 로컬 결과가 부적합해 재위임/직접작성하면 절감이 상쇄될 수 있다.

따라서 `stats` 의 수치는 **"로컬로 옮긴 작업량의 Bedrock 환산 규모"** 로 해석하고,
순절감은 그보다 보수적으로 보는 것이 옳다.

### 생성 위임의 순절감(근사)

```
net ≈ (outTokens × outputPer1M)            ← 아낀 비싼 출력
    + (inTokens  × inputPer1M)             ← 아낀 입력(있다면)
    − (outTokens × inputPer1M)             ← Claude 재읽기
    − (검토/보정 토큰 × 해당 단가)
```

출력 단가가 입력의 5배이므로, **생성량이 많을수록 순절감 비율이 1에 가까워진다.**

## 7.3 실측 예시 (이 환경에서 관측된 값)

스모크 테스트에서 기록된 실제 토큰(단가 $3/$15 기준):

| 작업 | 모델 | in/out 토큰 | Bedrock 환산(gross) |
|---|---|---|---|
| `explain` (router.mjs 요약) | gemma3:4b | 1127 / 580 | $0.0121 |
| `gen` (작은 함수) | gemma3:4b | 130 / 32 | $0.0009 |
| `complete` (FIM) | qwen2.5-coder:1.5b-base | 18 / 18 | $0.0003 |

> 작은 예시라 절대액은 작다. 실제 절감은 **대량 생성·대용량 파일**에서 발생한다.

## 7.4 규모 추정 (가정 시나리오)

가정: 하루 위임으로 Bedrock 출력 토큰 **2M**, 입력 토큰 **3M** 을 로컬로 이전.
단가 Sonnet $3/$15.

```
gross/일 = 3M×$3/1M + 2M×$15/1M = $9 + $30 = $39/일
재읽기   ≈ 2M×$3/1M = $6/일
net/일   ≈ $39 − $6 − (검토 약간) ≈ $30/일  (≈ 월 $600 수준, 영업일 기준)
```

Opus 단가($15/$75)를 쓰는 팀이라면 같은 토큰량의 절감액이 **약 5배**가 된다.
정확한 수치는 단가·작업 패턴에 따라 달라지므로 `config.pricing` 을 실단가로 맞춰
`stats` 로 실측하라.

## 7.5 단가·월 예산 설정 (실단가로 교체)

`config/tokenlift.config.json` 또는 `~/.tokenlift/config.json`:

```jsonc
"pricing": {
  "label": "claude-opus-on-bedrock",
  "inputPer1M": 15.0,
  "outputPer1M": 75.0,
  "monthlyBudgetUsd": 200        // 한 달 Bedrock 목표 예산
}
```

> Bedrock 단가는 모델/리전/약정에 따라 다르다. 사내 청구 기준값을 사용하라.
> (이 문서의 $3/$15, $15/$75 는 예시 가정치이며 실제 청구액이 아니다.)

### 월 예산 운영 ($200/월 시나리오)

`tokenlift stats` 가 **이번 달** 위임 절감액과 예산 대비 지표를 보여준다:

```
이번 달(2026-07): 위임 132회, Bedrock 환산 절감 $87.40
월 Bedrock 예산: $200.00 — 위임이 없었다면 예산의 약 44% 를 추가 소비했을 양을 사내에서 처리
```

**정직한 한계**: TokenLift 는 Claude Code 가 실제로 쓴 Bedrock 토큰을 볼 수 없다 —
그건 Claude Code 의 `/cost` 로 확인한다. 두 수치를 함께 보고, 예산 초과 조짐이면
위임 비중(특히 executor=GLM-5.2)을 더 높인다. → [18. 실행자/조언자](18-executor-advisor.md)

## 7.6 절감을 극대화하는 법

1. **출력이 큰 작업을 우선 위임** — 출력 토큰이 가장 비싸다.
2. **대용량 컨텍스트는 explain 으로 선요약** — 입력 토큰을 로컬로 흡수.
3. **검토를 가볍게** — 위임 결과를 Claude 가 전량 재작성하지 말 것(상쇄됨).
4. **모델 묶기** — 재적재 비용(시간)을 줄여 처리량↑.
5. **사소한 작업은 위임하지 않기** — 왕복 지연 > 절감.

## 7.7 측정·리포팅

```bash
tokenlift stats   # 누적 위임 횟수, 로컬 처리 토큰, 환산 절감, 태스크/모델별 분포
```

로그 원본: `~/.tokenlift/usage.jsonl` (JSON Lines). 자체 대시보드/집계에 활용 가능.
필드: `ts, task, model, inTokens, outTokens, grossUsd, durationMs`.
