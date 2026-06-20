#!/usr/bin/env node
// tokenlift - Claude Code(Bedrock) 고비용 토큰 작업을 로컬/온프렘 LLM으로 위임하는 브리지 CLI
// 지원 백엔드(provider): ollama | nemoclaw(NVIDIA NIM, OpenAI 호환) | 기타 OpenAI 호환 서버
import fs from 'node:fs';
import { loadConfig, configPaths } from '../src/config.mjs';
import {
  getProviderProfile, createProvider, resolveProviderName, listProviderNames,
} from '../src/providers/index.mjs';
import { buildTask, TASK_LIST } from '../src/tasks.mjs';
import { pickModel, recommend, resolveRole, costTier } from '../src/router.mjs';
import { estimateSavings, logUsage, readStats, formatStats } from '../src/logger.mjs';
import {
  readFileSafe, writeFileSafe, extractCode, stripThink,
  readStdin, eprint, fmtUsd, fmtMs,
} from '../src/util.mjs';

const VERSION = '0.2.0';
const CODE_TASKS = new Set(['gen', 'edit', 'test', 'refactor', 'translate', 'complete']);

// ---------- 인자 파서 ----------
function parseArgs(argv) {
  const flags = { files: [], _: [] };
  const aliases = { m: 'model', f: 'file', o: 'out', q: 'quiet', h: 'help', p: 'provider' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['quiet', 'json', 'no-log', 'apply', 'help', 'version'].includes(key)) {
        flags[key === 'no-log' ? 'noLog' : key] = true;
      } else {
        const val = argv[++i];
        if (key === 'file') flags.files.push(val);
        else flags[key] = val;
      }
    } else if (a.startsWith('-') && a.length > 1 && !/^-?\d/.test(a)) {
      const key = aliases[a.slice(1)] || a.slice(1);
      if (key === 'quiet' || key === 'help') flags[key] = true;
      else {
        const val = argv[++i];
        if (key === 'file') flags.files.push(val);
        else flags[key] = val;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

// ---------- 헬프 ----------
const HELP = `tokenlift v${VERSION} — 로컬/온프렘 LLM 위임 브리지

사용법:
  tokenlift <command> [텍스트...] [옵션]
  echo "프롬프트" | tokenlift <command> [옵션]

코딩 위임 명령 (stdout = 코드):
  gen        명세로 새 코드 생성        예) tokenlift gen "JWT 검증 미들웨어" --lang ts
  edit       파일을 지시대로 수정        예) tokenlift edit "널 체크 추가" -f a.js --apply
  test       대상 코드의 단위테스트 생성  예) tokenlift test -f service.py
  refactor   동작 유지 리팩터링          예) tokenlift refactor "함수 분리" -f big.js --apply
  translate  언어/프레임워크 이식        예) tokenlift translate -f a.py --lang python --to go
  complete   FIM 중간 코드 채우기        예) tokenlift complete --prefix "def add(" --suffix "):"

분석/문서 명령 (stdout = 텍스트):
  explain    코드 설명/요약(컨텍스트 절감) 예) tokenlift explain -f huge.log
  review     로컬 코드 리뷰              예) tokenlift review -f patch.diff
  docs       문서/주석 생성             예) tokenlift docs "README 초안" -f api.ts
  ask        임의 프롬프트              예) tokenlift ask "정규식 설명"

라우팅/운영 명령:
  route      위임 여부/역할/모델 추천    예) tokenlift route "전체 결제 모듈 보안 설계"
  roles      에이전트 역할 → 백엔드 + 에스컬레이션 사다리
  models     모델 목록 + 라우팅 매핑     (활성 provider 기준)
  providers  설정된 백엔드 목록
  stats      누적 절감 통계
  warmup     모델 메모리 선적재          예) tokenlift warmup -m qwen2.5-coder:14b
  doctor     환경 점검                  예) tokenlift doctor --provider nemoclaw
  help       이 도움말

옵션:
  -p, --provider <name>  백엔드 선택 (ollama | nemoclaw | onprem-h200 | onprem-v100 ...)
      --role <name>      역할로 백엔드 자동 선택 (coder=V100 | oracle=H200). --provider 우선
  -m, --model <name>     모델 강제 지정(라우팅 무시)
  -f, --file <path>      입력 파일(여러 번 가능)
  -o, --out <path>       결과를 파일로 저장
      --apply            (edit/refactor) 입력 파일에 결과를 덮어쓰기
      --lang <l>         소스 언어 힌트
      --to <l>           (translate) 대상 언어 / (complete) suffix
      --prefix/--suffix  (complete) FIM 접두/접미
      --host <url>       백엔드 호스트 override
      --timeout <ms>     요청 타임아웃
      --temp <n>         temperature
      --num-ctx <n>      컨텍스트 윈도우 토큰 수(ollama)
      --json             기계 판독용 JSON 출력
  -q, --quiet            stderr 메타(토큰/비용) 출력 억제
      --no-log           사용량 로깅 비활성화
`;

// --role/--provider/config 로부터 시도할 백엔드 체인 [{provider, model?}] 해석.
// 역할이면 폴백 체인(호출가능 항목만), --provider 면 단일, 아니면 활성 provider.
function resolveAttemptChain(config, flags) {
  if (flags.role && !flags.provider) {
    const role = resolveRole(config, flags.role);
    if (!role) {
      eprint(`알 수 없는 역할: '${flags.role}'. roles: ${Object.keys(config.roles || {}).join(', ')}`);
      process.exit(2);
    }
    if (role.callableChain.length === 0) {
      const chain = role.chain.map((e) => e.provider).join(' → ');
      eprint(`역할 '${flags.role}' 은 위임 가능한 백엔드가 없습니다(체인: ${chain}). → Claude/그래프가 직접 처리.`);
      process.exit(2);
    }
    return role.callableChain.map((e) => ({ provider: e.provider, model: e.model || null }));
  }
  return [{ provider: resolveProviderName(config, flags.provider), model: null }];
}

// 단일 활성 provider 구성 (운영 명령 models/doctor/warmup 용)
function buildActiveProvider(config, flags) {
  const [first] = resolveAttemptChain(config, flags);
  const profile = getProviderProfile(config, first.provider);
  if (flags.host) profile.host = flags.host;
  if (first.model && !flags.model) flags.model = first.model;
  const timeoutMs = Number(flags.timeout) || profile.timeoutMs || config.ollama?.timeoutMs || 600000;
  const provider = createProvider(profile);
  return { provider, profile, timeoutMs };
}

function isConnError(err) {
  return (
    err?.code === 'ECONN' ||
    err?.code === 'ETIMEOUT' ||
    err?.code === 'EHTTP' ||
    /연결할 수 없|타임아웃|ECONNREFUSED|fetch failed|연결: 실패/i.test(err?.message || '')
  );
}

// ---------- 메인 ----------
async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const cmd = flags._.shift();

  if (flags.version) return console.log(VERSION);
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  const config = loadConfig();
  if (flags.noLog) config.logging.enabled = false;

  // 운영 명령 분기
  if (cmd === 'stats') return console.log(formatStats(readStats(config)));
  if (cmd === 'roles') return cmdRoles(config);
  if (cmd === 'providers') return cmdProviders(config, flags);
  if (cmd === 'models') return cmdModels(config, flags);
  if (cmd === 'doctor') return cmdDoctor(config, flags);
  if (cmd === 'warmup') return cmdWarmup(config, flags);
  if (cmd === 'route') return cmdRoute(config, flags);

  if (![...TASK_LIST].includes(cmd)) {
    eprint(`알 수 없는 명령: ${cmd}\n'tokenlift help' 로 사용법 확인`);
    process.exit(2);
  }

  // ---- 태스크 명령 처리 ----
  // 시도할 백엔드 체인(역할이면 폴백 체인). 앞에서부터 시도하고 연결 실패 시 다음으로 강등.
  const attempts = resolveAttemptChain(config, flags);
  const timeoutMs = Number(flags.timeout) || config.ollama?.timeoutMs || 600000;

  // 입력 텍스트: 위치인자 우선, 비었을 때만 stdin 을 읽는다.
  let instruction = flags._.join(' ').trim();
  if (!instruction) {
    const piped = await readStdin();
    if (piped) instruction = piped.trim();
  }

  // 파일 로드
  const files = [];
  for (const fp of flags.files) {
    const content = readFileSafe(fp);
    if (content == null) {
      eprint(`파일을 읽을 수 없음: ${fp}`);
      process.exit(2);
    }
    files.push({ path: fp, content });
  }

  if (cmd !== 'complete' && !instruction && files.length === 0) {
    eprint(`입력이 비었습니다. 텍스트 인자나 -f 파일, 또는 파이프 입력이 필요합니다.`);
    process.exit(2);
  }

  // 체인을 순회하며 위임. 연결/타임아웃 실패면 다음 폴백으로 자동 강등.
  let result, provider, profile, model;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    profile = getProviderProfile(config, a.provider);
    if (flags.host) profile.host = flags.host;
    provider = createProvider(profile);
    model = flags.model || a.model || pickModel(cmd, profile);

    const options = {};
    options.temperature = flags.temp != null ? Number(flags.temp) : config.generation?.temperature ?? 0.1;
    if (flags['num-ctx']) options.num_ctx = Number(flags['num-ctx']);
    else if (profile.numCtx) options.num_ctx = profile.numCtx;

    try {
      if (cmd === 'complete') {
        if (provider.supportsFIM === false) {
          eprint(`주의: '${provider.name}' 는 FIM(complete)을 지원하지 않을 수 있습니다. 실패 시 gen/edit 권장.`);
        }
        const built = buildTask('complete', {
          prefix: flags.prefix ?? instruction,
          suffix: flags.suffix ?? flags.to ?? '',
        });
        result = await provider.generate({ model, prompt: built.prompt, suffix: built.suffix, options, timeoutMs });
      } else {
        const built = buildTask(cmd, {
          instruction, files,
          lang: flags.lang || '', to: flags.to || '',
          context: flags.context || '',
        });
        result = await provider.chat({
          model,
          messages: [
            { role: 'system', content: built.system },
            { role: 'user', content: built.user },
          ],
          options, timeoutMs,
        });
      }
      break; // 성공
    } catch (err) {
      const more = i < attempts.length - 1;
      if (isConnError(err) && more) {
        eprint(`⚠️ '${a.provider}' 위임 실패(${(err.message || '').split('\n')[0]}) → 폴백 '${attempts[i + 1].provider}' 시도`);
        continue;
      }
      if (isConnError(err)) {
        eprint(`오류: 체인의 모든 백엔드 위임 실패. 마지막: ${err.message}`);
        eprint(`→ 백엔드를 점검(tokenlift doctor --provider ${a.provider})하거나 Claude 가 직접 처리하세요.`);
        process.exit(1);
      }
      throw err;
    }
  }

  // 결과물 가공: 코드 태스크는 코드펜스 추출, 그 외는 think 제거
  const payload = CODE_TASKS.has(cmd) ? extractCode(result.content) : stripThink(result.content);

  // 절감 추정 + 로깅
  const sav = estimateSavings({ inTokens: result.inTokens, outTokens: result.outTokens, pricing: config.pricing });
  logUsage({
    provider: provider.name, task: cmd, model: result.model,
    inTokens: result.inTokens, outTokens: result.outTokens,
    grossUsd: sav.grossUsd, durationMs: result.durationMs,
  }, config);

  // 파일 저장 결정
  let outPath = flags.out;
  if (!outPath && flags.apply && files.length === 1) outPath = files[0].path;

  if (flags.json) {
    console.log(JSON.stringify({
      provider: provider.name, task: cmd, model: result.model, payload,
      inTokens: result.inTokens, outTokens: result.outTokens,
      durationMs: result.durationMs, estimate: sav, outPath: outPath || null,
    }, null, 2));
  } else if (outPath) {
    const saved = writeFileSafe(outPath, payload + (payload.endsWith('\n') ? '' : '\n'));
    console.log(saved); // stdout = 저장 경로
  } else {
    console.log(payload); // stdout = 결과물
  }

  if (!flags.quiet && !flags.json) {
    eprint(
      `\n— TokenLift — provider=${provider.name} | model=${result.model} | ` +
      `tok in/out=${result.inTokens}/${result.outTokens} | ${fmtMs(result.durationMs)} | ` +
      `Bedrock 환산 절감(추정) ${fmtUsd(sav.grossUsd)}`
    );
  }
}

