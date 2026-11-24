import {
  FALLBACK_MODELS,
  REFERENCE_PRICING,
  resolveModelId,
} from './constants.mjs';
import { fetchModels } from './api.mjs';
import { resolveApiKey } from './credentials.mjs';
import {
  c,
  formatContext,
  formatUsd,
  printHeader,
  printInfo,
  renderTable,
} from './ui.mjs';

export function calculateCost({
  inputTokens = 100_000,
  outputTokens = 10_000,
  cacheHitRatio = 0.75,
  inputPerMillion,
  cachedInputPerMillion,
  outputPerMillion,
}) {
  const ratio = Math.max(0, Math.min(1, Number(cacheHitRatio) || 0));
  const cachedTokens = inputTokens * ratio;
  const freshTokens = inputTokens - cachedTokens;
  const effectiveCachedPrice =
    cachedInputPerMillion != null ? cachedInputPerMillion : inputPerMillion;

  const freshUsd = (freshTokens / 1_000_000) * inputPerMillion;
  const cachedUsd = (cachedTokens / 1_000_000) * effectiveCachedPrice;
  const outputUsd = (outputTokens / 1_000_000) * outputPerMillion;
  return {
    totalUsd: freshUsd + cachedUsd + outputUsd,
    freshUsd,
    cachedUsd,
    outputUsd,
  };
}

export async function runModels({ flagKey = null, json = false } = {}) {
  const resolved = resolveApiKey({ flagKey });
  const res = await fetchModels(resolved.key);

  if (json) {
    console.log(JSON.stringify({ live: !res.fromFallback, models: res.models }, null, 2));
    return;
  }

  printHeader(
    'models',
    res.fromFallback
      ? 'Offline catalog snapshot (set network access for live pricing)'
      : `Live catalog from api.bf16.ai (${res.latencyMs}ms · Zero Data Retention)`
  );
  console.log('');

  const rows = res.models.map((m) => {
    const caps = [
      m.supportsTools ? 'tools' : null,
      m.supportsReasoning ? 'think' : null,
      m.supportsVision ? 'vision' : null,
    ]
      .filter(Boolean)
      .join(',');

    return [
      c.cyan(m.id),
      formatContext(m.contextWindow),
      m.inputPerMillion != null
        ? formatUsd(m.inputPerMillion, 3)
        : m.id.startsWith('bf16/auto')
          ? c.dim('auto')
          : '-',
      m.cachedInputPerMillion != null
        ? formatUsd(m.cachedInputPerMillion, 3)
        : m.id.startsWith('bf16/auto')
          ? c.dim('auto')
          : '-',
      m.outputPerMillion != null
        ? formatUsd(m.outputPerMillion, 2)
        : m.id.startsWith('bf16/auto')
          ? c.dim('auto')
          : '-',
      c.dim(caps || '-'),
    ];
  });

  console.log(
    renderTable(
      ['Model ID', 'Ctx', 'In /1M', 'Cache /1M', 'Out /1M', 'Capabilities'],
      rows,
      ['left', 'right', 'right', 'right', 'right', 'left']
    )
  );
  console.log('');
  printInfo(`Quick launch: ${c.cyan('npx bf16ai claude')} or ${c.cyan('npx bf16ai claude --fast')}`);
  console.log('');
}

export async function runCost({
  modelArg = null,
  inputTokens = 500_000,
  outputTokens = 25_000,
  cacheRatio = 0.8,
  json = false,
} = {}) {
  const res = await fetchModels(null, { timeoutMs: 4000 });
  const models = res.models.length > 0 ? res.models : FALLBACK_MODELS;
  const resolvedId = resolveModelId(modelArg || 'main');
  const selected =
    models.find((m) => m.id === resolvedId) ||
    FALLBACK_MODELS.find((m) => m.id === resolvedId) ||
    FALLBACK_MODELS[0];

  const bf16Cost = calculateCost({
    inputTokens,
    outputTokens,
    cacheHitRatio: cacheRatio,
    inputPerMillion: selected.inputPerMillion ?? 1.35,
    cachedInputPerMillion: selected.cachedInputPerMillion ?? 0.25,
    outputPerMillion: selected.outputPerMillion ?? 4.2,
  });

  const sonnetCost = calculateCost({
    inputTokens,
    outputTokens,
    cacheHitRatio: cacheRatio,
    ...REFERENCE_PRICING.claudeSonnet,
  });

  const opusCost = calculateCost({
    inputTokens,
    outputTokens,
    cacheHitRatio: cacheRatio,
    ...REFERENCE_PRICING.claudeOpus,
  });

  const gptCost = calculateCost({
    inputTokens,
    outputTokens,
    cacheHitRatio: cacheRatio,
    ...REFERENCE_PRICING.gpt5,
  });

  const savingsVsSonnetPct =
    sonnetCost.totalUsd > 0
      ? Math.round((1 - bf16Cost.totalUsd / sonnetCost.totalUsd) * 100)
      : 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          workload: { inputTokens, outputTokens, cacheRatio },
          model: selected.id,
          bf16Usd: Number(bf16Cost.totalUsd.toFixed(4)),
          comparisons: {
            claudeSonnetUsd: Number(sonnetCost.totalUsd.toFixed(4)),
            claudeOpusUsd: Number(opusCost.totalUsd.toFixed(4)),
            gpt5Usd: Number(gptCost.totalUsd.toFixed(4)),
            savingsVsSonnetPct,
          },
        },
        null,
        2
      )
    );
    return;
  }

  printHeader(
    'cost',
    `Workload: ${inputTokens.toLocaleString()} input (${Math.round(cacheRatio * 100)}% cached) + ${outputTokens.toLocaleString()} output tokens`
  );
  console.log('');

  const rows = [
    [
      c.bold(c.cyan(selected.id)),
      formatUsd(selected.inputPerMillion ?? 0, 3),
      formatUsd(selected.cachedInputPerMillion ?? 0, 3),
      formatUsd(selected.outputPerMillion ?? 0, 2),
      c.bold(c.green(formatUsd(bf16Cost.totalUsd, 4))),
      c.green('baseline'),
    ],
    [
      REFERENCE_PRICING.claudeSonnet.name,
      formatUsd(REFERENCE_PRICING.claudeSonnet.inputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.claudeSonnet.cachedInputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.claudeSonnet.outputPerMillion, 2),
      formatUsd(sonnetCost.totalUsd, 4),
      `${savingsVsSonnetPct}% saved on bf16`,
    ],
    [
      REFERENCE_PRICING.gpt5.name,
      formatUsd(REFERENCE_PRICING.gpt5.inputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.gpt5.cachedInputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.gpt5.outputPerMillion, 2),
      formatUsd(gptCost.totalUsd, 4),
      `${Math.round((1 - bf16Cost.totalUsd / gptCost.totalUsd) * 100)}% saved`,
    ],
    [
      REFERENCE_PRICING.claudeOpus.name,
      formatUsd(REFERENCE_PRICING.claudeOpus.inputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.claudeOpus.cachedInputPerMillion, 2),
      formatUsd(REFERENCE_PRICING.claudeOpus.outputPerMillion, 2),
      formatUsd(opusCost.totalUsd, 4),
      `${Math.round((1 - bf16Cost.totalUsd / opusCost.totalUsd) * 100)}% saved`,
    ],
  ];

  console.log(
    renderTable(
      ['Model', 'In /1M', 'Cache /1M', 'Out /1M', 'Est. Cost', 'Delta'],
      rows,
      ['left', 'right', 'right', 'right', 'right', 'left']
    )
  );
  console.log('');
}
