// router.mjs - 모델 선택 + Claude vs 로컬위임 판단 + 에이전트 역할/티어 라우팅 (멀티프로바이더)
import { getProviderProfile } from './providers/index.mjs';

/**
 * task 와 provider 프로파일로 사용할 모델 결정.
 * profileOrConfig 는 provider 프로파일(권장) 또는 (하위호환) 전체 config 를 받는다.
 */
export function pickModel(task, profileOrConfig, override) {
  if (override) return override;
  const routing = profileOrConfig?.routing || {};
  return (routing.byTask && routing.byTask[task]) || routing.default || 'qwen2.5-coder:14b';
}

// ── 에이전트 역할 라우팅 (oh-my-openagent 식 오케스트레이터-워커 + 실행자/조언자) ──
// task → 기본 역할(카테고리). OmO 처럼 "모델이 아니라 카테고리를 고른다".
//  - executor(실행자): 개발 대부분(생성/수정/테스트/리팩터) → 사내 GLM-5.2 우선(무제한·기밀 안전)
//  - oracle: 어려운 추론/에이전트형 → 사내 최고지능(GLM-5.2)
//  - coder: 가볍고 빠른 정형 작업 → V100 소형 모델(요약/문서/FIM)
const TASK_ROLE = {
  reason: 'oracle', agent: 'oracle',
  gen: 'executor', edit: 'executor', test: 'executor', refactor: 'executor',
  translate: 'executor', review: 'executor',
  explain: 'coder', docs: 'coder', fast: 'coder', complete: 'coder',
};

export function roleForTask(task) {
  return TASK_ROLE[task] || 'executor';
}

// ── 기밀(민감) 신호 감지 — 보안 우선 라우팅의 1단계 ──
// 이 신호가 있는 내용은 외부(Bedrock)로 보내지 않고 사내 GLM-5.2 에서 처리한다.
// (Claude Code 쪽 폴더 차단(permissions.deny)의 보조 계층 — 내용 기반 사전 검증)
const BUILTIN_SENSITIVE_PATTERNS = [
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'secret-assignment', re: /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'ngc-key', re: /\bnvapi-[A-Za-z0-9_\-]{10,}/ },
  { label: 'internal-host', re: /\b[a-z0-9.-]+\.internal\b/i },
  { label: 'korean-rrn', re: /\b\d{6}-[1-4]\d{6}\b/ }, // 주민등록번호 형태
  { label: 'confidential-kw', re: /(사내\s?기밀|대외비|내부\s?전용|고객\s?정보|confidential|proprietary|internal\s+only|do\s+not\s+distribute)/i },
];

/**
 * 텍스트의 기밀(민감) 신호 평가. config.security.sensitivePatterns 로 사용자 패턴 추가:
 *   문자열 → 대소문자 무시 포함 검사, "/re/flags" 형식 → 정규식.
 * @returns {{sensitive: boolean, matches: string[]}}
 */
export function assessSensitivity(text, config) {
  const t = String(text || '');
  const matches = [];
  for (const { label, re } of BUILTIN_SENSITIVE_PATTERNS) {
    if (re.test(t)) matches.push(label);
  }
  for (const p of config?.security?.sensitivePatterns || []) {
    try {
      const m = typeof p === 'string' && p.startsWith('/') && p.lastIndexOf('/') > 0
        ? new RegExp(p.slice(1, p.lastIndexOf('/')), p.slice(p.lastIndexOf('/') + 1))
        : null;
      if (m ? m.test(t) : t.toLowerCase().includes(String(p).toLowerCase())) {
        matches.push(`custom:${p}`);
      }
    } catch { /* 잘못된 패턴은 무시 */ }
  }
  return { sensitive: matches.length > 0, matches };
}

// 난도 신호: 위임은 하되 V100(coder) 대신 H200(oracle) 프런티어 모델로 승급해야 하는 작업.
// (보안/설계/근본원인 등 KEEP_ON_CLAUDE 는 그 전에 이미 Claude 로 분기되므로 여기 오지 않음)
const HARD_SIGNALS = [
  '알고리즘', 'algorithm', '대규모', '대형', 'large-scale', '복잡한 로직',
  '성능 최적화', 'optimize performance', '병목', '동시성', 'concurrency',
  '전체 모듈', '전반 리팩터', '대규모 리팩터', '멀티파일', '여러 파일에 걸친',
];

