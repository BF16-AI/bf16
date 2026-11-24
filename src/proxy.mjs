import http from 'node:http';
import {
  API_ORIGIN,
  CLI_VERSION,
  CREDITS_URL,
  DEFAULT_FAST_TURBO_MODEL,
  DEFAULT_MAIN_MODEL,
  resolveModelId,
} from './constants.mjs';
import { ensureApiKey } from './auth.mjs';
import { c, printHeader, printInfo, printOk, printWarn } from './ui.mjs';

/**
 * Smart routing heuristic for `bf16/smart` model alias:
 * Routes short/simple requests to the ultra-fast Flash tier and longer,
 * multi-file, or reasoning-heavy prompts to the flagship 1M model.
 */
export function selectSmartModel(body, { fastModel, proModel }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let charCount = 0;
  for (const msg of messages) {
    if (typeof msg?.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (typeof part?.text === 'string') charCount += part.text.length;
      }
    }
  }
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const wantsReasoning = Boolean(body?.reasoning || body?.thinking);
  if (wantsReasoning || charCount > 16_000 || (hasTools && messages.length > 8)) {
    return proModel;
  }
  return fastModel;
}

export function createLocalProxyServer({
  apiKey,
  fastModel = DEFAULT_FAST_TURBO_MODEL,
  proModel = DEFAULT_MAIN_MODEL,
  onLog = () => {},
}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const targetPath = req.url || '/v1/models';
    const upstreamUrl = `${API_ORIGIN}${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`;

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let bodyBuf = Buffer.concat(chunks);
    let routedModel = null;

    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (
      req.method === 'POST' &&
      bodyBuf.length > 0 &&
      contentType.includes('application/json')
    ) {
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        if (parsed?.model === 'bf16/smart' || parsed?.model === 'smart') {
          routedModel = selectSmartModel(parsed, { fastModel, proModel });
          parsed.model = routedModel;
          bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
        } else if (typeof parsed?.model === 'string') {
          routedModel = parsed.model;
        }
      } catch {
        // Forward raw bytes if non-JSON
      }
    }

    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'connection' ||
        lower === 'authorization' ||
        lower === 'x-api-key'
      ) {
        continue;
      }
      if (v !== undefined) forwardHeaders[k] = v;
    }

    // Preserve Anthropic vs OpenAI auth convention seamlessly
    if (targetPath.startsWith('/v1/messages')) {
      forwardHeaders['x-api-key'] = apiKey;
      forwardHeaders.authorization = `Bearer ${apiKey}`;
    } else {
      forwardHeaders.authorization = `Bearer ${apiKey}`;
    }
    forwardHeaders['user-agent'] = `bf16-proxy/${CLI_VERSION}`;

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: forwardHeaders,
        body:
          req.method === 'GET' || req.method === 'HEAD' || bodyBuf.length === 0
            ? undefined
            : bodyBuf,
      });

      const outHeaders = {};
      upstreamRes.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'connection') {
          return;
        }
        outHeaders[key] = value;
      });
      if (routedModel) {
        outHeaders['x-bf16-routed-model'] = routedModel;
      }

      res.writeHead(upstreamRes.status, outHeaders);

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();

      onLog({
        method: req.method,
        path: targetPath,
        status: upstreamRes.status,
        model: routedModel,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            type: 'proxy_error',
            message: String(err?.message || err),
          },
        })
      );
      onLog({
        method: req.method,
        path: targetPath,
        status: 502,
        model: routedModel,
        latencyMs: Date.now() - started,
        error: String(err?.message || err),
      });
    }
  });
}

export async function runProxy({
  flagKey = null,
  ref = null,
  port = 4160,
  host = '127.0.0.1',
  fastModel = DEFAULT_FAST_TURBO_MODEL,
  proModel = DEFAULT_MAIN_MODEL,
} = {}) {
  const apiKey = await ensureApiKey({ flagKey, ref });
  const resolvedFast = resolveModelId(fastModel);
  const resolvedPro = resolveModelId(proModel);

  printHeader(
    'proxy',
    'Zero-logging local OpenAI + Anthropic routing proxy (never writes prompts to disk)'
  );

  const server = createLocalProxyServer({
    apiKey,
    fastModel: resolvedFast,
    proModel: resolvedPro,
    onLog: (evt) => {
      const statusText =
        evt.status >= 200 && evt.status < 300
          ? c.green(String(evt.status))
          : evt.status === 402
            ? c.yellow('402 LOW BAL')
            : c.red(String(evt.status));
      const ts = new Date().toLocaleTimeString();
      console.log(
        `  ${c.dim(ts)} ${statusText} ${evt.method} ${evt.path}` +
          (evt.model ? ` ${c.cyan(evt.model)}` : '') +
          ` ${c.dim(`${evt.latencyMs}ms`)}`
      );
      if (evt.status === 402) {
        printWarn(`Insufficient balance → top up instantly at ${c.cyan(CREDITS_URL)}`);
      }
    },
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(Number(port), host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  printOk(`Listening on ${c.bold(c.cyan(`http://${host}:${actualPort}/v1`))}`);
  printInfo(`Smart alias \`bf16/smart\` → fast: ${resolvedFast} · pro: ${resolvedPro}`);
  printInfo(`Press Ctrl+C to stop.`);
  console.log('');
}
