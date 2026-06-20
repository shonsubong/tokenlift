# 09. 트러블슈팅

먼저 `tokenlift doctor` 를 실행하라. 대부분의 환경 문제를 한 번에 진단한다.

## 9.1 연결 / 실행

### "Ollama 서버에 연결할 수 없습니다"
- Ollama 는 **사내 H200/V100 서버**에서 구동된다(로컬 PC 아님). 서버가 떠 있는지 확인.
- 호스트 확인: `config.providers.onprem-h200|onprem-v100.host` 가 사내 주소인지. 일회성은 `--host`.
- 방화벽/포트: `curl http://<사내서버>:11434/api/tags` 가 응답하는지 확인.
- 한 서버가 다운이면 역할 체인이 자동 강등한다(예: `--role oracle` 은 H200→V100→Claude).
  모든 백엔드 불가 시 Claude 가 직접 처리한다.
- (로컬 개발용 Ollama 를 쓸 때만) `ollama serve` + `--provider ollama`.

### 첫 호출이 매우 느림 (수십 초)
- **정상이다.** 9~14GB 모델의 콜드 로드(메모리 적재) 때문이다.
- 연속 위임 전 `tokenlift warmup -m <model>` 로 미리 적재하라.
- 두 번째 호출부터는 빨라진다(keep_alive 동안 상주).

### "요청 타임아웃(...ms)"
- 대형 모델 + 긴 출력이면 기본 타임아웃을 늘려라:
  `tokenlift gen "..." --timeout 1200000` 또는 `config.ollama.timeoutMs`.
- 시스템 RAM/VRAM 부족으로 CPU fallback 시 느려진다(아래 9.3).

## 9.2 명령 / 입출력

### `tokenlift: command not found`
- `npm link` 가 안 됐거나 PATH 문제. 대안: `node "<경로>/bin/tokenlift.mjs" ...`.
- 전역 bin 경로 확인: `npm bin -g` / `npm root -g`.

### 명령이 멈춘 채 끝나지 않음(hang)
- 과거 버그(비대화형 셸에서 stdin 무한 대기)는 수정됨(`util.readStdin` 유예 타임아웃).
- 그래도 멈추면: 입력을 위치인자로 명시(`tokenlift gen "지시..."`)하거나 파이프를
  명확히 닫아라(`echo "..." | tokenlift ...`).

### 출력에 코드 외 설명/잡담이 섞임
- CLI 가 코드펜스만 추출하지만, 모델이 펜스 없이 섞어 내면 남을 수 있다.
- `--temp 0` 으로 낮추거나, 더 강한 코드 모델(`qwen2.5-coder:14b`)로 `-m` 지정.
- 최종적으로 Claude 가 정리하면 된다(검토 단계의 정상 범위).

### `<think>` 같은 추론 블록이 보임
- r1/qwq 계열 특성. CLI 가 자동 제거하지만 변형 태그는 남을 수 있다.
- 코드 작업엔 추론 모델 대신 코드 모델(`qwen2.5-coder`)을 쓰는 게 낫다.

## 9.3 성능 / 자원

### 모델이 느리고 GPU 를 못 쓰는 듯함
- RAM/VRAM 초과 시 Ollama 가 일부를 CPU 로 내린다.
- 동시에 큰 모델 여러 개를 올리지 말 것. 한 번에 하나의 코드 모델로 묶어 사용.
- 더 작은 모델로 라우팅(예: `gemma3:12b`→`gemma3:4b`)하거나 양자화 낮은 모델 사용.

### 모델 교체 때마다 느려짐
- 모델 전환 = 재적재. 한 세션에선 단일 모델로 통일하라(`config.routing` 또는 `-m`).

## 9.4 라우팅 / 위임 판단

### 위임해야 할 작업을 Claude 가 직접 함 (또는 반대)
- `tokenlift route "<설명>"` 로 추천을 확인.
- 키워드 휴리스틱이라 한계가 있다. 요청에 의도를 명시("Ollama로", "토큰 아끼게")하면 확실.
- 팀 임계값/키워드는 `config.thresholds` 와 `src/router.mjs` 에서 조정 가능.

### 보안 코드가 위임됨
- SKILL.md 규칙상 보안/인증/결제는 Claude 가 재검토하도록 되어 있다. 그래도 우려되면
  해당 작업은 명시적으로 "직접 처리"를 요청하라.

## 9.5 Claude Code 스킬/훅

### 스킬이 발동하지 않음
- `~/.claude/skills/tokenlift/SKILL.md` 존재 확인.
- 새 세션에서 재시도(스킬 목록은 세션 시작 시 로드).
- 요청에 위임 의도 키워드를 포함해 트리거 가능성을 높여라.

### 훅이 동작/미동작
- `settings.json` 의 `command` 경로가 정확한지(절대경로, OS 경로 구분자) 확인.
- 수동 테스트: `echo '{"prompt":"테스트 코드 작성"}' | node hooks/suggest-delegation.mjs`
  → JSON 힌트가 출력되어야 함.
- 훅은 실패해도 조용히 통과하도록 설계됨(작업 비방해).

## 9.6 로그 / 통계

### `stats` 가 "기록 없음"
- 로깅 비활성화 여부 확인(`config.logging.enabled`, `TOKENLIFT_NO_LOG`).
- 로그 경로 확인: `~/.tokenlift/usage.jsonl`. 쓰기 권한 점검.

## 9.7 그래도 안 되면
- `tokenlift doctor` 출력 전체와 `node --version`, `ollama --version`, `ollama list`
  결과를 첨부해 이슈를 남겨라.
- 임시 회피: Ollama 가 불안정하면 해당 작업은 Claude 가 직접 처리하도록 요청(가용성 우선).