// 'claude'(Bedrock=에이전트 자신), 'codebase-memory-mcp'(그래프 MCP) 는 CLI 위임 대상이 아님(종단 라벨).
const NON_DELEGATABLE = new Set(['claude', 'codebase-memory-mcp']);

/** provider 가 CLI 로 호출 가능한가(설정됨). 'ollama' 는 내장이라 항상 가능. */
export function isCallableProvider(config, provider) {
  if (NON_DELEGATABLE.has(provider)) return false;
  return provider === 'ollama' || !!config.providers?.[provider];
}

/** 역할의 체인을 [{provider, model?}] 형태로 정규화 */
function normalizeChain(role) {
  const raw = Array.isArray(role.chain) ? role.chain : role.provider ? [role.provider] : [];
  return raw.map((e) => (typeof e === 'string' ? { provider: e } : { provider: e.provider, model: e.model }));
}

/**
 * 역할 이름 → 폴백 체인 해석(oh-my-openagent 식).
 * @returns {{name, style, desc, chain, callableChain, primary, terminal}} | null
 *  - chain: 전체 체인(라벨 포함)
 *  - callableChain: CLI 로 실제 위임 가능한 항목만(순서 유지) — 런타임 자동 강등에 사용
 *  - primary: 첫 호출가능 항목(없으면 null = Claude/그래프가 직접 처리)
 *  - terminal: 체인 마지막(보통 claude — 최후 폴백)
 */
export function resolveRole(config, roleName) {
  const r = (config.roles || {})[roleName];
  if (!r) return null;
  const chain = normalizeChain(r);
  const callableChain = chain.filter((e) => isCallableProvider(config, e.provider));
  return {
    name: roleName,
    style: r.style || '',
    desc: r.desc || '',
    chain,
    callableChain,
    primary: callableChain[0] || null,
    terminal: chain.length ? chain[chain.length - 1].provider : null,
  };
}

/** 에스컬레이션 사다리에서 provider 의 비용 티어(1=가장 쌈). 없으면 null */
export function costTier(config, provider) {
  const ladder = config.escalation || [];
  const i = ladder.indexOf(provider);
  return i < 0 ? null : { tier: i + 1, of: ladder.length };
}

// Claude(고급 추론)에 남겨야 하는 신호 키워드
const KEEP_ON_CLAUDE = [
  '아키텍처', 'architecture', '설계', 'design', '전략', 'strategy',
  '보안', 'security', '취약점', 'vulnerab', '인증', 'auth ',
  '복잡한 디버깅', 'root cause', '근본 원인', '왜', 'why is',
  '트레이드오프', 'trade-off', 'tradeoff', '의사결정', 'decision',
  '마이그레이션 계획', 'migration plan', '전체 시스템', 'system-wide',
];

// Ollama 위임에 적합한 신호 키워드 (대량 생성/반복 작업)
// 주의: 구체적 태스크를 먼저 검사해야 한다. 범용 'gen'('작성' 등)이 위에 있으면
//       "테스트 코드 작성"이 test 가 아닌 gen 으로 오분류된다.
const DELEGATE_TO_OLLAMA = {
  test: ['테스트', 'unit test', 'test 작성', '테스트 코드', 'spec 작성'],
  translate: ['이식', '포팅', 'port ', '변환', 'translate', 'convert to'],
  refactor: ['리팩터', 'refactor', '이름 변경', 'rename', '일괄', 'bulk'],
  review: ['리뷰', 'review', '검토'],
  docs: ['문서', 'docstring', '주석', 'comment', 'document'],
  explain: ['요약', 'summarize', '설명', 'explain', '무슨 일', 'what does'],
  gen: ['생성', 'generate', '작성', 'write a', '구현', 'implement', '스캐폴드', 'scaffold', 'boilerplate', '보일러플레이트'],
  edit: ['수정', 'edit', '변경', 'change', '추가', 'add '],
};

/** 역할 이름으로 local 추천 결과를 조립하는 내부 헬퍼 */
function localRoute(config, roleName, task, providerName, extra) {
  const role = resolveRole(config, roleName);
  let profile;
  let pinnedModel = null;
  if (providerName) {
    profile = getProviderProfile(config, providerName);
  } else if (role && role.primary) {
    profile = getProviderProfile(config, role.primary.provider);
    pinnedModel = role.primary.model || null;
  } else {
    profile = getProviderProfile(config); // 기본 provider
  }
  const fallbacks = role ? role.callableChain.slice(1).map((e) => e.provider) : [];
  return {
    route: 'local',
    role: roleName,
    provider: profile.name,
    task,
    model: task ? pickModel(task, profile, pinnedModel) : (pinnedModel || profile.routing?.default || null),
    tier: costTier(config, profile.name),
    fallbacks,
    ...extra,
  };
}

