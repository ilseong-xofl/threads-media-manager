import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export const publicFiles = ['index.html', 'styles.css', 'app.mjs', 'probe.mjs'];
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};
export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://graph.threads.com; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};

/** A file-only server. It has no request body handling, outbound HTTP, or API routes. */
export function createStaticServer({ root = directory, tls } = {}) {
  const handler = async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    // Exact allowlist: queries, encoded paths, traversal, dotfiles and API paths are never served.
    const filename = request.url === '/' ? 'index.html' : request.url?.slice(1);
    if (!publicFiles.includes(filename)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(join(root, filename));
      const extension = filename.slice(filename.lastIndexOf('.'));
      response.writeHead(200, { 'Content-Type': mime[extension], 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  };
  return tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--port', '--host', '--cert', '--key', '--root'].includes(key) || !args[i + 1])
      throw new Error('invalid_arguments');
    options[key.slice(2)] = args[i + 1];
  }
  const port = Number(options.port ?? 4187);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    Boolean(options.cert) !== Boolean(options.key)
  )
    throw new Error('invalid_arguments');
  const tls = options.cert
    ? { cert: await readFile(options.cert), key: await readFile(options.key) }
    : undefined;
  const server = createStaticServer({
    root: options.root ? resolve(options.root) : directory,
    tls,
  });
  const host = options.host ?? '127.0.0.1';
  server.on('error', () => {
    process.stderr.write('검증 웹을 시작하지 못했습니다. 포트와 인증서 설정을 확인하세요.\n');
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`검증 화면: ${tls ? 'https' : 'http'}://${host}:${port}\n`);
    if (!tls)
      process.stdout.write(
        'HTTP는 화면 미리보기 전용입니다. 실제 호출에는 안드로이드와 신뢰할 수 있는 HTTPS가 필요합니다.\n',
      );
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      '사용법: node serve.mjs [--port 4187] [--host 127.0.0.1] [--cert 인증서] [--key 개인키] [--root 정적파일폴더]\n',
    );
    process.exitCode = 1;
  });
}