// ---------- 서브명령 구현 ----------
function cmdRoles(config) {
  console.log('# 에이전트 역할 → 폴백 체인 (oh-my-openagent fallbackChain 반영)');
  console.log('  체인은 앞에서부터 호출가능·도달가능한 첫 백엔드를 쓰고, 실패하면 다음으로 자동 강등.\n');
  for (const [name] of Object.entries(config.roles || {})) {
    const role = resolveRole(config, name);
    const chainStr = role.chain
      .map((e) => {
        const callable = role.callableChain.includes(e);
        return callable ? `[${e.provider}]` : e.provider; // [..]=CLI 위임 가능
      })
      .join(' → ');
    const now = role.primary ? role.primary.provider : '(직접: ' + role.terminal + ')';
    console.log(`  ${name.padEnd(9)} (${role.style})`);
    console.log(`  ${' '.repeat(9)} 체인: ${chainStr}`);
    console.log(`  ${' '.repeat(9)} 현재 해석: ${now}   ${role.desc}`);
  }
  console.log('\n# 비용 최소화 에스컬레이션 사다리 (싼 → 비싼)');
  const ladder = config.escalation || [];
  console.log('  ' + ladder.map((p, i) => `${i + 1}.${p}`).join('  →  '));
  console.log('\n[..] = CLI 위임 가능 백엔드. 사용: tokenlift <task> --role coder|oracle');
}

