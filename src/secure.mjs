// secure.mjs — NemoClaw 보안 게이트웨이 자동 적용
// TokenLift 설정의 security 블록을 단일 소스로 삼아 Claude Code(Bedrock) 보안을 강제한다.
//   - Bedrock 트래픽 → NemoClaw 게이트웨이 경유(PII redaction/정책 필터)  [보안]
//   - 온프렘 LLM(H200/V100/GLM) → 게이트웨이 우회 직결                    [예외]
//   - 민감 폴더/파일 → Claude Code permissions.deny + sandbox 로 접근 차단 [유출 원천 차단]
//
// 이 모듈은 Claude Code 의 settings.json 을 "안전하게 병합"한다(기존 설정 보존 + 백업).
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, readJson, ensureDir, eprint } from './util.mjs';

/** 설정에서 security 블록을 정규화해 반환(기본값 포함) */
export function getSecurity(config) {
  const s = config.security || {};
  const gateway = s.gateway || {};
  return {
    enabled: s.enabled !== false, // 기본 활성
    claudeSettingsPath: s.claudeSettingsPath || '~/.claude/settings.json',
    gateway: {
      // NemoClaw 추론 게이트웨이 주소(온보딩 시 출력). Bedrock 트래픽이 이곳을 거친다.
      url: gateway.url || 'http://localhost:8080',
      authTokenEnv: gateway.authTokenEnv || 'NEMOCLAW_GATEWAY_TOKEN',
    },
    bedrock: {
      region: s.bedrock?.region || 'us-east-1',
      // 실제 Bedrock Runtime 호스트(게이트웨이가 이 목적지로 정책 필터를 적용)
      runtimeHost: s.bedrock?.runtimeHost || `bedrock-runtime.${s.bedrock?.region || 'us-east-1'}.amazonaws.com`,
      useMantle: !!s.bedrock?.useMantle,
    },
    // 게이트웨이/필터를 우회(직결)할 신뢰 호스트 — 사내 온프렘 LLM 등. = 보안 예외.
    exemptHosts: Array.isArray(s.exemptHosts) && s.exemptHosts.length
      ? s.exemptHosts
      : ['localhost', '127.0.0.1'],
    // 유출 차단할 민감 경로/글롭. Claude Code 가 아예 못 읽게 한다.
    sensitivePaths: Array.isArray(s.sensitivePaths) ? s.sensitivePaths : [],
    // OS 레벨 샌드박스로 읽기 허용할 루트(비면 sandbox 미설정)
    allowReadRoots: Array.isArray(s.allowReadRoots) ? s.allowReadRoots : [],
  };
}

/**
 * 민감 경로 문자열 → Claude Code deny 패턴으로 변환.
 * 규칙(gitignore 스펙 기반):
 *   - '//abs'  파일시스템 루트 앵커 (절대경로 '/mnt/..' → '//mnt/..')
 *   - '~/..'   홈 앵커 (그대로)
 *   - 글롭('*') 없고 확장자 없으면 디렉토리로 보고 '/**' 부착
 */
export function toDenyGlob(p) {
  let g = String(p).trim().replace(/\\/g, '/');
  const hasGlob = g.includes('*');
  const looksFile = /\.[a-z0-9]+$/i.test(g);
  if (!hasGlob && !looksFile) g = g.replace(/\/+$/, '') + '/**';
  // 절대경로(단일 '/')는 파일시스템 루트 앵커('//')로
  if (g.startsWith('/') && !g.startsWith('//')) g = '/' + g;
  return g;
}

/** security → Claude Code settings.json 에 주입할 조각 생성 */
export function buildGeneratedSettings(sec) {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    // Claude Code 의 Bedrock 트래픽을 NemoClaw 게이트웨이로 우회(= 보안 적용)
    ANTHROPIC_BEDROCK_BASE_URL: sec.gateway.url,
    // 온프렘/로컬은 프록시 우회(= 예외, 직결). HTTPS_PROXY 가 있어도 이 호스트는 제외.
    NO_PROXY: sec.exemptHosts.join(','),
  };
  if (sec.bedrock.useMantle) {
    env.CLAUDE_CODE_USE_MANTLE = '1';
    env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL = sec.gateway.url;
  }

  const deny = sec.sensitivePaths.map((p) => `Read(${toDenyGlob(p)})`);

  const out = { env, permissions: { deny } };

  // OS 샌드박스는 "구체 경로"만 다룬다(글롭은 위 permissions.deny 가 담당).
  // 순수 글롭(**/*.pem 등)은 제외하고, 디렉토리성 경로만 denyRead 로.
  const concreteDeny = sec.sensitivePaths
    .filter((p) => !/[*?]/.test(String(p).replace(/\/\*\*$/, ''))) // 말미 '/**' 만 있는 경로는 허용
    .map((p) => expandHome(String(p).replace(/\/\*\*$/, '').replace(/\/+$/, '')));
  const allowRead = sec.allowReadRoots.map(expandHome);
  if (allowRead.length || concreteDeny.length) {
    out.sandbox = { filesystem: {} };
    if (allowRead.length) out.sandbox.filesystem.allowRead = allowRead;
    if (concreteDeny.length) out.sandbox.filesystem.denyRead = concreteDeny;
  }
  return out;
}

