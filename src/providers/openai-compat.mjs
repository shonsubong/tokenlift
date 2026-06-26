// providers/openai-compat.mjs
// OpenAI 호환 추론 백엔드 어댑터.
// 대상: NVIDIA NemoClaw/NIM, vLLM, TensorRT-LLM, TGI, llama.cpp(server), LocalAI 등
// /v1/chat/completions · /v1/completions(FIM) · /v1/models 표준을 따른다.
import { eprint } from '../util.mjs';

class ProviderError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.cause = cause;
  }
}

function resolveApiKey(profile) {
  if (profile.apiKey) return profile.apiKey;
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) return process.env[profile.apiKeyEnv];
  return null;
}

function headers(profile) {
  const h = { 'content-type': 'application/json' };
  const key = resolveApiKey(profile);
  if (key) h['authorization'] = `Bearer ${key}`;
  // NIM/NemoClaw 일부 게이트웨이는 추가 헤더를 요구할 수 있음
  if (profile.extraHeaders && typeof profile.extraHeaders === 'object') {
    Object.assign(h, profile.extraHeaders);
  }
  return h;
}

function friendlyError(profile, url, err) {
  if (err.name === 'AbortError') {
    return new ProviderError(`요청 타임아웃. 온프렘 모델 콜드 로드가 느릴 수 있습니다. --timeout 으로 늘리세요.`, { code: 'ETIMEOUT' });
  }
  if (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
    return new ProviderError(
      `'${profile.name}' 엔드포인트(${url})에 연결할 수 없습니다.\n` +
        `  - 호스트/포트 확인(config.providers.${profile.name}.host)\n` +
        `  - NIM/추론 서버가 기동되어 /v1 을 노출하는지 확인`,
      { code: 'ECONN', cause: err }
    );
  }
  return err instanceof ProviderError ? err : new ProviderError(`호출 실패: ${err.message}`, { cause: err });
}

async function postJson(profile, url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(profile),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          `인증 실패(${res.status}). API 키를 확인하세요` +
            (profile.apiKeyEnv ? ` (환경변수 ${profile.apiKeyEnv}).` : '.'),
          { code: 'EAUTH' }
        );
      }
      throw new ProviderError(`API ${res.status}: ${text.slice(0, 300)}`, { code: 'EHTTP' });
    }
    return await res.json();
  } catch (err) {
    throw friendlyError(profile, url, err);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAICompatProvider(profile) {
  const base = String(profile.host || '').replace(/\/$/, '') + (profile.apiPath || '/v1');
  const sampling = profile.sampling || {}; // provider 권장 샘플링 기본값(GLM 등)

  // 샘플링 파라미터를 요청 body 에 적용한다. 우선순위: 호출 options > profile.sampling.
  // (GLM-5.2 권장값 temp=1.0/top_p=0.95/top_k=40 같은 모델별 기본값을 provider 에 둘 수 있게 함)
  function applySampling(body, options) {
    const temp = options.temperature ?? sampling.temperature;
    if (temp != null) body.temperature = temp;
    const topP = options.top_p ?? sampling.top_p;
    if (topP != null) body.top_p = topP;
    const topK = options.top_k ?? sampling.top_k;
    if (topK != null) body.top_k = topK;
    const minP = options.min_p ?? sampling.min_p;
    if (minP != null) body.min_p = minP;
    const rp = options.repeat_penalty ?? sampling.repeat_penalty;
    if (rp != null) body.repeat_penalty = rp;
    if (options.num_predict != null) body.max_tokens = options.num_predict;
    // 추론(thinking) 토글 등 비표준 파라미터 — llama-server/vLLM 의 확장 필드.
    if (options.chat_template_kwargs) body.chat_template_kwargs = options.chat_template_kwargs;
    if (options.reasoning_format) body.reasoning_format = options.reasoning_format;
  }

  // provider 고정 추가 필드(extraBody)를 병합한다. 호출별 body 가 이미 가진 키는 덮어쓰지 않는다.
  function mergeExtraBody(body) {
    if (profile.extraBody && typeof profile.extraBody === 'object') {
      for (const [k, v] of Object.entries(profile.extraBody)) {
        if (!(k in body)) body[k] = v;
      }
    }
  }

  // GLM/DeepSeek 계열은 thinking 을 message.reasoning_content 로 분리해 반환한다.
  // 정상 응답이면 content 가 최종 답. content 가 비고 reasoning_content 만 온 경우만 폴백.
  function pickContent(msg) {
    const content = msg?.content;
    if (content != null && content !== '') return content;
    if (msg?.reasoning_content) return msg.reasoning_content;
    return content ?? '';
  }

  async function chat({ model, messages, options = {}, timeoutMs }) {
    const t0 = performance.now();
    const body = { model, messages, stream: false };
    applySampling(body, options);
    mergeExtraBody(body);
    const j = await postJson(profile, base + '/chat/completions', body, timeoutMs);
    const choice = j.choices?.[0];
    return {
      content: pickContent(choice?.message),
      inTokens: j.usage?.prompt_tokens ?? 0,
      outTokens: j.usage?.completion_tokens ?? 0,
      durationMs: Math.round(performance.now() - t0),
      model: j.model ?? model,
      raw: j,
    };
  }

  async function generate({ model, prompt, suffix, options = {}, timeoutMs }) {
    // 레거시 /v1/completions (FIM: suffix). 일부 NIM/모델은 미지원 → 호출 실패 시 안내.
    const t0 = performance.now();
    const body = { model, prompt, stream: false };
    if (suffix != null && suffix !== '') body.suffix = suffix;
    applySampling(body, options);
    mergeExtraBody(body);
    const j = await postJson(profile, base + '/completions', body, timeoutMs);
    const choice = j.choices?.[0];
    return {
      content: choice?.text ?? '',
      inTokens: j.usage?.prompt_tokens ?? 0,
      outTokens: j.usage?.completion_tokens ?? 0,
      durationMs: Math.round(performance.now() - t0),
      model: j.model ?? model,
      raw: j,
    };
  }

  async function listModels({ timeoutMs = 10000 } = {}) {
    // 수동 모델 목록이 설정되어 있으면 그대로 사용(/v1/models 미지원 게이트웨이 대비)
    if (Array.isArray(profile.models) && profile.models.length) {
      return profile.models.map((n) => ({ name: n }));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + '/models', { headers: headers(profile), signal: ctrl.signal });
      if (!res.ok) throw new ProviderError(`API ${res.status}`, { code: 'EHTTP' });
      const j = await res.json();
      return (j.data || []).map((m) => ({ name: m.id, family: m.owned_by }));
    } catch (err) {
      throw friendlyError(profile, base + '/models', err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function warmup({ model, timeoutMs = 600000 }) {
    const t0 = performance.now();
    await chat({ model, messages: [{ role: 'user', content: 'ok' }], options: { num_predict: 1 }, timeoutMs });
    return { model, loaded: true, durationMs: Math.round(performance.now() - t0) };
  }

  async function ping({ timeoutMs = 5000 } = {}) {
    try {
      await listModels({ timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  return {
    name: profile.name,
    type: 'openai-compat',
    supportsFIM: !!profile.supportsFIM,
    chat,
    generate,
    listModels,
    warmup,
    ping,
  };
}

export { ProviderError };
