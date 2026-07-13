#!/usr/bin/env node
// suggest-delegation.mjs
// Claude Code UserPromptSubmit 훅. 사용자 프롬프트를 키워드 휴리스틱으로 분석해
// (1) 기밀 신호가 있으면 "사내 강제 + Bedrock 원문 금지" 보안 경고를,
// (2) 대량/반복 코딩 작업이면 "사내 위임을 고려하라"는 힌트를 컨텍스트로 주입한다.
// LLM 호출 없음(즉시). 어떤 경우에도 프롬프트를 차단하지 않는다(항상 exit 0).
//
// 등록: 플러그인으로 설치하면 hooks/hooks.json 이 "자동 등록"한다(수동 설정 불필요).
// (레거시/수동 설치 시에만) settings.json 등록 예:
//   "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
//     "command": "node \"<repo>/hooks/suggest-delegation.mjs\"" } ] } ] }

import { loadConfig } from '../src/config.mjs';
import { recommend } from '../src/router.mjs';

async function readAll() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readAll();
  let prompt = '';
  try {
    prompt = JSON.parse(raw).prompt || '';
  } catch {
    prompt = raw;
  }
  if (!prompt.trim()) process.exit(0);

  const cfg = loadConfig();
  const rec = recommend(prompt, cfg);

  // 기밀 신호가 있으면 위임 여부와 무관하게 "사내 강제" 경고를 최우선 주입한다.
  const secWarn =
    rec.sensitivity === 'high'
      ? `[TokenLift 보안] 🔒 기밀 신호 감지(${(rec.sensitiveMatches || []).join(', ')}). ` +
        `이 내용(원문)을 Bedrock 프롬프트에 넣지 마세요 — 사내 백엔드(${rec.provider || 'onprem-glm'})로 처리하고, ` +
        `판단이 필요하면 기밀을 제거·추상화한 질문만 사용하세요. `
      : '';

  if (rec.route === 'local' && rec.task) {
    const provHint = rec.provider && rec.provider !== 'ollama' ? ` --provider ${rec.provider}` : '';
    const hint =
      secWarn +
      `[TokenLift 힌트] 이 요청은 대량/반복 코딩 작업으로 보입니다(추정 task=${rec.task}, 역할=${rec.role}). ` +
      `직접 길게 생성하지 말고 'tokenlift ${rec.task} ...${provHint}' (${rec.provider}/${rec.model})로 ` +
      `사내 백엔드에 위임해 Bedrock 토큰을 절감하는 것을 우선 검토하세요. 생성물은 반드시 검토 후 ` +
      `통합하세요. 비민감 설계/복잡 디버깅은 조언자(Claude)가 직접, 기밀은 항상 사내에서.`;
    // UserPromptSubmit: stdout 텍스트가 컨텍스트로 추가됨
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: hint,
        },
      })
    );
  } else if (secWarn) {
    // 위임 task 미분류라도 기밀이면 경고만 주입(라우터가 사내 executor 를 권고한 상태)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: secWarn },
      })
    );
  }
  process.exit(0);
} catch {
  // 훅 오류는 사용자 작업을 방해하지 않는다
  process.exit(0);
}
