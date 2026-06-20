# 08. 설치 / 설정

## 8.1 사전 요구사항

| 항목 | 버전 | 확인 | 용도 |
|---|---|---|---|
| Node.js | 18+ | `node --version` | CLI 런타임 |
| 사내 Ollama 서버 | 0.6+ | `curl http://<서버>:11434/api/tags` | 생성 위임(H200/V100) |
| 코드 모델 | 다수 | `tokenlift models --provider onprem-v100` | 생성 모델(최신 오픈) |
| codebase-memory-mcp | 최신 | 도구 가용성 | **탐색 위임(그래프)·권장** |

### Ollama 준비 (생성 위임) — 사내 H200/V100 서버

> Ollama 는 **사내 H200/V100 서버**에서 구동되며 최신 오픈 모델이 다수 pull 되어 있다고
> 가정한다(로컬 PC 에 설치할 필요 없음). 서버 운영자가 모델을 적재한다.

```bash
# (서버 운영자) 각 서버에 특화 모델 pull (예시)
ssh h200   ollama pull qwen2.5-coder:32b && ollama pull deepseek-r1:70b && ollama pull devstral:24b
ssh v100   ollama pull qwen2.5-coder:14b && ollama pull qwen2.5-coder:1.5b-base && ollama pull qwen3:8b

# (사용자) config 의 onprem-h200 / onprem-v100 host 를 사내 서버 주소로 설정
#   ~/.tokenlift/config.json → providers.onprem-v100.host = "http://v100.internal:11434" 등
```

> (선택) 로컬 PC 에 Ollama 가 있다면 개발용으로 `--provider ollama` 사용 가능하나, 기본 위임은
> 사내 서버(onprem-v100/h200)다.

### codebase-memory-mcp 준비 (탐색 위임 · 권장)

코드 탐색을 지식 그래프로 처리해 입력 토큰을 ~99% 절감하는 **별도 MCP 서버**. 설치 시
Claude Code 가 자동 구성된다(MCP 항목·스킬·Grep/Glob 보강 훅). 없어도 TokenLift 는 동작하며
탐색만 평소대로(Read/Grep) 처리한다.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

# Windows (PowerShell) — 다운로드 후 검토하고 실행
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1
.\install.ps1
```
설치 후 Claude Code 재시작 → "이 프로젝트 인덱싱해줘" 한 번. 자동 인덱싱:
`codebase-memory-mcp config set auto_index true`. 자세히 → [12. 코드 탐색 위임](12-codebase-memory.md).

## 8.2 자동 설치 (권장)

저장소 루트(`TokenLift/`)에서:

### Windows (PowerShell)
```powershell
./scripts/install.ps1
```

### macOS / Linux
```bash
bash scripts/install.sh
```

설치 스크립트가 수행하는 일:
1. `npm link` 로 `tokenlift` 전역 명령 등록(가능 시).
2. 스킬을 `~/.claude/skills/tokenlift/` 로 복사.
3. 서브에이전트를 `~/.claude/agents/ollama-delegate.md` 로 복사.
4. `tokenlift doctor` 로 환경 점검.
5. (안내) 자동 감지 훅 등록 방법 출력.

> 스크립트는 기존 파일을 덮어쓰기 전 `~/.claude/.tokenlift-backup/` 에 백업을 남긴다.
> (백업을 `skills/` 안에 두면 그 안의 `SKILL.md` 때문에 중복 스킬로 인식되므로 스캔 범위 밖에 둔다.)

## 8.3 수동 설치

### (1) CLI 전역 명령
```bash
cd TokenLift
npm link          # 또는: npm install -g .
tokenlift doctor
```
`npm link` 가 막히면 직접 실행 경로를 사용한다:
```bash
node "<설치경로>/TokenLift/bin/tokenlift.mjs" doctor
# 편의를 위해 TOKENLIFT_HOME 환경변수 설정 권장
```

### (2) Claude Code 스킬 배포
스킬 폴더를 사용자 스킬 디렉토리로 복사:
```
복사:  TokenLift/skills/tokenlift/   →   ~/.claude/skills/tokenlift/
```
- Windows: `C:\Users\<이름>\.claude\skills\tokenlift\`
- macOS/Linux: `~/.claude/skills/tokenlift/`

`SKILL.md` 와 `reference/` 가 함께 있어야 한다.

### (3) 서브에이전트 배포
```
복사:  TokenLift/agents/ollama-delegate.md   →   ~/.claude/agents/ollama-delegate.md
```

## 8.4 자동 감지 훅 등록 (선택)

프롬프트를 분석해 위임 힌트를 주입하는 훅이다. **선택 기능**이며 사용자 `settings.json` 을
수정한다.

`~/.claude/settings.json` (또는 프로젝트 `.claude/settings.json`)의 `hooks` 에 추가:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"X:/Work_TokenLift/TokenLift/hooks/suggest-delegation.mjs\""
          }
        ]
      }
    ]
  }
}
```

> 경로는 실제 설치 경로로 바꿔라(Windows 는 `/` 또는 `\\`). 훅은 LLM 을 호출하지 않아 즉시
> 실행되며, 어떤 경우에도 프롬프트를 차단하지 않는다(실패 시 조용히 통과).