function cmdProviders(config, flags) {
  const active = resolveProviderName(config, flags.provider);
  console.log('# 설정된 백엔드(provider)');
  for (const name of listProviderNames(config)) {
    const p = getProviderProfile(config, name);
    const mark = name === active ? '➤ (활성)' : '  ';
    const host = p.host || '(미설정)';
    console.log(`  ${mark} ${name.padEnd(10)} type=${p.type.padEnd(13)} host=${host}`);
  }
  console.log(`\n활성 변경: --provider <name> 또는 config.provider`);
}

async function cmdModels(config, flags) {
  const { provider, profile } = buildActiveProvider(config, flags);
  let installed = [];
  try {
    installed = await provider.listModels({});
  } catch (e) {
    eprint(e.message);
    process.exit(1);
  }
  const names = new Set(installed.map((m) => m.name));
  console.log(`# 사용 가능 모델 (provider=${provider.name})`);
  for (const m of installed) {
    const meta = [m.sizeGb ? `${m.sizeGb}GB` : null, m.params, m.family].filter(Boolean).join(', ');
    console.log(`  ${m.name}${meta ? `  (${meta})` : ''}`);
  }
  if (installed.length === 0) console.log('  (목록 없음 — /v1/models 미지원이면 config.providers.<name>.models 에 수동 지정)');
  console.log(`\n# 라우팅 매핑 (task → model)`);
  const byTask = profile.routing?.byTask || {};
  for (const [t, model] of Object.entries(byTask)) {
    const ok = names.size === 0 ? '·' : names.has(model) ? '✅' : '⚠️ 미확인';
    console.log(`  ${t.padEnd(10)} → ${model}  ${ok}`);
  }
  if (profile.routing?.default) console.log(`  ${'(default)'.padEnd(10)} → ${profile.routing.default}`);
}