/** 배열 합집합(중복 제거, 순서 보존) */
function unionArray(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const x of [...a, ...b]) {
    const k = typeof x === 'string' ? x : JSON.stringify(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

/**
 * 기존 settings 에 generated 를 안전 병합.
 *  - env: 우리 키만 설정/갱신(나머지 보존)
 *  - permissions.deny / sandbox.*.(allow|deny)Read: 합집합
 * @returns {{merged, changes: string[]}}
 */
export function mergeSettings(existing, generated) {
  const merged = existing && typeof existing === 'object' ? JSON.parse(JSON.stringify(existing)) : {};
  const changes = [];

  merged.env = merged.env || {};
  for (const [k, v] of Object.entries(generated.env || {})) {
    if (merged.env[k] !== v) {
      changes.push(`env.${k} = ${v}${merged.env[k] != null ? ` (이전: ${merged.env[k]})` : ''}`);
      merged.env[k] = v;
    }
  }

  if (generated.permissions?.deny?.length) {
    merged.permissions = merged.permissions || {};
    const before = merged.permissions.deny || [];
    const after = unionArray(before, generated.permissions.deny);
    const added = after.filter((x) => !before.includes(x));
    if (added.length) changes.push(`permissions.deny += ${added.length}개 (${added.join(', ')})`);
    merged.permissions.deny = after;
  }

  if (generated.sandbox?.filesystem) {
    merged.sandbox = merged.sandbox || {};
    merged.sandbox.filesystem = merged.sandbox.filesystem || {};
    for (const key of ['allowRead', 'denyRead']) {
      const gen = generated.sandbox.filesystem[key];
      if (gen?.length) {
        const before = merged.sandbox.filesystem[key] || [];
        const after = unionArray(before, gen);
        const added = after.filter((x) => !before.includes(x));
        if (added.length) changes.push(`sandbox.filesystem.${key} += ${added.length}개`);
        merged.sandbox.filesystem[key] = after;
      }
    }
  }
  return { merged, changes };
}

/** settings.json 읽기(없으면 {}) */
export function readSettings(settingsPath) {
  const full = expandHome(settingsPath);
  return readJson(full) || {};
}

/** settings.json 쓰기(디렉토리 생성 + 기존 파일 백업) */
export function writeSettings(settingsPath, obj) {
  const full = expandHome(settingsPath);
  ensureDir(path.dirname(full));
  let backup = null;
  if (fs.existsSync(full)) {
    backup = full + '.bak';
    fs.copyFileSync(full, backup);
  }
  fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return { path: full, backup };
}

/** 게이트웨이 도달성 확인(HTTP 응답이 오면 살아있음으로 간주) */
export async function pingGateway(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 현재 settings 가 기대하는 보안 태세를 만족하는지 감사.
 * @returns {Array<{label, ok, detail}>}
 */
export function auditPosture(sec, settings) {
  const checks = [];
  const env = settings.env || {};

  checks.push({
    label: 'Bedrock → 게이트웨이 우회',
    ok: env.ANTHROPIC_BEDROCK_BASE_URL === sec.gateway.url && env.CLAUDE_CODE_USE_BEDROCK === '1',
    detail: `CLAUDE_CODE_USE_BEDROCK=${env.CLAUDE_CODE_USE_BEDROCK || '(없음)'} / ANTHROPIC_BEDROCK_BASE_URL=${env.ANTHROPIC_BEDROCK_BASE_URL || '(없음)'} (기대: ${sec.gateway.url})`,
  });

  const noProxy = (env.NO_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const missingExempt = sec.exemptHosts.filter((h) => !noProxy.includes(h));
  checks.push({
    label: '온프렘 예외(NO_PROXY 직결)',
    ok: missingExempt.length === 0,
    detail: missingExempt.length ? `NO_PROXY 누락: ${missingExempt.join(', ')}` : `직결 호스트: ${sec.exemptHosts.join(', ')}`,
  });

  const deny = settings.permissions?.deny || [];
  const wantDeny = sec.sensitivePaths.map((p) => `Read(${toDenyGlob(p)})`);
  const missingDeny = wantDeny.filter((d) => !deny.includes(d));
  checks.push({
    label: '민감 폴더 유출 차단(permissions.deny)',
    ok: sec.sensitivePaths.length > 0 && missingDeny.length === 0,
    detail: sec.sensitivePaths.length === 0
      ? '민감 경로 미설정(security.sensitivePaths 를 채우세요)'
      : missingDeny.length ? `deny 누락: ${missingDeny.join(', ')}` : `차단 규칙 ${wantDeny.length}개 적용됨`,
  });

  return checks;
}
