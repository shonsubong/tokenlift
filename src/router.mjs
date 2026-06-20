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

// ── 에이전트 역할 라우팅 (oh-my-openagent 식 오케스트레이터-워커) ──
// task → 기본 역할. 어려운 추론/에이전트형은 oracle(H200), 나머지 대량 생성은 coder(V100).
const TASK_ROLE = {
  reason: 'oracle', agent: 'oracle',
  gen: 'coder', edit: 'coder', test: 'coder', refactor: 'coder',
  translate: 'coder', explain: 'coder', review: 'coder', docs: 'coder',
  fast: 'coder', complete: 'coder',
};

export function roleForTask(task) {
  return TASK_ROLE[task] || 'coder';
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

/**
 * 자연어 작업 설명을 받아 라우팅 추천.
 * @param {string} description 작업 설명
 * @param {object} config 전체 설정
 * @param {string} [providerName] 명시 provider(있으면 역할 자동선택보다 우선)
 * @returns {{route:'local'|'claude', role, provider, task, model, tier, confidence, reason}}
 */
export function recommend(description, config, providerName) {
  const text = (description || '').toLowerCase();

  // 1) Claude 유지 신호 우선
  for (const kw of KEEP_ON_CLAUDE) {
    if (text.includes(kw.toLowerCase())) {
      return {
        route: 'claude',
        role: 'lead',
        provider: null,
        task: null,
        model: null,
        tier: costTier(config, 'claude'),
        confidence: 'high',
        reason: `고난도 판단 신호 감지("${kw}") → Claude(Bedrock) 직접 처리 권장`,
      };
    }
  }

  // 2) 로컬 위임 신호 탐지 (task 분류 포함)
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
    // 역할 → 비용 최적 provider 선택. 명시 providerName 이 있으면 그것을 우선.
    // 난도 신호가 있으면 coder(V100) → oracle(H200) 로 승급.
    const hard = HARD_SIGNALS.some((kw) => text.includes(kw.toLowerCase()));
    const roleName = hard ? 'oracle' : roleForTask(best);
    const role = resolveRole(config, roleName);
    let profile;
    let pinnedModel = null;
    if (providerName) {
      profile = getProviderProfile(config, providerName);
    } else if (role && role.primary) {
      profile = getProviderProfile(config, role.primary.provider);
      pinnedModel = role.primary.model || null;
    } else {
      profile = getProviderProfile(config); // 기본 provider (보통 ollama)
    }
    const fallbacks = role ? role.callableChain.slice(1).map((e) => e.provider) : [];
    return {
      route: 'local',
      role: roleName,
      provider: profile.name,
      task: best,
      model: pickModel(best, profile, pinnedModel),
      tier: costTier(config, profile.name),
      fallbacks,
      confidence: 'medium',
      reason: `대량/반복 코딩 신호 → '${best}' = '${roleName}' 역할로 '${profile.name}' 위임 권장(비용 최소)`,
    };
  }

  // 3) 판단 불가 → 기본은 Claude (안전)
  return {
    route: 'claude',
    role: 'lead',
    provider: null,
    task: null,
    model: null,
    tier: costTier(config, 'claude'),
    confidence: 'low',
    reason: '명확한 위임 신호 없음 → 기본적으로 Claude 처리(필요시 수동 위임)',
  };
}