async function cmdDoctor(config, flags) {
  const { provider, profile, timeoutMs } = buildActiveProvider(config, flags);
  console.log('# TokenLift 환경 점검');
  const paths = configPaths();
  console.log(`Node: ${process.version}`);
  console.log(`설정(패키지): ${paths.package}`);
  console.log(`설정(사용자): ${fs.existsSync(paths.user) ? paths.user : '(없음)'}`);
  console.log(`활성 provider: ${provider.name} (type=${profile.type})`);
  console.log(`설정된 provider: ${listProviderNames(config).join(', ')}`);
  console.log(`호스트: ${profile.host}`);

  const alive = await provider.ping({ timeoutMs: 5000 });
  console.log(`연결: ${alive ? '✅ OK' : '❌ 실패'}`);
  if (!alive) {
    if (profile.type === 'ollama') console.log('  → Ollama 를 실행하세요: ollama serve');
    else console.log(`  → '${provider.name}' 엔드포인트(${profile.host})와 인증을 확인하세요`);
    process.exit(1);
  }

  let installed = [];
  try { installed = await provider.listModels({ timeoutMs }); } catch { /* 무시 */ }
  const names = new Set(installed.map((m) => m.name));
  const required = new Set(Object.values(profile.routing?.byTask || {}));
  if (profile.routing?.default) required.add(profile.routing.default);

  if (names.size === 0) {
    console.log('라우팅 모델: 서버가 모델 목록을 제공하지 않아 존재 확인 생략(런타임에 검증됨)');
  } else {
    let missing = 0;
    console.log('필수 모델 점검:');
    for (const m of required) {
      const ok = names.has(m);
      if (!ok) missing++;
      const hint = ok ? '' : profile.type === 'ollama' ? '  → ollama pull ' + m : '  → 배포 모델명 확인';
      console.log(`  ${ok ? '✅' : '❌'} ${m}${hint}`);
    }
    console.log(missing === 0 ? '\n모든 라우팅 모델 사용 가능 ✅' : `\n${missing}개 모델 미확인 ⚠️`);
  }
}

