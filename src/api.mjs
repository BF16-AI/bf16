import {
  API_ORIGIN,
  CLI_VERSION,
  CREDITS_URL,
  FALLBACK_MODELS,
  OPENAI_BASE_URL,
} from './constants.mjs';

const USER_AGENT = `bf16-cli/${CLI_VERSION}`;

export async function fetchMe(apiKey, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: json?.error?.message || json?.error || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      latencyMs,
      data: json,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchModels(apiKey = null, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const headers = { 'User-Agent': USER_AGENT };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        models: FALLBACK_MODELS,
        fromFallback: true,
      };
    }
    const json = await res.json();
    const rawItems = Array.isArray(json?.data) ? json.data : [];
    const fallbackById = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));

    const normalized = rawItems.map((item) => {
      const fb = fallbackById.get(item.id);
      const pricing = item.pricing || {};
      const parsePerMillion = (val, fallbackVal) => {
        if (typeof val === 'number' && Number.isFinite(val)) {
          return val < 0.01 && val > 0 ? val * 1_000_000 : val;
        }
        if (typeof val === 'string' && val.trim() !== '') {
          const parsed = Number(val);
          if (Number.isFinite(parsed)) {
            return parsed < 0.01 && parsed > 0 ? parsed * 1_000_000 : parsed;
          }
        }
        return fallbackVal ?? null;
      };

      return {
        id: item.id,
        name: item.name || fb?.name || item.id,
        contextWindow:
          item.context_length ||
          item.context_window ||
          fb?.contextWindow ||
          1048576,
        maxOutputTokens:
          item.max_output_tokens ||
          item.top_provider?.max_completion_tokens ||
          fb?.maxOutputTokens ||
          131072,
        inputPerMillion: parsePerMillion(
          pricing.prompt ?? item.input_price_per_million,
          fb?.inputPerMillion
        ),
        cachedInputPerMillion: parsePerMillion(
          pricing.input_cache_read ?? item.cached_input_price_per_million,
          fb?.cachedInputPerMillion
        ),
        outputPerMillion: parsePerMillion(
          pricing.completion ?? item.output_price_per_million,
          fb?.outputPerMillion
        ),
        supportsVision: Boolean(
          item.supports_vision ??
            item.architecture?.input_modalities?.includes('image') ??
            fb?.supportsVision
        ),
        supportsReasoning: Boolean(
          item.supports_reasoning ?? fb?.supportsReasoning ?? true
        ),
        supportsTools: Boolean(
          item.supports_tools ?? fb?.supportsTools ?? true
        ),
      };
    });

    return {
      ok: true,
      status: res.status,
      latencyMs,
      models: normalized.length > 0 ? normalized : FALLBACK_MODELS,
      fromFallback: normalized.length === 0,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || err),
      models: FALLBACK_MODELS,
      fromFallback: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function measureStreamingCompletion({
  apiKey,
  baseUrl = OPENAI_BASE_URL,
  model,
  prompt,
  maxTokens = 160,
  extraHeaders = {},
  timeoutMs = 45000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let ttftMs = null;
  let content = '';
  let reasoning = '';
  let usage = null;
  let chunks = 0;

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: errText.slice(0, 200) || `HTTP ${res.status}`,
      };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, status: res.status, error: 'Empty response stream' };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.usage) {
          usage = evt.usage;
        }
        const delta = evt.choices?.[0]?.delta;
        if (delta) {
          const piece = delta.content || '';
          const rPiece = delta.reasoning_content || delta.reasoning || '';
          if ((piece || rPiece) && ttftMs === null) {
            ttftMs = performance.now() - started;
          }
          if (piece) {
            content += piece;
            chunks += 1;
          }
          if (rPiece) {
            reasoning += rPiece;
            chunks += 1;
          }
        }
      }
    }

    const totalMs = performance.now() - started;
    const outputTokens =
      usage?.completion_tokens ||
      Math.max(1, Math.round((content.length + reasoning.length) / 4));
    const genSeconds = Math.max(0.05, (totalMs - (ttftMs ?? totalMs * 0.2)) / 1000);
    const tokPerSec = outputTokens / genSeconds;

    return {
      ok: true,
      status: res.status,
      ttftMs: Math.round(ttftMs ?? totalMs),
      totalMs: Math.round(totalMs),
      outputTokens,
      tokPerSec: Math.round(tokPerSec * 10) / 10,
      chunks,
      usage,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.name === 'AbortError' ? 'Timed out' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function getTopUpHint(statusOrBalance) {
  if (statusOrBalance === 402 || (typeof statusOrBalance === 'number' && statusOrBalance < 0.1)) {
    return `Top up credits in seconds (pay-as-you-go, never expires): ${CREDITS_URL}`;
  }
  return null;
}

export { API_ORIGIN, OPENAI_BASE_URL };