/**
 * 자연어 작업 설명을 받아 라우팅 추천 — 보안(기밀) 우선.
 * 순서: (0) 기밀 신호 평가 → (1) 고난도 판단 신호 → (2) 위임 신호 → (3) 기본.
 * 기밀 신호가 있으면 어떤 경우에도 외부(Bedrock) 전송을 권하지 않는다(bedrockAllowed:false).
 * @returns {{route:'local'|'claude', role, provider, task, model, tier, confidence, reason,
 *            sensitivity:'high'|'low', bedrockAllowed:boolean, sensitiveMatches?:string[]}}
 */
export function recommend(description, config, providerName) {
  const text = (description || '').toLowerCase();
  const sens = assessSensitivity(description, config);

  // 1) 고난도 판단 신호 (설계/보안판단/근본원인/트레이드오프)
  for (const kw of KEEP_ON_CLAUDE) {
    if (text.includes(kw.toLowerCase())) {
      if (sens.sensitive) {
        // 기밀 + 고난도 → 외부 전송 금지. 사내 최고지능(oracle=GLM-5.2)이 처리.
        return {
          ...localRoute(config, 'oracle', null, providerName),
          confidence: 'high',
          sensitivity: 'high',
          bedrockAllowed: false,
          sensitiveMatches: sens.matches,
          reason: `고난도 신호("${kw}") + 기밀 신호(${sens.matches.join(', ')}) → 외부(Bedrock) 전송 금지, 사내 GLM-5.2(oracle)가 처리. Claude 에게는 기밀을 제거한 추상 질문만.`,
        };
      }
      return {
        route: 'claude',
        role: 'advisor',
        provider: null,
        task: null,
        model: null,
        tier: costTier(config, 'claude'),
        confidence: 'high',
        sensitivity: 'low',
        bedrockAllowed: true,
        reason: `고난도 판단 신호("${kw}") + 기밀 신호 없음 → 조언자(Claude/Bedrock) 직접 처리. 실행은 위임으로.`,
      };
    }
  }

  // 2) 위임 신호 탐지 (task 분류)
  let best = null;
  for (const [task, kws] of Object.entries(DELEGATE_TO_OLLAMA)) {
    for (const kw of kws) {
      if (text.includes(kw.toLowerCase())) {
        best = task;
        break;
      }
    }
    if (best) break;
  }

  if (best) {
    const hard = HARD_SIGNALS.some((kw) => text.includes(kw.toLowerCase()));
    // 기밀이면 경량(coder) 작업도 executor(GLM-5.2 체인)로 승급 — "보안 문제 = 사내 GLM" 원칙
    const roleName = hard ? 'oracle' : sens.sensitive ? 'executor' : roleForTask(best);
    return {
      ...localRoute(config, roleName, best, providerName),
      confidence: 'medium',
      sensitivity: sens.sensitive ? 'high' : 'low',
      bedrockAllowed: !sens.sensitive,
      ...(sens.sensitive ? { sensitiveMatches: sens.matches } : {}),
      reason:
        `개발/반복 신호 → '${best}' = '${roleName}' 역할로 사내 위임(실행자)` +
        (sens.sensitive ? ` · 기밀 신호(${sens.matches.join(', ')}) → Bedrock 승급 금지` : ''),
    };
  }

  // 3) 판단 불가 — 기밀이면 사내 실행자로, 아니면 Claude(조언자)
  if (sens.sensitive) {
    return {
      ...localRoute(config, 'executor', null, providerName),
      confidence: 'medium',
      sensitivity: 'high',
      bedrockAllowed: false,
      sensitiveMatches: sens.matches,
      reason: `기밀 신호(${sens.matches.join(', ')}) → 외부(Bedrock) 전송 금지, 사내 실행자(GLM-5.2) 처리`,
    };
  }
  return {
    route: 'claude',
    role: 'lead',
    provider: null,
    task: null,
    model: null,
    tier: costTier(config, 'claude'),
    confidence: 'low',
    sensitivity: 'low',
    bedrockAllowed: true,
    reason: '명확한 위임/기밀 신호 없음 → 기본적으로 Claude 처리(필요시 수동 위임)',
  };
}