async function cmdWarmup(config, flags) {
  const { provider, profile, timeoutMs } = buildActiveProvider(config, flags);
  const model = flags.model || profile.routing?.default;
  if (!model) { eprint('워밍업할 모델을 알 수 없습니다. -m 으로 지정하세요.'); process.exit(2); }
  eprint(`워밍업: ${provider.name}/${model} 적재 중...`);
  const r = await provider.warmup({ model, timeoutMs });
  console.log(`✅ ${provider.name}/${model} 적재 완료 (${fmtMs(r.durationMs)})`);
}

async function cmdRoute(config, flags) {
  const desc = flags._.join(' ').trim() || (await readStdin()).trim();
  if (!desc) {
    eprint('작업 설명을 입력하세요. 예) tokenlift route "결제 모듈 테스트 코드 작성"');
    process.exit(2);
  }
  // route 추천은 명시 --provider 가 없으면 역할 기반 비용최적 백엔드를 제안
  const rec = recommend(desc, config, flags.provider);
  if (flags.json) return console.log(JSON.stringify(rec, null, 2));
  console.log(`라우팅 추천: ${rec.route.toUpperCase()}${rec.task ? ` (task=${rec.task})` : ''}`);
  if (rec.role) console.log(`역할: ${rec.role}`);
  if (rec.provider) console.log(`권장 백엔드: ${rec.provider}`);
  if (rec.model) console.log(`권장 모델: ${rec.model}`);
  if (rec.tier) console.log(`비용 티어: ${rec.tier.tier}/${rec.tier.of} (1=가장 쌈)`);
  if (rec.fallbacks && rec.fallbacks.length) console.log(`폴백 체인: ${rec.fallbacks.join(' → ')}`);
  console.log(`신뢰도: ${rec.confidence}`);
  console.log(`근거: ${rec.reason}`);
  if (rec.route === 'local' && rec.task) {
    console.log(`\n실행 예: tokenlift ${rec.task} "<지시>" -f <파일> --role ${rec.role}`);
  } else {
    console.log(`\n→ Claude(Bedrock)가 직접 처리. 현황 파악은 codebase-memory-mcp 그래프로.`);
  }
}

main().catch((err) => {
  eprint(`오류: ${err.message}`);
  process.exit(1);
});
