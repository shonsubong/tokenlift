// config.mjs - 설정 로딩 및 병합
// 우선순위(낮음→높음): 내장 기본값 < 패키지 config < 사용자(~/.tokenlift/config.json) < 환경변수
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, expandHome } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_CONFIG = path.join(__dirname, '..', 'config', 'tokenlift.config.json');
const USER_CONFIG = expandHome('~/.tokenlift/config.json');

const DEFAULTS = {
  // 활성 백엔드. Ollama 는 사내 H200/V100 서버에서 구동된다(로컬 PC 아님).
  // 기본 위임 대상은 최저가 사내 서버(onprem-v100). --provider/--role 로 일회성 변경.
  provider: 'onprem-v100',
  // (선택) 로컬 개발용 Ollama. 사내 기본 백엔드는 providers.onprem-v100 / onprem-h200 이다.
  // 로컬에 Ollama 가 없으면 이 provider 는 쓰지 않는다(기본 체인에서 제외됨).
  ollama: { host: 'http://localhost:11434', timeoutMs: 600000, keepAlive: '30m', numCtx: 8192 },
  // 사내 온프렘 백엔드. 'ollama'(로컬) 외 provider 는 여기에 정의한다.
  providers: {
    // NVIDIA NemoClaw / NIM (OpenAI 호환). 사내 엔드포인트/모델명/키로 교체할 것.
    nemoclaw: {
      type: 'openai-compat',
      host: 'http://localhost:8000', // NIM 기본 포트. 사내 게이트웨이 주소로 변경
      apiPath: '/v1',
      apiKeyEnv: 'NEMOCLAW_API_KEY', // 이 환경변수에서 Bearer 키를 읽음(없으면 무인증)
      supportsFIM: false, // /v1/completions(FIM) 지원 시 true
      models: [], // /v1/models 미지원 게이트웨이면 여기에 모델명 나열
      routing: {
        // NIM 카탈로그 모델명 예시. 실제 배포된 모델명으로 교체 필수.
        default: 'qwen/qwen2.5-coder-32b-instruct',
        byTask: {
          gen: 'qwen/qwen2.5-coder-32b-instruct',
          edit: 'qwen/qwen2.5-coder-32b-instruct',
          test: 'qwen/qwen2.5-coder-32b-instruct',
          refactor: 'qwen/qwen2.5-coder-32b-instruct',
          translate: 'qwen/qwen2.5-coder-32b-instruct',
          explain: 'meta/llama-3.1-8b-instruct',
          review: 'qwen/qwen2.5-coder-32b-instruct',
          agent: 'nvidia/llama-3.1-nemotron-70b-instruct',
          reason: 'nvidia/llama-3.1-nemotron-70b-instruct',
          docs: 'meta/llama-3.1-8b-instruct',
          fast: 'meta/llama-3.1-8b-instruct',
        },
      },
    },
    // ── 사내 온프렘 Ollama 서버 (로컬 PC 아님) ──
    // H200×8 / V100×8 서버에 Ollama 가 떠 있고 최신 오픈 모델이 다수 pull 되어 있다고 가정.
    // 기본은 type:'ollama'(여러 특화 모델을 task별 매핑, FIM·keep_alive·warmup 네이티브).
    // 같은 서버를 NemoClaw/NIM/vLLM 로 서빙한다면 type:'openai-compat' + apiPath + apiKeyEnv 로 교체.
    //
    // H200 서버 (고속/대용량): Oracle 역할 — 어려운 추론·대형 생성. 큰 최신 오픈 모델 적재.
    'onprem-h200': {
      type: 'ollama',
      host: 'http://h200.internal:11434', // 사내 H200 Ollama 주소로 교체
      keepAlive: '30m',
      numCtx: 16384,
      routing: {
        // 최신 오픈 모델 Ollama 태그 예시 — 서버에 pull 된 실제 태그로 교체.
        default: 'qwen2.5-coder:32b',
        byTask: {
          reason: 'deepseek-r1:70b', // 추론 특화
          agent: 'devstral:24b', // 에이전트형 멀티파일
          gen: 'qwen2.5-coder:32b',
          edit: 'qwen2.5-coder:32b',
          test: 'qwen2.5-coder:32b',
          refactor: 'qwen3:32b',
          translate: 'qwen2.5-coder:32b',
          review: 'deepseek-r1:70b',
          explain: 'qwen3:32b',
          docs: 'llama3.3:70b',
          complete: 'qwen2.5-coder:7b', // FIM
        },
      },
    },
    // ── GLM-5.2 (frontier 오픈 모델, 744B MoE / 40B 활성) — NVIDIA 공식 양자화 우선 ──
    // 우선 경로: NVIDIA 공식 NVFP4(nvidia/GLM-5.2-NVFP4)를 vLLM 으로 서빙(OpenAI 호환 /v1).
    //   scripts/run-glm-vllm.sh 로 구동. vLLM 연속 배칭 → 멀티유저 동시성 우수(사내 공유 서빙).
    // ⚠️ 하드웨어: NVFP4 는 Blackwell(B200/B300/GB200) 전용이라 H200(Hopper)에서는 실행 불가.
    //    H200 이면 default 를 'glm-5.2-fp8'(Z.ai 공식 FP8, Hopper 네이티브)로 바꾸세요.
    // 대안 경로(저VRAM/CPU offload): Unsloth GGUF + llama.cpp(scripts/run-glm-fleet.sh) → docs/16.
    // Oracle 역할의 1순위(프런티어). 권장 샘플링은 provider.sampling 으로 중앙 관리.
    'onprem-glm': {
      type: 'openai-compat',
      host: 'http://h200.internal:8000', // vLLM 엔드포인트(기본 포트 8000)로 교체
      apiPath: '/v1',
      apiKeyEnv: 'ONPREM_API_KEY', // 멀티유저: 각 사용자가 발급받은 Bearer 토큰(에어갭이면 무인증)
      supportsFIM: false, // GLM 은 FIM(complete) 대상 아님 → gen/edit 사용
      timeoutMs: 1800000, // 대형 모델 콜드 로드/장문 추론 대비(30분). NemoClaw #2403(타임아웃 미반영) 주의
      // 서빙 중인 모델(= vLLM --served-model-name). NVIDIA 공식 NVFP4 우선, H200 은 FP8.
      models: ['glm-5.2-nvfp4', 'glm-5.2-fp8'],
      sampling: { temperature: 1.0, top_p: 0.95, top_k: 40, min_p: 0.0 },
      // 비표준 요청 필드가 필요하면 여기에. 예: { "chat_template_kwargs": { "enable_thinking": false } }
      // extraBody: {},
      routing: {
        // vLLM 은 단일 모델이 높은 동시성으로 모든 task 를 처리 → task 별 tier 불필요.
        // default 만 바꾸면 HW 전환(Blackwell=nvfp4 / H200=fp8). -m 으로 호출별 강제도 가능.
        default: 'glm-5.2-nvfp4',
      },
    },
    // V100 서버 (대량 처리): Coder 역할 — 대량·정형 생성(최저가). 중소·양자화(GGUF) 최신 모델.
    'onprem-v100': {
      type: 'ollama',
      host: 'http://v100.internal:11434', // 사내 V100 Ollama 주소로 교체
      keepAlive: '30m',
      numCtx: 8192,
      routing: {
        // GGUF(Q4/Q5) 양자화는 Volta(V100)에서도 동작. 중소 최신 특화 모델 위주.
        default: 'qwen2.5-coder:14b',
        byTask: {
          gen: 'qwen2.5-coder:14b',
          edit: 'qwen2.5-coder:14b',
          test: 'qwen2.5-coder:14b',
          refactor: 'qwen2.5-coder:14b',
          translate: 'qwen2.5-coder:14b',
          reason: 'deepseek-r1:14b',
          review: 'qwen2.5-coder:14b',
          explain: 'qwen3:8b',
          docs: 'llama3.1:8b',
          fast: 'gemma3:12b',
          complete: 'qwen2.5-coder:1.5b-base', // FIM
        },
      },
    },
  },
  // ── 에이전트 역할 → 폴백 체인 (oh-my-openagent 의 fallbackChain 반영) ──
  // 각 역할에 작업 "스타일"에 맞는 백엔드를 우선순위(싼/적합 → 폴백)로 나열한다. 런타임에
  // 앞에서부터 "호출 가능(설정됨)·도달 가능"한 첫 백엔드를 쓰고, 실패하면 다음으로 자동 강등한다.
  // 'claude'(=Bedrock, 에이전트 자신)·'codebase-memory-mcp'(=그래프 MCP)는 위임 대상이 아닌
  // 종단 라벨(= "직접 처리"). chain 항목은 provider 이름(문자열) 또는 {provider, model}.
  roles: {
    lead: { style: 'orchestration(mechanics)', chain: ['claude'], desc: '오케스트레이션·계획·위임·통합 (Claude Code 자신)' },
    explorer: { style: 'retrieval', chain: ['codebase-memory-mcp'], desc: '코드 탐색/검색/영향분석 (그래프, 무료)' },
    // 실행자(executor): 개발의 대부분(생성·수정·테스트·리팩터·이식·리뷰 초안). 사내 GLM-5.2
    // (NIM, 무제한·기밀 안전) 우선. OmO 의 Hephaestus(실행 담당)에 대응.
    executor: { style: 'development-executor', chain: ['onprem-glm', 'onprem-h200', 'onprem-v100'], desc: '실행자 — 개발 대부분·기밀 포함 (GLM-5.2→H200→V100, 사내 전용)' },
    coder: { style: 'bulk-code', chain: ['onprem-v100', 'onprem-h200'], desc: '경량·정형 생성 (V100→H200)' },
    oracle: { style: 'deep-reasoning', chain: ['onprem-glm', 'onprem-h200', 'onprem-v100', 'claude'], desc: '어려운 추론·대형 생성 (GLM-5.2→H200→V100→Bedrock)' },
    // 조언자(advisor): 기밀 없는 내용의 고난도 판단·설계 조언·최종 검토. Bedrock $200/월
    // 예산을 아껴 쓰는 대상. OmO 의 Prometheus/Metis(계획·자문)에 대응.
    advisor: { style: 'high-IQ-advice', chain: ['claude'], desc: '조언자 — 비민감 고난도 판단·설계 조언 (Bedrock, 예산 관리 대상)' },
    reviewer: { style: 'judgment', chain: ['claude'], desc: '보안·최종 검토·의사결정 (Bedrock, 기밀은 제거 후)' },
  },
  // 비용 최소화 에스컬레이션 사다리: 싼 것 → 비싼 것. 충분한 가장 싼 단계를 먼저 쓴다.
  // onprem-glm(GLM-5.2)은 가장 강력하지만 가장 무거운 온프렘 단계 → Bedrock 직전.
  escalation: ['codebase-memory-mcp', 'onprem-v100', 'onprem-h200', 'onprem-glm', 'claude'],
  routing: {
    default: 'qwen2.5-coder:14b',
    byTask: {
      gen: 'qwen2.5-coder:14b',
      edit: 'qwen2.5-coder:14b',
      test: 'qwen2.5-coder:14b',
      refactor: 'qwen2.5-coder:14b',
      translate: 'qwen2.5-coder:14b',
      explain: 'qwen2.5-coder:14b',
      review: 'deepcoder:latest',
      agent: 'devstral:24b',
      reason: 'deepseek-r1:14b',
      docs: 'gemma3:12b',
      fast: 'gemma3:4b',
      complete: 'qwen2.5-coder:1.5b-base',
    },
    fallback: 'gemma3:4b',
  },
  // monthlyBudgetUsd: 한 달 Bedrock(Claude) 목표 예산. stats 가 이번 달 위임 절감액과 함께
  // 예산 대비 지표를 보여준다(실제 Bedrock 소비는 Claude Code 의 /cost 로 확인).
  pricing: { label: 'claude-sonnet-on-bedrock', inputPer1M: 3.0, outputPer1M: 15.0, monthlyBudgetUsd: 200 },
  thresholds: { delegateMinOutputLines: 30, delegateMinFileLines: 300, delegateMinFiles: 3 },
  generation: { temperature: 0.1, topP: 0.9 },
  logging: { enabled: true, file: '~/.tokenlift/usage.jsonl' },
  // ── NemoClaw 보안 게이트웨이 자동 적용 (tokenlift secure) ──
  // Windows(WSL2) PC 의 Claude Code(Bedrock) 트래픽을 NemoClaw 게이트웨이로 우회시켜
  // PII redaction/정책 필터를 강제하고, 온프렘 LLM 은 직결(예외), 민감 폴더는 접근 차단한다.
  // 'tokenlift secure init' 이 아래 값으로 Claude Code settings.json 을 안전 병합한다.
  security: {
    enabled: true,
    claudeSettingsPath: '~/.claude/settings.json', // 적용 대상(개인). 팀 공유면 .claude/settings.json
    gateway: {
      url: 'http://localhost:8080', // NemoClaw 게이트웨이 주소(온보딩 시 출력값으로 교체)
      authTokenEnv: 'NEMOCLAW_GATEWAY_TOKEN',
    },
    bedrock: {
      region: 'us-east-1',
      runtimeHost: 'bedrock-runtime.us-east-1.amazonaws.com',
      useMantle: false, // Anthropic API 형태의 Mantle 엔드포인트를 쓰면 true
    },
    // 게이트웨이/필터를 우회(직결)할 신뢰 호스트 = 보안 예외. 온프렘 provider 의 host 와 일치시킬 것.
    exemptHosts: ['h200.internal', 'v100.internal', 'localhost', '127.0.0.1'],
    // 유출 차단할 민감 경로/글롭. Claude Code 가 아예 못 읽게 한다(유출 원천 차단).
    // ⚠️ 실제 사내 민감 폴더(예: /mnt/c/Users/<you>/Sensitive)를 추가하세요.
    sensitivePaths: ['~/.aws/**', '~/.ssh/**', '**/.env', '**/*.pem', '**/*.key', '**/secrets/**'],
    allowReadRoots: [], // (선택) OS 샌드박스 읽기 허용 루트. 비면 sandbox 미설정.
    // 내용 기반 기밀 신호(라우팅용). 이 신호가 감지되면 tokenlift route 가 외부(Bedrock) 전송을
    // 금지하고 사내 GLM-5.2 로 강제한다. 문자열(포함 검사) 또는 "/정규식/i" 형식.
    // 내장 패턴(개인키/시크릿/AWS·NGC 키/.internal/주민번호/기밀 키워드)에 "추가"된다.
    sensitivePatterns: [],
  },
};

