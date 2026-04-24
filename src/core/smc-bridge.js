/**
 * smc-bridge — Node ↔ Python sidecar for prezis/smc-engine
 *
 * Spawns `uv run smc-engine serve` as a long-lived child process and routes
 * line-delimited JSON-RPC requests to it. Implements VS Code-LSP-inspired
 * supervision: one persistent subprocess, restart on crash, idle eviction
 * after N minutes of inactivity to free RAM.
 *
 * Used by: src/tools/smc.js (smc_analyze, smc_render_top, smc_rank_assets)
 *
 * smc-engine repo: https://github.com/prezis/smc-engine (PUBLIC, MIT)
 * Local install assumed at $SMC_ENGINE_PATH (defaults to ~/ai/smc-engine).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_SMC_PATH = resolve(homedir(), 'ai', 'smc-engine');
const IDLE_EVICTION_MS = 5 * 60_000; // 5 minutes idle → kill subprocess
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;
const RESTART_WINDOW_MS = 3 * 60_000;

let _child = null;          // ChildProcess | null
let _idleTimer = null;       // setTimeout handle
let _pendingResponses = new Map(); // request_id → {resolve, reject, timer}
let _nextRequestId = 1;
let _restarts = [];          // recent restart timestamps for circuit-breaker
let _stdoutBuffer = '';

function _smcEnginePath() {
  return process.env.SMC_ENGINE_PATH || DEFAULT_SMC_PATH;
}

function _checkInstalled() {
  const path = _smcEnginePath();
  if (!existsSync(path)) {
    throw new Error(
      `smc-engine not found at ${path}. ` +
      `Install via: git clone https://github.com/prezis/smc-engine ${path} && cd ${path} && uv sync. ` +
      `Override path with SMC_ENGINE_PATH env var.`
    );
  }
}

function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _shutdownChild('idle-eviction');
  }, IDLE_EVICTION_MS);
}

function _trimRestartWindow() {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  _restarts = _restarts.filter((t) => t > cutoff);
}

function _spawnChild() {
  _checkInstalled();
  _trimRestartWindow();
  if (_restarts.length >= MAX_RESTARTS_IN_WINDOW) {
    throw new Error(
      `smc-engine has crashed ${MAX_RESTARTS_IN_WINDOW} times in last ` +
      `${RESTART_WINDOW_MS / 1000}s. Refusing to restart. ` +
      `Diagnose: cd ${_smcEnginePath()} && uv run smc-engine serve`
    );
  }

  const cwd = _smcEnginePath();
  const child = spawn('uv', ['run', 'smc-engine', 'serve'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  child.on('error', (err) => {
    process.stderr.write(`[smc-bridge] spawn error: ${err.message}\n`);
    _failAllPending(err);
    _child = null;
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[smc-bridge] child exited code=${code} signal=${signal}\n`);
    if (code !== 0 && code !== null) {
      _restarts.push(Date.now());
    }
    _failAllPending(new Error(`smc-engine subprocess exited (code=${code})`));
    _child = null;
  });

  child.stderr.on('data', (data) => {
    // Forward python stderr to our stderr (visible in MCP host logs)
    process.stderr.write(`[smc-engine] ${data}`);
  });

  child.stdout.on('data', (data) => {
    _stdoutBuffer += data.toString('utf8');
    // Process complete lines (the JSON-RPC protocol is line-delimited)
    let nl;
    while ((nl = _stdoutBuffer.indexOf('\n')) >= 0) {
      const line = _stdoutBuffer.slice(0, nl);
      _stdoutBuffer = _stdoutBuffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        _handleResponse(resp);
      } catch (err) {
        process.stderr.write(`[smc-bridge] failed to parse response: ${err.message}\n`);
      }
    }
  });

  return child;
}

function _ensureChild() {
  if (!_child || _child.killed || _child.exitCode !== null) {
    _child = _spawnChild();
  }
  return _child;
}

function _handleResponse(resp) {
  const id = resp.id;
  if (id == null) {
    // Unsolicited or parse-error response; log and skip
    process.stderr.write(`[smc-bridge] response with null id: ${JSON.stringify(resp).slice(0, 200)}\n`);
    return;
  }
  const pending = _pendingResponses.get(id);
  if (!pending) {
    process.stderr.write(`[smc-bridge] orphan response for id=${id}\n`);
    return;
  }
  _pendingResponses.delete(id);
  clearTimeout(pending.timer);
  if (resp.error) {
    pending.reject(new Error(resp.error.message || 'smc-engine error'));
  } else {
    pending.resolve(resp.result);
  }
}

function _failAllPending(err) {
  for (const [id, pending] of _pendingResponses) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  _pendingResponses.clear();
}

function _shutdownChild(reason) {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_child && !_child.killed) {
    process.stderr.write(`[smc-bridge] shutting down (${reason})\n`);
    _child.kill('SIGTERM');
  }
  _child = null;
}

/**
 * Send a JSON-RPC request to the smc-engine subprocess.
 *
 * @param {string} method - One of "analyze", "render_pine", "ping"
 * @param {object} params - Method-specific parameters
 * @returns {Promise<object>} - Resolves with the result or rejects with error
 */
export async function callSmcEngine(method, params = {}) {
  const child = _ensureChild();
  _resetIdleTimer();

  const id = _nextRequestId++;
  const req = { id, method, params };
  const line = JSON.stringify(req) + '\n';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingResponses.delete(id);
      reject(new Error(`smc-engine method "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    _pendingResponses.set(id, { resolve, reject, timer });

    try {
      child.stdin.write(line);
    } catch (err) {
      _pendingResponses.delete(id);
      clearTimeout(timer);
      reject(new Error(`smc-engine stdin write failed: ${err.message}`));
    }
  });
}

/**
 * Force shutdown — used by MCP server lifecycle.
 */
export function shutdown() {
  _shutdownChild('explicit-shutdown');
}

/**
 * Health check — pings the subprocess to verify it's responsive.
 */
export async function ping() {
  return callSmcEngine('ping', {});
}

// Ensure subprocess is killed on parent exit
process.on('exit', () => _shutdownChild('parent-exit'));
process.on('SIGINT', () => { _shutdownChild('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { _shutdownChild('SIGTERM'); process.exit(143); });
