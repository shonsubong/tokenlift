# 04. 모델 가이드

작업별로 어떤 로컬 Ollama 모델을 쓸지에 대한 가이드. 현재 환경에 설치된 모델 기준이며,
사내 환경에 맞게 `config.routing` 으로 조정한다.

## 4.1 설치된 모델 (이 환경 기준)

| 모델 | 크기 | 파라미터 | 계열 | 강점 | 권장 용도 |
|---|---|---|---|---|---|
| `qwen2.5-coder:14b` | 9GB | 14.8B | qwen2 | 코드 생성/이해 균형 우수 | **주력**(gen/edit/test/refactor/translate/explain) |
| `devstral:24b` | 14GB | 23.6B | llama | 에이전트형 멀티파일 코딩 | 복잡한 멀티파일 생성(`agent`) |
| `deepcoder:latest` | 9GB | 14.8B | qwen2 | 코드 리뷰/분석 | `review` |
| `deepseek-r1:14b` | 9GB | 14.8B | qwen2 | 단계적 추론 | `reason`(알고리즘/논리, `<think>` 자동제거) |
| `qwen2.5-coder:1.5b-base` | 1GB | 1.5B | qwen2 | 초고속 FIM | `complete`(중간 채우기) |
| `gemma3:12b` | 8GB | 12.2B | gemma3 | 자연어 산문 | `docs`(문서/설명 글) |
| `gemma3:4b` | 3GB | 4.3B | gemma3 | 경량·저지연 | `fast`(간단/짧은 작업) |
| `gemma3:27b` | 17GB | 27.4B | gemma3 | 고품질 산문 | 긴 문서(수동 `-m`) |
| `qwq:latest` | 20GB | 32.8B | qwen2 | 심층 추론 | 난도 높은 추론(수동 `-m`) |
| `phi4-reasoning` | 11GB | 14.7B | phi3 | 추론 | 대안 추론 모델 |

> `tokenlift models` 로 현재 설치 상태와 라우팅 매핑을 항상 확인할 수 있다.

## 4.2 기본 라우팅 (task → model)

```jsonc
"routing": {
  "default": "qwen2.5-coder:14b",
  "byTask": {
    "gen":       "qwen2.5-coder:14b",
    "edit":      "qwen2.5-coder:14b",
    "test":      "qwen2.5-coder:14b",
    "refactor":  "qwen2.5-coder:14b",
    "translate": "qwen2.5-coder:14b",
    "explain":   "qwen2.5-coder:14b",
    "review":    "deepcoder:latest",
    "agent":     "devstral:24b",
    "reason":    "deepseek-r1:14b",
    "docs":      "gemma3:12b",
    "fast":      "gemma3:4b",
    "complete":  "qwen2.5-coder:1.5b-base"
  },
  "fallback":   "gemma3:4b"
}
```

## 4.3 모델 선택 기준

1. **대부분의 코딩 위임 → `qwen2.5-coder:14b`.**
   코드 품질과 속도의 균형이 가장 좋고, 한 모델로 묶으면 재적재가 없어 빠르다.
2. **멀티파일·에이전트형 복잡 생성 → `devstral:24b`.**
   여러 파일을 함께 다루는 대형 생성에 강하지만 14GB라 로딩/추론이 더 무겁다.
3. **리뷰 → `deepcoder`**, **추론 위임 → `deepseek-r1`**, **문서 → `gemma3:12b`**.
4. **초간단/저지연 → `gemma3:4b`**, **FIM 자동완성 → `qwen2.5-coder:1.5b-base`**.

## 4.4 성능·자원 고려사항

- **콜드 로드 비용이 크다.** 9~14GB 모델의 첫 호출은 메모리 적재로 수십 초가 걸릴 수 있다.
  연속 위임 전 `tokenlift warmup -m <model>` 로 미리 적재하라.
- **모델 교체 = 재적재.** 한 세션에서 모델을 자주 바꾸면 매번 로딩 비용이 든다.
  가능하면 **단일 코드 모델로 묶어** 위임한다.
- **keep_alive** 기본 30분(`config.ollama.keepAlive`). 이 시간 동안 모델이 메모리에 상주한다.
- **VRAM/RAM 한계** 초과 시 Ollama 가 일부를 CPU로 내려 느려진다. 동시에 큰 모델 여러 개를
  올리지 말 것.
- **컨텍스트 윈도우**: `config.ollama.numCtx`(기본 8192). 대용량 `explain` 시 더 큰 입력이
  필요하면 `--num-ctx` 로 늘리되 메모리/속도와 trade-off.

## 4.5 품질 한계와 대응

| 현상 | 원인 | 대응 |
|---|---|---|
| 산출 코드에 군더더기 설명 포함 | 모델이 지시 무시 | CLI 가 코드펜스만 추출(util.extractCode). 그래도 남으면 Claude 가 정리 |
| `<think>...</think>` 누출 | r1/qwq 추론 모델 | CLI 가 자동 제거(util.stripThink) |
| 요구 누락/오해 | 모델 능력·모호한 지시 | 지시를 더 구체화해 재위임, 또는 Claude 마무리 |
| 보안 결함 | 로컬 모델 한계 | 보안 코드는 Claude 필수 재검토 |

## 4.6 모델 추가/교체

```bash
# 새 코드 모델 설치
ollama pull qwen2.5-coder:32b

# 팀 기본 라우팅 변경: config/tokenlift.config.json 의 routing.byTask 수정
# 개인만 적용: ~/.tokenlift/config.json 에 동일 키만 오버라이드
# 일회성: tokenlift gen "..." -m qwen2.5-coder:32b
```

## 4.7 온프렘 GPU 클러스터 모델 (H200 / V100, Ollama 특화 모델)

H200×8 / V100×8 하드웨어 위에서 **Ollama 에 여러 특화 모델을 올려 task별로 라우팅**한다
(`config.providers.onprem-h200|onprem-v100.routing`). 모델은 **Ollama 태그**.

| 역할 | 클러스터 | 코드 | 추론 | FIM | 문서/경량 |
|---|---|---|---|---|---|
| oracle | H200 | `qwen2.5-coder:32b` | `deepseek-r1:70b` | `qwen2.5-coder:7b` | `llama3.3:70b` |
| coder | V100 | `qwen2.5-coder:14b` | `deepseek-r1:14b` | `qwen2.5-coder:1.5b-base` | `llama3.1:8b` |

```bash
tokenlift models --provider onprem-h200          # 클러스터 보유 태그 확인
tokenlift gen "..." --role coder                 # = onprem-v100(폴백 체인)
tokenlift gen "..." --provider onprem-h200 -m deepseek-r1:70b
```

> 큰/고정밀 모델은 H200, 중소·양자화(GGUF Q4/Q5) 모델은 V100. 태그는 **예시**이니 클러스터에
> 실제 pull 한 모델로 교체. NemoClaw/NIM 으로 서빙하면 모델명은 NIM 카탈로그 ID 형식이 된다
> (`config.providers.nemoclaw`). 역할·폴백·비용은 [13. 멀티모델 에이전트](13-multi-model-agents.md).

설치/구성 절차는 [08. 설치/설정](08-installation.md) 참조.