/** 깊은 병합 (객체만 재귀, 배열/원시값은 덮어쓰기) */
function deepMerge(base, over) {
  if (over == null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 환경변수 오버라이드 적용 */
function applyEnv(cfg) {
  const out = deepMerge(cfg, {});
  if (process.env.OLLAMA_HOST) out.ollama.host = process.env.OLLAMA_HOST;
  if (process.env.TOKENLIFT_HOST) out.ollama.host = process.env.TOKENLIFT_HOST;
  if (process.env.TOKENLIFT_MODEL) out.routing.default = process.env.TOKENLIFT_MODEL;
  if (process.env.TOKENLIFT_TIMEOUT_MS) out.ollama.timeoutMs = Number(process.env.TOKENLIFT_TIMEOUT_MS);
  if (process.env.TOKENLIFT_NO_LOG === '1') out.logging.enabled = false;
  if (process.env.TOKENLIFT_PROVIDER) out.provider = process.env.TOKENLIFT_PROVIDER;
  return out;
}

let _cached = null;

/** 최종 설정 로드 (메모이즈) */
export function loadConfig() {
  if (_cached) return _cached;
  let cfg = DEFAULTS;
  cfg = deepMerge(cfg, readJson(PKG_CONFIG) || {});
  cfg = deepMerge(cfg, readJson(USER_CONFIG) || {});
  cfg = applyEnv(cfg);
  _cached = cfg;
  return cfg;
}

export function configPaths() {
  return { package: PKG_CONFIG, user: USER_CONFIG };
}
