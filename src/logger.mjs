// logger.mjs - 사용량 기록(JSONL) 및 절감액 추정
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, ensureDir, fmtUsd } from './util.mjs';

/**
 * Bedrock 단가로 환산한 "대체 처리 비용" 추정.
 * 로컬 Ollama 가 처리한 토큰(in/out)을 Bedrock 가 처리했다면 들었을 비용.
 * 주의: 총량(gross) 추정치. Claude 가 결과를 다시 읽는 소량의 재읽기 비용은 별도.
 */
export function estimateSavings({ inTokens = 0, outTokens = 0, pricing }) {
  const inUsd = (inTokens * (pricing?.inputPer1M ?? 0)) / 1e6;
  const outUsd = (outTokens * (pricing?.outputPer1M ?? 0)) / 1e6;
  return {
    inTokens,
    outTokens,
    inputUsd: inUsd,
    outputUsd: outUsd,
    grossUsd: inUsd + outUsd,
    label: pricing?.label ?? 'bedrock',
  };
}

/** 사용 기록 1건 append */
export function logUsage(entry, config) {
  if (!config?.logging?.enabled) return;
  try {
    const file = expandHome(config.logging.file || '~/.tokenlift/usage.jsonl');
    ensureDir(path.dirname(file));
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // 로깅 실패는 무시 (본 작업을 방해하지 않음)
  }
}

/** 누적 통계 집계 */
export function readStats(config) {
  const file = expandHome(config?.logging?.file || '~/.tokenlift/usage.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { count: 0, file, entries: [] };
  }
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM (이번 달)
  const agg = {
    count: entries.length,
    file,
    inTokens: 0,
    outTokens: 0,
    grossUsd: 0,
    byTask: {},
    byModel: {},
    byProvider: {},
    month: { key: monthKey, count: 0, grossUsd: 0, inTokens: 0, outTokens: 0 },
  };
  for (const e of entries) {
    agg.inTokens += e.inTokens || 0;
    agg.outTokens += e.outTokens || 0;
    agg.grossUsd += e.grossUsd || 0;
    if (typeof e.ts === 'string' && e.ts.startsWith(monthKey)) {
      agg.month.count++;
      agg.month.grossUsd += e.grossUsd || 0;
      agg.month.inTokens += e.inTokens || 0;
      agg.month.outTokens += e.outTokens || 0;
    }
    if (e.task) {
      agg.byTask[e.task] = agg.byTask[e.task] || { count: 0, grossUsd: 0 };
      agg.byTask[e.task].count++;
      agg.byTask[e.task].grossUsd += e.grossUsd || 0;
    }
    if (e.model) {
      agg.byModel[e.model] = (agg.byModel[e.model] || 0) + 1;
    }
    const prov = e.provider || 'ollama';
    agg.byProvider[prov] = agg.byProvider[prov] || { count: 0, grossUsd: 0 };
    agg.byProvider[prov].count++;
    agg.byProvider[prov].grossUsd += e.grossUsd || 0;
  }
  return agg;
}

/** 통계를 사람이 읽기 좋은 문자열로. config 를 주면 월 예산 대비 지표를 함께 표시. */
export function formatStats(agg, config) {
  if (agg.count === 0) return `기록 없음 (${agg.file})`;
  const lines = [];
  lines.push(`# TokenLift 누적 위임 통계`);
  lines.push(`로그: ${agg.file}`);
  lines.push(`총 위임 횟수: ${agg.count}`);
  lines.push(`로컬 처리 토큰: 입력 ${agg.inTokens.toLocaleString()} / 출력 ${agg.outTokens.toLocaleString()}`);
  lines.push(`Bedrock 환산 대체비용(누적, gross): ${fmtUsd(agg.grossUsd)}`);
  const budget = config?.pricing?.monthlyBudgetUsd;
  if (agg.month) {
    lines.push('');
    lines.push(`이번 달(${agg.month.key}): 위임 ${agg.month.count}회, Bedrock 환산 절감 ${fmtUsd(agg.month.grossUsd)}`);
    if (budget > 0) {
      const pct = Math.round((agg.month.grossUsd / budget) * 100);
      lines.push(`월 Bedrock 예산: ${fmtUsd(budget)} — 위임이 없었다면 예산의 약 ${pct}% 를 추가 소비했을 양을 사내에서 처리`);
      lines.push(`  (실제 Bedrock 소비는 Claude Code 의 /cost 로 확인. 예산 초과 조짐이면 위임 비중을 더 높일 것)`);
    }
  }
  lines.push('');
  lines.push('백엔드(provider)별:');
  for (const [p, v] of Object.entries(agg.byProvider).sort((a, b) => b[1].grossUsd - a[1].grossUsd)) {
    lines.push(`  - ${p}: ${v.count}회, ${fmtUsd(v.grossUsd)}`);
  }
  lines.push('태스크별:');
  for (const [t, v] of Object.entries(agg.byTask).sort((a, b) => b[1].grossUsd - a[1].grossUsd)) {
    lines.push(`  - ${t}: ${v.count}회, ${fmtUsd(v.grossUsd)}`);
  }
  lines.push('모델별 호출:');
  for (const [m, c] of Object.entries(agg.byModel).sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${m}: ${c}회`);
  }
  return lines.join('\n');
}