훅이 과하다고 느끼면 등록하지 않아도 된다 — 스킬만으로 위임은 충분히 동작한다.

## 8.5 개인 설정 (선택)

팀 기본값을 개인적으로 덮어쓰려면 `~/.tokenlift/config.json` 생성:

```jsonc
{
  "ollama": { "host": "http://내부-ollama:11434" },
  "routing": { "byTask": { "gen": "devstral:24b" } },
  "pricing": { "label": "opus", "inputPer1M": 15, "outputPer1M": 75 }
}
```

지정한 키만 병합되며 나머지는 팀 기본값이 유지된다.

## 8.6 사내(원격) Ollama 사용

로컬이 아닌 사내 GPU 서버의 Ollama 를 쓰려면:
```bash
export OLLAMA_HOST=http://ollama.internal:11434   # bash
$env:OLLAMA_HOST="http://ollama.internal:11434"   # PowerShell
# 또는 호출마다: tokenlift gen "..." --host http://ollama.internal:11434
# 또는 config 의 ollama.host 수정
```

## 8.6b 온프렘 NemoClaw / NIM 설정 (OpenAI 호환)

사내 NVIDIA NemoClaw/NIM 등 OpenAI 호환 백엔드로 위임하려면:

1. `~/.tokenlift/config.json`(개인) 또는 패키지 config 의 `providers.nemoclaw` 를 수정:
   ```jsonc
   {
     "providers": {
       "nemoclaw": {
         "type": "openai-compat",
         "host": "http://nim.internal.company:8000",
         "apiPath": "/v1",
         "apiKeyEnv": "NEMOCLAW_API_KEY",
         "routing": { "default": "qwen/qwen2.5-coder-32b-instruct" }
       }
     }
   }
   ```
2. 인증이 필요하면 API 키를 환경변수로:
   ```bash
   export NEMOCLAW_API_KEY="nvapi-..."        # bash
   $env:NEMOCLAW_API_KEY="nvapi-..."           # PowerShell
   ```
3. 점검·사용:
   ```bash
   tokenlift doctor --provider nemoclaw
   tokenlift models --provider nemoclaw        # 실제 배포 모델명 확인
   tokenlift gen "..." --provider nemoclaw
   ```
4. 기본 백엔드로 고정하려면 config 의 `"provider": "nemoclaw"` 또는
   `export TOKENLIFT_PROVIDER=nemoclaw`.

자세한 내용은 [11. 백엔드 확장](11-providers.md).

## 8.6c 온프렘 GPU 클러스터 (H200 oracle / V100 coder)

**H200×8 / V100×8 은 하드웨어**다. 그 위에서 **Ollama(여러 특화 모델)** 또는 **NemoClaw/NIM**
을 서빙한다. 기본 설정은 `type:'ollama'` — 클러스터 Ollama 주소와 pull 한 태그로 교체.

```bash
# (클러스터에서) 특화 모델 적재 예
ssh h200  ollama pull qwen2.5-coder:32b && ollama pull deepseek-r1:70b
ssh v100  ollama pull qwen2.5-coder:14b && ollama pull qwen2.5-coder:1.5b-base

# (개인 config) providers.onprem-h200|onprem-v100 의 host 를 클러스터 주소로 교체
tokenlift doctor   --provider onprem-v100   # 연결·모델 점검
tokenlift models   --provider onprem-h200   # 보유 태그 확인
tokenlift roles                             # 역할→폴백 체인, 에스컬레이션 사다리
tokenlift route "이 서비스 테스트 일괄 작성"   # 역할/티어/폴백 추천

# 역할로 위임(체인 자동 강등 포함):
tokenlift test -f src/a.ts -o src/a.test.ts --role coder   # V100→(실패시)로컬→H200
tokenlift gen  "동시성 큐 알고리즘 구현"        --role oracle  # H200→V100→(최후)Claude
```

NemoClaw/NIM 으로 서빙한다면 해당 provider 를 `type:'openai-compat'` + `apiPath` +
`apiKeyEnv: ONPREM_API_KEY` 로 바꾼다. GPU·모델 선택·폴백 체인·비용은
[13. 멀티모델 에이전트](13-multi-model-agents.md).

## 8.7 설치 검증

```bash
tokenlift doctor    # Node/설정/백엔드 연결/필수 모델 모두 ✅ 여야 함
tokenlift providers # 설정된 백엔드 목록/활성 확인
tokenlift models    # 라우팅 매핑이 가용 모델과 일치하는지
tokenlift gen "hello world 출력 함수" --lang python   # 실제 생성 1회
```

Claude Code 쪽 검증: 새 세션에서 "이 파일 테스트를 Ollama로 작성해줘" 요청 시
`tokenlift` 스킬이 발동하면 정상.

## 8.8 제거

```bash
npm uninstall -g tokenlift           # 전역 명령 제거(또는 npm unlink)
rm -rf ~/.claude/skills/tokenlift    # 스킬 제거
rm ~/.claude/agents/ollama-delegate.md
# settings.json 에서 훅 항목 제거(등록했다면)
rm -rf ~/.tokenlift                  # 로그/개인설정 제거(원하면)
```
