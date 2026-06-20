# 10. FAQ

### Q. codebase-memory-mcp(지식 그래프)는 위임과 무슨 관계인가요?
TokenLift 절감의 **첫 번째 기둥**이다. 코드 "생성"이 출력 토큰을 쓴다면, 코드 "탐색/이해"는
파일을 반복해서 읽느라 **입력 토큰**을 크게 쓴다. codebase-memory-mcp 는 코드베이스를 지식
그래프로 인덱싱해, 파일 통독 대신 구조 쿼리(`get_architecture`/`search_graph`/`trace_path`/
`get_code_snippet`)로 답을 준다 — 5개 쿼리 ≈ 3,400 토큰 vs 파일별 탐색 ≈ 412,000 토큰(약 99%↓).
스킬이 이를 **기본 탐색 수단**으로 쓰도록 지시한다. → [12. 코드 탐색 위임](12-codebase-memory.md)

### Q. codebase-memory-mcp 를 꼭 설치해야 하나요?
**권장**이지만 필수는 아니다. 없으면 탐색 기둥만 생략되고 평소대로 Read/Grep 으로 동작한다
(생성 위임은 그대로). 설치하면 탐색 토큰이 크게 줄어든다. 단일 바이너리·로컬 처리(코드 무유출).

### Q. 그래프 인덱스는 코드가 바뀌면 어떻게 되나요?
백그라운드 워처가 git 변경을 감지해 자동 재인덱싱한다. 큰 변경 후 결과가 이상하면
`index_status` 확인 또는 재인덱싱(`index_repository`). 팀 공유는 `persistence` 아티팩트 사용.

### Q. 서브에이전트도 Claude 를 쓰는데 어떻게 토큰이 절감되나요?
핵심은 **실제 코드 생성을 사내 온프렘 Ollama 서버가 한다**는 점이다. TokenLift는 서브에이전트만으로
끝내지 않고, 무거운 생성을 `tokenlift` CLI(→Ollama)로 셸아웃한다. 그래서 가장 비싼
**출력 토큰**이 Bedrock 이 아니라 로컬에서 소비된다. 서브에이전트는 그 위임을 메인 컨텍스트와
격리해 실행하는 "운반책" 역할이며, 직접 코드를 길게 쓰지 않도록 지시되어 있다.

### Q. 그냥 Ollama 만 쓰면 더 싸지 않나요?
로컬 모델은 Claude 보다 **약하다.** 아키텍처 설계, 보안 판단, 복잡한 디버깅, 모호한 요구
해석에서 품질·정확성이 떨어진다. TokenLift의 목적은 **역할 분담**이다 — 똑똑함이 필요한 곳은
Claude, 양이 많고 기계적인 곳은 Ollama. 그래서 품질을 지키면서 비용을 줄인다.

### Q. 위임 결과를 믿어도 되나요?
아니요. **항상 Claude 가 검토**해야 한다. 특히 보안/인증/결제/데이터 무결성 코드는 필수
재검토 대상이다. SKILL.md 와 서브에이전트 프롬프트가 이를 강제한다.

### Q. 절감액(`stats`)은 얼마나 정확한가요?
**gross 추정치**다. "로컬로 옮긴 토큰을 Bedrock 단가로 환산한 규모"를 보여준다. 실제
순절감은 Claude 의 결과 재읽기/검토 비용 때문에 그보다 작다. 출력 단가가 입력의 ~5배라
**생성 위임은 여전히 크게 이득**이다. 자세한 계산은 [07. 비용 분석](07-cost-analysis.md).

### Q. 사내 Bedrock 단가가 예시와 달라요.
`config.pricing.inputPer1M`/`outputPer1M` 을 **사내 실단가로 바꿔라.** 문서의 $3/$15(Sonnet),
$15/$75(Opus)는 예시 가정치이며 실제 청구액이 아니다.

### Q. 어떤 모델을 기본으로 써야 하나요?
대부분의 코딩 위임은 `qwen2.5-coder:14b` 가 무난하다. 멀티파일·에이전트형 복잡 생성은
`devstral:24b`. 자세한 표는 [04. 모델 가이드](04-model-guide.md).

