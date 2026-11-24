import {
  DEFAULT_FAST_MODEL,
  DEFAULT_FAST_TURBO_MODEL,
  DEFAULT_MAIN_MODEL,
  FALLBACK_MODELS,
  OPENAI_BASE_URL,
  resolveModelId,
} from './constants.mjs';
import { fetchModels, measureStreamingCompletion } from './api.mjs';
import { ensureApiKey } from './auth.mjs';
import {
  c,
  formatUsd,
  printHeader,
  printInfo,
  printWarn,
  renderTable,
} from './ui.mjs';

const DEFAULT_BENCH_PROMPT =
  'Write a clean 20-line TypeScript debounce function with AbortSignal support and a 1-sentence complexity note.';

export async function runBench({
  flagKey = null,
  ref = null,
  modelsArg = null,
  compare = false,
  prompt = DEFAULT_BENCH_PROMPT,
  maxTokens = 180,
  json = false,
} = {}) {
  const apiKey = await ensureApiKey({ flagKey, ref });
  const catalogRes = await fetchModels(apiKey, { timeoutMs: 5000 });
  const catalogById = new Map(
    (catalogRes.models.length > 0 ? catalogRes.models : FALLBACK_MODELS).map((m) => [
      m.id,
      m,
    ])
  );

  const bf16Models = modelsArg
    ? String(modelsArg)
        .split(',')
        .map((s) => resolveModelId(s.trim()))
        .filter(Boolean)
    : [DEFAULT_FAST_TURBO_MODEL, DEFAULT_FAST_MODEL, DEFAULT_MAIN_MODEL];

  const targets = bf16Models.map((id) => ({
    provider: 'bf16.ai',
    model: id,
    baseUrl: OPENAI_BASE_URL,
    apiKey,
    pricing: catalogById.get(id) || FALLBACK_MODELS.find((m) => m.id === id) || null,
  }));

  if (compare) {
    if (process.env.OPENROUTER_API_KEY) {
      targets.push({
        provider: 'openrouter (local)',
        model: 'deepseek/deepseek-chat',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        pricing: null,
      });
    }
    if (process.env.OPENAI_API_KEY) {
      targets.push({
        provider: 'openai (local)',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY,
        pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6 },
      });
    }
    if (targets.length === bf16Models.length && !json) {
      printWarn(
        'No external keys (OPENAI_API_KEY / OPENROUTER_API_KEY) found in env for --compare; benchmarking bf16.ai only.'
      );
    }
  }

  if (!json) {
    printHeader(
      'bench',
      `Live streaming latency & throughput from your network (max_tokens=${maxTokens} · Zero Data Retention)`
    );
    console.log('');
  }

  const results = [];
  for (const t of targets) {
    if (!json) {
      process.stdout.write(`  Running ${c.cyan(t.model)} (${t.provider})... `);
    }
    const r = await measureStreamingCompletion({
      apiKey: t.apiKey,
      baseUrl: t.baseUrl,
      model: t.model,
      prompt,
      maxTokens,
    });
    results.push({
      provider: t.provider,
      model: t.model,
      pricing: t.pricing,
      ...r,
    });
    if (!json) {
      if (r.ok) {
        console.log(c.green(`${r.ttftMs}ms TTFT · ${r.tokPerSec} tok/s`));
      } else {
        console.log(c.red(`failed (${r.status || 'err'})`));
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ prompt, maxTokens, results }, null, 2));
    return;
  }

  console.log('');
  const rows = results.map((r) => [
    r.provider === 'bf16.ai' ? c.cyan(r.model) : `${r.model} ${c.dim(`(${r.provider})`)}`,
    r.ok ? `${r.ttftMs} ms` : c.red('ERR'),
    r.ok ? c.bold(`${r.tokPerSec} tok/s`) : '-',
    r.ok ? `${r.outputTokens}` : '-',
    r.ok ? `${(r.totalMs / 1000).toFixed(2)}s` : c.dim(r.error?.slice(0, 32) || '-'),
    r.pricing?.inputPerMillion != null && r.pricing?.outputPerMillion != null
      ? `${formatUsd(r.pricing.inputPerMillion, 2)} / ${formatUsd(r.pricing.outputPerMillion, 2)}`
      : '-',
  ]);

  console.log(
    renderTable(
      ['Model', 'TTFT', 'Speed', 'Out Tok', 'Total', 'In/Out per 1M'],
      rows,
      ['left', 'right', 'right', 'right', 'right', 'right']
    )
  );
  console.log('');
  printInfo(
    `Launch fastest model in Claude Code: ${c.cyan(`npx bf16 claude --model ${bf16Models[0]}`)}`
  );
  console.log('');
}
