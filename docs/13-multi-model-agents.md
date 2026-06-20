# 13. 멀티모델 에이전트 라우팅 (오케스트레이터-워커 + 온프렘 H200/V100)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)(OmO)의 **실제 위임
메커니즘**(코드/문서 확인)을 참고해, 사내 제약(Claude=Bedrock 전용, 온프렘 H200×8/V100×8
GPU 위에서 **Ollama 특화 모델** 또는 **NemoClaw** 서빙, 비용 최소화)에 맞춘 라우팅 구조다.

## 13.1 OmO 에서 가져온 위임 코어 (어떻게/어떤 모델로 위임하나)

OmO 의 핵심은 **"역할별 모델 폴백 체인 + 런타임 해석"** 이다. 근거(소스):
- `packages/model-core/src/agent-model-requirements.ts` — 에이전트마다 `fallbackChain`:
  `[{ providers:[...], model, variant }, ...]` 순서 목록 + `requiresAnyModel`/`requiresProvider`.
- `packages/delegate-core/src/model-selection.ts` (`resolveModelForDelegateTask`) — 입력 모델 →
  사용자 폴백 → 카테고리 기본 → fallbackChain 순으로, **연결된 provider + 사용가능 모델
  집합**에 대해 앞에서부터 매칭되는 첫 항목을 고른다.
- `docs/guide/agent-model-matching.md` — "**모델 = 개발자**" 철학: 에이전트마다 작업 *스타일*에
  맞는 모델을 배정(메커니즘 주도 Claude vs 원칙 주도 GPT). 모델 매칭은 우열이 아니라 "적합".

OmO 의 실제 에이전트→모델 배정(요지):

| OmO 에이전트 | 역할/스타일 | 모델 폴백 체인(요약) |
|---|---|---|
| **Sisyphus** | 오케스트레이터(메커니즘·1,100줄 프롬프트) | Claude(Opus/Sonnet) → Kimi K2.x → GPT-5.5 → GLM-5 |
| **Hephaestus** | 심층 전문가(자율 멀티파일) | **GPT-5.5 전용**(Claude 폴백 없음) |
| **Oracle** | 설계/디버깅 리뷰 | GPT-5.5(high) → Gemini-3.1-pro → Claude-Opus → GLM-5.1 |
| **Librarian** | 빠른 탐색/검색 | 저가·고속(gpt-mini-fast / Qwen / MiniMax) |

> 즉 "어떤 모델로 위임?"의 답은 **고정 1:1 이 아니라, 역할별 우선순위 체인을 런타임 가용
> 백엔드에 맞춰 해석**한 결과다. `doctor` 가 에이전트별 "유효 모델 해석"을 보여준다.

## 13.2 제약 → 백엔드 매핑 (GPU=하드웨어, 서빙=Ollama/NemoClaw)

> **H200×8 / V100×8 은 하드웨어다.** 그 위에서 **Ollama(여러 특화 모델)** 또는 **NemoClaw/NIM**
> 을 서빙한다. TokenLift 기본은 `type:'ollama'`(특화 모델을 task별로 매핑, FIM·keep_alive·
> warmup 네이티브). NemoClaw/NIM/vLLM 서빙이면 `type:'openai-compat'` 로 교체.

| 자원 | 성격 | 서빙 | TokenLift 역할 |
|---|---|---|---|
| **Claude (AWS Bedrock 전용)** | 외부, 최고 판단력, 최고가(토큰) | — | **lead / reviewer** |
| **H200×8** (고속/대용량 HBM3e) | 온프렘 | Ollama 큰 특화 모델 / NemoClaw | **oracle** — 어려운 추론·대형 생성 |
| **V100×8** (구형, 32GB×8) | 온프렘 | Ollama 중소·양자화(GGUF) 모델 / NemoClaw | **coder** — 대량·정형 생성(최저가) |
| **codebase-memory-mcp** | 로컬 그래프 | — | **explorer** — 탐색(무료) |

## 13.3 에이전트 팀 = 역할별 폴백 체인 (OmO fallbackChain 반영)

`config.roles` 에 역할마다 **체인**(우선순위 백엔드)을 둔다. `tokenlift roles` 로 확인.

```
lead     (orchestration)  chain: claude                              → Bedrock 직접
explorer (retrieval)      chain: codebase-memory-mcp                 → 그래프(무료)
coder    (bulk-code)      chain: onprem-v100 → ollama → onprem-h200  → 최저가 우선
oracle   (deep-reasoning) chain: onprem-h200 → onprem-v100 → claude  → 프런티어 우선, 최후 Bedrock
reviewer (judgment)       chain: claude                              → Bedrock 직접
```

**런타임 해석(OmO 와 동일한 원리):** 체인 앞에서부터 "호출 가능(설정됨)·도달 가능"한 첫
백엔드를 쓰고, **연결/타임아웃 실패면 다음으로 자동 강등**한다. 예: `--role coder` 가 V100 에
연결 실패하면 자동으로 로컬 `ollama` 로 내려가 처리한다(실측 확인됨). 체인이 `claude`/그래프로
끝나면 "위임 대상 없음 → Claude 가 직접 처리"를 의미한다.

## 13.4 비용 최소화 에스컬레이션

```
① codebase-memory-mcp(무료) → ② onprem-v100(coder) → ③ onprem-h200(oracle) → ④ claude(Bedrock)
   탐색/이해                    대량·정형 생성           어려운/대형 생성          판단·보안·최종검토
   가장 쌈 ─────────────────────────────────────────────────────────────────▶ 가장 비쌈
```
- **충분히 처리되는 가장 싼 단계에서 멈춘다.** 온프렘 한계비용 ≈ 전기료(고정비 상각) ≪ Bedrock
  토큰 과금. V100 은 H200 보다 저가라 대량 작업의 단위비용이 더 낮다. Claude(Bedrock)는 최후.