### Q. 첫 호출이 너무 느려요.
모델 콜드 로드(메모리 적재) 때문이다. `tokenlift warmup -m <model>` 로 미리 적재하고,
한 세션에선 같은 모델로 묶어 쓰면 재적재가 없어 빠르다.

### Q. 사내 Ollama 서버가 꺼져 있으면 어떻게 되나요?
역할 폴백 체인이 다음 백엔드로 자동 강등한다(예: oracle 은 H200→V100→Claude). 모든 백엔드가
불가하면 `tokenlift` 가 친절한 오류를 반환하고 Claude 가 직접 처리하거나 사용자에게 사내 서버
점검을 요청한다. **가용성이 우선**이므로 작업이 막히지 않는다.

### Q. 원격(사내 GPU) Ollama 를 쓸 수 있나요?
예. `OLLAMA_HOST` 환경변수, `--host` 플래그, 또는 `config.ollama.host` 로 지정한다.

### Q. 자동 감지 훅은 꼭 등록해야 하나요?
아니요, **선택**이다. 훅 없이도 스킬이 위임을 수행한다. 훅은 프롬프트를 보고 "위임을
고려하라"는 힌트를 주입할 뿐, 실행을 강제하지 않는다.

### Q. 위임이 항상 이득인가요?
아니요. 5줄짜리 사소한 수정은 위임 왕복 지연이 절감보다 클 수 있다. 임계값(생성 30줄+,
파일 300줄+, 3파일+)을 넘는 **대량/반복 작업**에서 이득이 크다.

### Q. 온프렘 NVIDIA NemoClaw / NIM 으로도 위임할 수 있나요?
예. NemoClaw/NIM 은 OpenAI 호환(`/v1/chat/completions`)이므로 `openai-compat` 어댑터로
지원한다. `config.providers.nemoclaw.host` 를 사내 엔드포인트로, 모델명을 실제 배포 ID로
설정하고 `--provider nemoclaw`(또는 `TOKENLIFT_PROVIDER=nemoclaw`)로 사용한다. 인증은
`NEMOCLAW_API_KEY` 환경변수의 Bearer 키를 쓴다. → [11. 백엔드 확장](11-providers.md)

### Q. Ollama 와 NemoClaw 를 같이 쓸 수 있나요?
예. 백엔드는 `--provider` 로 호출마다 고를 수 있다. 가벼운 작업은 로컬 Ollama, 대형 모델이
필요한 작업은 사내 NIM 으로 나눠 위임하는 하이브리드 운영이 가능하다. `tokenlift stats` 는
백엔드별로 절감을 집계한다.

### Q. 다른 LLM 런타임(vLLM, TGI, LM Studio 등)도 되나요?
대부분 OpenAI 호환이므로 `config.providers.<name>` 에 `type: "openai-compat"` 로 추가만 하면
된다. 코드 수정 불필요. OpenAI 비호환(예: Triton)은 `src/providers/` 에 어댑터 모듈을 추가하고
`providers/index.mjs` 에 타입을 등록한다(통합 인터페이스만 구현).

### Q. 외부 npm 패키지를 설치하나요?
아니요. Node 18+ 내장 기능만 사용한다(의존성 0). 공급망 위험과 설치 마찰이 없다.

### Q. 코드/요약 외에 일반 질문도 위임할 수 있나요?
`tokenlift ask "..."` 로 임의 프롬프트를 로컬 모델에 보낼 수 있다. 단, 정확성이 중요한
질문은 Claude 가 낫다.

### Q. Windows 에서도 동작하나요?
예. 개발/검증 환경이 Windows 다. 경로는 OS 에 맞게 처리되며, 설치는 `scripts/install.ps1`
(PowerShell) 또는 `scripts/install.sh`(bash) 를 사용한다.

### Q. 회사 보안 정책상 로컬에 코드를 두기 곤란하면?
TokenLift는 **사내 네트워크 내 Ollama 호스트**를 가리킬 수 있어, 코드가 외부로 나가지 않는다
(외부 API 미사용). 오히려 외부 클라우드 LLM 노출을 줄이는 방향으로 쓸 수 있다.
