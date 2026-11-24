export const CLI_VERSION = '1.0.0';

export const API_ORIGIN = (
  process.env.BF16_API_ORIGIN || 'https://api.bf16.ai'
).replace(/\/+$/, '');

export const APP_ORIGIN = (
  process.env.BF16_APP_ORIGIN || 'https://bf16.ai'
).replace(/\/+$/, '');

export const OPENAI_BASE_URL = `${API_ORIGIN}/v1`;
export const CREDITS_URL = `${APP_ORIGIN}/dashboard/credits`;
export const KEYS_URL = `${APP_ORIGIN}/dashboard/keys`;
export const REFERRALS_URL = `${APP_ORIGIN}/dashboard/referrals`;
export const CLI_AUTH_URL = `${APP_ORIGIN}/cli-auth`;
export const DOCS_CLIENTS_URL = `${APP_ORIGIN}/docs/clients`;

export const DEFAULT_MAIN_MODEL = 'zai-org/glm-5.3-uncensored';
export const DEFAULT_FLASH_VISION_MODEL = 'zai-org/glm-5.3-flash-uncensored';
export const DEFAULT_FAST_MODEL = 'deepseek/deepseek-v4.1-flash-uncensored';
export const DEFAULT_FAST_TURBO_MODEL =
  'deepseek/deepseek-v4.1-flash-uncensored-fast';
export const DEFAULT_PRO_MODEL = 'moonshotai/kimi-k3.1-pro-uncensored';
export const DEFAULT_EXL3_MODEL = 'bf16/deepseek-v4.1-flash-1017-exl3-2.5bpw';

export const MODEL_ALIASES = {
  main: DEFAULT_MAIN_MODEL,
  glm: DEFAULT_MAIN_MODEL,
  flagship: DEFAULT_MAIN_MODEL,
  flash: DEFAULT_FLASH_VISION_MODEL,
  vision: DEFAULT_FLASH_VISION_MODEL,
  fast: DEFAULT_FAST_MODEL,
  turbo: DEFAULT_FAST_TURBO_MODEL,
  deepseek: DEFAULT_FAST_MODEL,
  pro: DEFAULT_PRO_MODEL,
  kimi: DEFAULT_PRO_MODEL,
  exl3: DEFAULT_EXL3_MODEL,
  auto: 'bf16/auto',
  'auto:fast': 'bf16/auto:fast',
  'auto:coding': 'bf16/auto:coding',
  'auto:reasoning': 'bf16/auto:reasoning',
};

/**
 * Fallback catalog metadata used when offline or before `/v1/models` is fetched.
 * Pricing is USD per 1M tokens (input / cached input / output).
 */
export const FALLBACK_MODELS = [
  {
    id: DEFAULT_MAIN_MODEL,
    name: 'Uncensored GLM-5.3',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    inputPerMillion: 1.35,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 4.2,
    supportsVision: false,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'flagship',
  },
  {
    id: DEFAULT_FLASH_VISION_MODEL,
    name: 'Uncensored GLM-5.3 Flash Vision',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    inputPerMillion: 0.3,
    cachedInputPerMillion: 0.065,
    outputPerMillion: 1.12,
    supportsVision: true,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'flash',
  },
  {
    id: DEFAULT_FAST_MODEL,
    name: 'Uncensored DeepSeek V4.1 Flash',
    contextWindow: 1048576,
    maxOutputTokens: 130000,
    inputPerMillion: 0.26,
    cachedInputPerMillion: 0.045,
    outputPerMillion: 1.0,
    supportsVision: true,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'fast',
  },
  {
    id: DEFAULT_FAST_TURBO_MODEL,
    name: 'Uncensored DeepSeek V4.1 Flash Fast',
    contextWindow: 1048576,
    maxOutputTokens: 130000,
    inputPerMillion: 0.28,
    cachedInputPerMillion: 0.055,
    outputPerMillion: 1.12,
    supportsVision: true,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'fast',
  },
  {
    id: DEFAULT_EXL3_MODEL,
    name: 'Uncensored DeepSeek V4.1 EXL3',
    contextWindow: 524288,
    maxOutputTokens: 130000,
    inputPerMillion: 0.2548,
    cachedInputPerMillion: 0.0441,
    outputPerMillion: 0.98,
    supportsVision: true,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'fast',
  },
  {
    id: DEFAULT_PRO_MODEL,
    name: 'Uncensored Kimi K3.1 Pro (2.8T)',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    inputPerMillion: 1.95,
    cachedInputPerMillion: 0.28,
    outputPerMillion: 6.9,
    supportsVision: true,
    supportsReasoning: true,
    supportsTools: true,
    tier: 'pro',
  },
];

export const REFERENCE_PRICING = {
  claudeSonnet: {
    name: 'Claude Sonnet 4.6',
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
  },
  claudeOpus: {
    name: 'Claude Opus 4.6',
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 25.0,
  },
  gpt5: {
    name: 'GPT-5.4',
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15.0,
  },
};

export function resolveModelId(input) {
  if (!input) return DEFAULT_MAIN_MODEL;
  const trimmed = String(input).trim();
  const lower = trimmed.toLowerCase();
  return MODEL_ALIASES[lower] || trimmed;
}
