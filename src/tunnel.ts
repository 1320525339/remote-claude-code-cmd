import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import readline from 'readline';
import { execFile, spawn, ChildProcess } from 'child_process';

export interface QuickTunnelOptions {
  localPort: number;
  cloudflaredPath?: string;
  onUrl: (url: string) => void;
  onLog?: (message: string) => void;
  onError?: (error: Error) => void;
}

export interface QuickTunnelHandle {
  stop: () => void;
}

export interface CloudflaredDownloadSpec {
  fileName: string;
  url: string;
  archiveType?: 'tgz';
}

const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

export function startQuickTunnel(opts: QuickTunnelOptions): QuickTunnelHandle {
  let child: ChildProcess | null = null;
  let stopped = false;
  let resolved = false;

  void launch();

  return {
    stop: () => {
      stopped = true;
      if (child && !child.killed) child.kill();
    },
  };

  async function launch() {
    try {
      const binary = await resolveCloudflaredBinary(opts.cloudflaredPath);
      if (stopped) return;

      opts.onLog?.(`[rome] 使用 cloudflared: ${binary}`);
      const proc = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;

      const inspectLine = (line: string) => {
        const url = extractQuickTunnelUrl(line);
        if (url && !resolved) {
          resolved = true;
          opts.onUrl(toPublicWebSocketUrl(url));
          return;
        }
        if (!resolved && /\berror\b|\bfailed\b/i.test(line)) {
          opts.onLog?.(`[rome] cloudflared: ${line.trim()}`);
        }
      };

      if (!proc.stdout || !proc.stderr) {
        throw new Error('cloudflared did not expose stdout/stderr pipes');
      }

      pipeLines(proc.stdout, inspectLine);
      pipeLines(proc.stderr, inspectLine);

      proc.once('error', (error) => {
        if (stopped) return;
        opts.onError?.(error);
      });

      proc.once('exit', (code, signal) => {
        if (stopped) return;
        const reason = code !== null ? `exit code ${code}` : `signal ${signal || 'unknown'}`;
        if (!resolved) {
          opts.onError?.(new Error(`cloudflared exited before tunnel was ready (${reason})`));
          return;
        }
        opts.onLog?.(`[rome] Cloudflare Quick Tunnel 已停止 (${reason})`);
      });
    } catch (error: any) {
      if (stopped) return;
      opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export function toPublicWebSocketUrl(raw: string): string {
  if (raw.startsWith('wss://') || raw.startsWith('ws://')) return raw;
  if (raw.startsWith('https://')) return `wss://${raw.slice('https://'.length)}`;
  if (raw.startsWith('http://')) return `ws://${raw.slice('http://'.length)}`;
  throw new Error(`unsupported public URL protocol: ${raw}`);
}

export function extractQuickTunnelUrl(line: string): string | undefined {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0];
}

export function getCloudflaredDownloadSpec(platform: NodeJS.Platform, arch: string): CloudflaredDownloadSpec {
  if (platform === 'win32' && arch === 'x64') {
    return {
      fileName: 'cloudflared.exe',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-windows-amd64.exe`,
    };
  }
  if (platform === 'win32' && arch === 'arm64') {
    return {
      fileName: 'cloudflared.exe',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-windows-arm64.exe`,
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      fileName: 'cloudflared',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-linux-amd64`,
    };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      fileName: 'cloudflared',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-linux-arm64`,
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      fileName: 'cloudflared',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-darwin-amd64.tgz`,
      archiveType: 'tgz',
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      fileName: 'cloudflared',
      url: `${CLOUDFLARED_RELEASE}/cloudflared-darwin-arm64.tgz`,
      archiveType: 'tgz',
    };
  }
  throw new Error(`auto-download cloudflared is not supported on ${platform}/${arch}`);
}

async function resolveCloudflaredBinary(providedPath?: string): Promise<string> {
  if (providedPath) {
    await ensureExecutable(providedPath);
    return providedPath;
  }

  if (await canRunExecutable('cloudflared')) {
    return 'cloudflared';
  }

  const spec = getCloudflaredDownloadSpec(process.platform, process.arch);
  const targetPath = path.join(getToolCacheDir(), spec.fileName);

  if (await canRunExecutable(targetPath)) {
    return targetPath;
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await downloadDownloadSpec(spec, targetPath);
  if (process.platform !== 'win32') {
    await fs.promises.chmod(targetPath, 0o755);
  }
  await ensureExecutable(targetPath);
  return targetPath;
}

async function ensureExecutable(filePath: string): Promise<void> {
  const ok = await canRunExecutable(filePath);
  if (!ok) throw new Error(`cloudflared is not executable: ${filePath}`);
}

async function canRunExecutable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error) => {
      resolve(!error);
    });
  });
}

function getToolCacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Rome', 'bin');
  }
  return path.join(os.homedir(), '.rome', 'bin');
}

function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', onLine);
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  try {
    await downloadWithRedirects(url, tempPath);
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    try { await fs.promises.unlink(tempPath); } catch { /* */ }
    throw error;
  }
}

async function downloadDownloadSpec(spec: CloudflaredDownloadSpec, targetPath: string): Promise<void> {
  if (spec.archiveType === 'tgz') {
    await downloadAndExtractTarGz(spec.url, targetPath, spec.fileName);
    return;
  }
  await downloadFile(spec.url, targetPath);
}

async function downloadWithRedirects(url: string, targetPath: string, depth = 0): Promise<void> {
  if (depth > 5) throw new Error(`too many redirects while downloading ${url}`);

  await new Promise<void>((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        void downloadWithRedirects(nextUrl, targetPath, depth + 1).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(new Error(`failed to download cloudflared: HTTP ${status}`));
        return;
      }

      const out = fs.createWriteStream(targetPath);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve()));
      res.on('error', reject);
      res.pipe(out);
    });

    req.on('error', reject);
  });
}

async function downloadAndExtractTarGz(url: string, targetPath: string, fileName: string): Promise<void> {
  const targetDir = path.dirname(targetPath);
  const archivePath = path.join(targetDir, `${fileName}.tgz`);
  const extractDir = path.join(targetDir, `${fileName}-extract`);

  try {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
    await fs.promises.mkdir(extractDir, { recursive: true });
    await downloadFile(url, archivePath);
    await extractTarGz(archivePath, extractDir);

    const extractedPath = path.join(extractDir, fileName);
    await fs.promises.copyFile(extractedPath, targetPath);
  } finally {
    try { await fs.promises.unlink(archivePath); } catch { /* */ }
    try { await fs.promises.rm(extractDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

async function extractTarGz(archivePath: string, extractDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xzf', archivePath, '-C', extractDir], (error) => {
      if (error) {
        reject(new Error(`failed to extract cloudflared archive: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}