- 자동 판단: 보안/설계/근본원인 → claude. 대량/정형 → coder(V100). 난도 신호(알고리즘·대규모·
  동시성·멀티파일) → oracle(H200) 자동 승급. `tokenlift route "<작업>"` 가 역할·티어·폴백 제시.

## 13.5 모델 선택 — Ollama 특화 모델 (예시, 실제 pull 모델로 교체)

> 핵심: **GPU 위 Ollama 에 "여러 특화 모델"을 올려 task별로 라우팅**한다(코더/추론/FIM/문서 등).
> 아래는 `config.providers.onprem-*.routing` 예시 태그. `tokenlift models --provider onprem-h200`
> 로 클러스터가 실제 보유한 태그를 확인하라.

### H200×8 — oracle (큰 특화 모델)
| task | Ollama 태그(예) |
|---|---|
| reason / review | `deepseek-r1:70b` (추론 특화) |
| gen/edit/test/refactor/translate/explain | `qwen2.5-coder:32b` |
| agent(멀티파일) | `devstral:24b` |
| docs | `llama3.3:70b` |
| complete(FIM) | `qwen2.5-coder:7b` |

### V100×8 — coder (중소·양자화 GGUF)
| task | Ollama 태그(예) |
|---|---|
| gen/edit/test/refactor/translate/review | `qwen2.5-coder:14b` |
| reason | `deepseek-r1:14b` |
| docs/explain/fast | `llama3.1:8b` |
| complete(FIM) | `qwen2.5-coder:1.5b-base` |

> GGUF Q4/Q5 양자화 모델은 Volta(V100)에서도 동작한다(llama.cpp 기반 Ollama). 큰 모델은
> H200 에, 중소·양자화 모델은 V100 에 배치해 처리량/비용을 최적화한다.

## 13.6 서빙 → provider 연결

**기본: Ollama (특화 모델 다수)** — `type:'ollama'`, host = 클러스터 Ollama 주소.
```jsonc
// ~/.tokenlift/config.json (사내 값으로 교체)
{ "providers": {
  "onprem-h200": { "type": "ollama", "host": "http://h200.internal:11434",
    "routing": { "default": "qwen2.5-coder:32b", "byTask": { "reason": "deepseek-r1:70b" } } },
  "onprem-v100": { "type": "ollama", "host": "http://v100.internal:11434",
    "routing": { "default": "qwen2.5-coder:14b" } }
}}
```
```bash
ssh h200  ollama pull qwen2.5-coder:32b   # 클러스터에 특화 모델 적재(예)
tokenlift doctor --provider onprem-h200    # 연결·모델 점검
tokenlift models --provider onprem-v100    # 보유 태그 확인
```

**대안: NemoClaw / NIM (OpenAI 호환)** — 같은 GPU 를 NIM 으로 서빙한다면:
```jsonc
"onprem-h200": { "type": "openai-compat", "host": "http://h200.internal:8000",
  "apiPath": "/v1", "apiKeyEnv": "ONPREM_API_KEY",
  "routing": { "default": "qwen/qwen2.5-coder-32b-instruct" } }
```

## 13.7 협업 워크플로우 예시 (하이브리드)

```
"결제 정산 모듈 신규 구현"
 1. [explorer/그래프]  get_architecture·search_graph 로 기존 결제 코드 파악(입력↓)
 2. [lead/Claude]      인터페이스·정합성·보안 요건 설계(짧은 고판단)
 3. [coder/V100]       DTO·검증·CRUD·테스트 대량 생성   tokenlift gen/test --role coder
 4. [oracle/H200]      정산 금액 계산(정밀/동시성) 알고리즘 구현  tokenlift gen --role oracle
 5. [reviewer/Claude]  보안(금액·권한)·정합성 최종 검토·통합
```
가장 비싼 Claude(Bedrock)는 2·5 의 판단/검토에만 쓰이고, 양이 많은 3·4 생성은 온프렘 Ollama
가, 탐색 1 은 그래프가 흡수한다 → Bedrock 토큰 최소화. 한 클러스터가 다운되면 체인이 자동
강등(예: H200 다운 → V100 → 그래도 안되면 Claude).

## 13.8 서브에이전트 (격리 위임)

| 에이전트 | 역할 | 체인 |
|---|---|---|
| `ollama-delegate` | coder — 대량·정형 생성 | onprem-v100 → ollama → onprem-h200 |
| `onprem-oracle` | oracle — 어려운 추론·대형 생성 | onprem-h200 → onprem-v100 → claude |

메인 Claude(lead)는 무거운 작업을 이 서브에이전트로 **병렬 격리** 실행해 자신의 컨텍스트를
린하게 유지한다(OmO 의 "background task 로 영역 매핑" 패턴).

## 13.9 주의 / 한계

- 역할 자동 판단은 키워드 휴리스틱 — `--role`/`--provider` 로 수동 지정 가능.
- 온프렘 호스트/모델 태그는 **예시 placeholder**다. 실제 Ollama 엔드포인트·pull 모델로 교체.
- 보안·금액·권한 등 위험 코드의 **최종 판단은 항상 Claude(reviewer)**.
- 체인의 모든 백엔드가 다운이면 위임 실패를 알리고 Claude 직접 처리로 폴백한다(가용성 우선).
