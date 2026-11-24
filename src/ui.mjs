const USE_COLOR =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function wrap(code, text) {
  if (!USE_COLOR) return String(text);
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const c = {
  bold: (s) => wrap('1', s),
  dim: (s) => wrap('2', s),
  red: (s) => wrap('31', s),
  green: (s) => wrap('32', s),
  yellow: (s) => wrap('33', s),
  blue: (s) => wrap('34', s),
  magenta: (s) => wrap('35', s),
  cyan: (s) => wrap('36', s),
  gray: (s) => wrap('90', s),
};

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '(none)';
  const trimmed = key.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}****`;
  return `${trimmed.slice(0, 11)}••••${trimmed.slice(-4)}`;
}

export function formatUsd(amount, digits = 2) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toFixed(digits)}`;
}

export function formatContext(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1000000) return `${Math.round((n / 1048576) * 10) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1024)}K`;
  return String(n);
}

export function padRight(str, len) {
  const raw = String(str);
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length >= len) return raw;
  return raw + ' '.repeat(len - plain.length);
}

export function padLeft(str, len) {
  const raw = String(str);
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length >= len) return raw;
  return ' '.repeat(len - plain.length) + raw;
}

export function renderTable(headers, rows, alignments = []) {
  const widths = headers.map((h, i) => {
    const cellWidths = rows.map(
      (r) => String(r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length
    );
    return Math.max(h.length, ...cellWidths);
  });

  const formatRow = (cols) =>
    cols
      .map((val, i) =>
        alignments[i] === 'right'
          ? padLeft(val ?? '', widths[i])
          : padRight(val ?? '', widths[i])
      )
      .join('  ');

  const lines = [
    c.bold(formatRow(headers)),
    c.dim(widths.map((w) => '─'.repeat(w)).join('──')),
    ...rows.map((r) => formatRow(r)),
  ];
  return lines.join('\n');
}

export function printHeader(title, subtitle = '') {
  console.log('');
  console.log(`${c.bold(c.cyan('bf16'))} ${c.bold(title)}`);
  if (subtitle) {
    console.log(c.dim(subtitle));
  }
}

export function printOk(msg) {
  console.log(`  ${c.green('✓')} ${msg}`);
}

export function printWarn(msg) {
  console.log(`  ${c.yellow('!')} ${msg}`);
}

export function printErr(msg) {
  console.error(`  ${c.red('✗')} ${msg}`);
}

export function printInfo(msg) {
  console.log(`  ${c.cyan('•')} ${msg}`);
}
