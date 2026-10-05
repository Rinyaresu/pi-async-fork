#!/usr/bin/env node
// Run ONLY from the main session: this harness creates real Pi/fleet agents.
// node test/integration/isolated-context.mjs --pi /absolute/path/to/pi/dist/cli.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--pi', 'Usage: node test/integration/isolated-context.mjs --pi /absolute/path/to/pi/dist/cli.js');
const cli = resolve(args[1]);
const piRoot = dirname(dirname(cli));
const piPackage = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
const root = await mkdtemp('/tmp/pifv2-');
await chmod(root, 0o700);
const paths = {
  cwd: join(root, 'work'), agentDir: join(root, 'agent'), sessions: join(root, 'sessions'),
  stateDir: join(root, 'f'), transcript: join(root, 'effective-context.jsonl'),
  requests: join(root, 'http-requests.jsonl'), evidence: join(root, 'evidence.json'),
  launcher: join(root, 'pi'),
};
for (const path of [paths.cwd, paths.agentDir, paths.sessions, paths.stateDir]) await mkdir(path, { mode: 0o700 });
for (const path of [paths.transcript, paths.requests]) await writeFile(path, '', { mode: 0o600, flag: 'wx' });
console.log(`ARTIFACT_ROOT=${root}`);

const provider = 'isolation-test';
const modelId = 'fixture';
const workerSystem = `WORKER_ENV_${randomUUID().replaceAll('-', '')}`;
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = content => ({ role: 'assistant', content, api: 'openai-completions', provider,
  model: modelId, usage: zeroUsage(), stopReason: 'stop', timestamp: Date.now() });
const user = content => ({ role: 'user', content, timestamp: Date.now() });
const text = value => ({ type: 'text', text: value });
const thinking = value => ({ type: 'thinking', thinking: value, thinkingSignature: 'reasoning_content' });
const serialize = value => JSON.stringify(value);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const evidence = { root, piVersion: piPackage.version, cli, outcome: 'RUNNING', cases: [], cleanup: [], limitations: [
  'Registered tool invocation uses synthetic parent envelopes, not LLM schema/tool selection.',
  'Deterministic local provider verifies context delivery, not review quality or human TUI.',
  'History isolation is not a filesystem, tool, credential, or external-memory sandbox.',
] };
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });
async function waitFor(label, check, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted) throw new Error(`Interrupted: ${label}`);
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}
async function jsonLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const requests = [];
const serverErrors = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      assert(raw.length < 4_000_000, 'Unexpectedly large fixture request');
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, modelId);
    assert.equal(body.stream, true);
    const sessionId = req.headers['x-pi-isolation-session'];
    assert.equal(typeof sessionId, 'string', 'Recorder must correlate wire request with real session ID');
    const record = { sessionId, body };
    requests.push(record);
    await appendFile(paths.requests, `${serialize(record)}\n`, { mode: 0o600 });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const base = { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
    res.write(`data: ${serialize({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '## Output\nISOLATION_TEST_OK\n\n## Learnings\nNo reusable learnings found.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${serialize({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) {
    serverErrors.push(error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Fixture provider error');
  }
});
server.requestTimeout = 30_000;

let client;
let currentSession;
let failure;
try {
  await access(cli);
  // Isolate discovery and disable automatic network activity before loading Pi or fleet.
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_FLEET_PI_COMMAND: paths.launcher,
    PI_ISOLATION_CAPTURE_FILE: paths.transcript,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_OBSERVATIONAL_MEMORY_PASSIVE: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });
  const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
  // These are real version capabilities, not synthetic recent entries on an old Pi.
  assert.equal(typeof sdk.SessionManager.prototype.appendContextEdit, 'function',
    'Full isolation gate requires a Pi runtime with context edits and context_with_system (tested with Pi 1.0.1); 0.85.x is not full coverage.');
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(paths.launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o700, flag: 'wx' });
  const profile = { provider, model: modelId, thinking: 'low' };
  const settings = {
    packages: [],
    extensions: [join(repo, 'src/index.ts'), join(repo, 'test/integration/fixtures/context-recorder.ts'),
      '-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'],
    skills: [], prompts: [], defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: 'low',
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off',
    enableInstallTelemetry: false, enableAnalytics: false,
    'pi-async-fork': { agentDir: paths.agentDir, stateDir: paths.stateDir,
      fast: profile, balanced: profile, deep: profile,
      env: { PI_ISOLATION_CAPTURE_FILE: paths.transcript, PI_FLEET_PI_COMMAND: paths.launcher,
        PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OBSERVATIONAL_MEMORY_PASSIVE: '1' } },
  };
  const models = { providers: { [provider]: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
    models: [{ id: modelId, name: 'Local isolation fixture', reasoning: true, input: ['text'],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }],
  } } };
  await writeFile(join(paths.agentDir, 'settings.json'), serialize(settings), { mode: 0o600 });
  await writeFile(join(paths.agentDir, 'models.json'), serialize(models), { mode: 0o600 });
  await writeFile(join(paths.agentDir, 'SYSTEM.md'), `${workerSystem}\nThis is a disposable context integration test. Follow only the assigned bounded task. Do not call tools.\n`, { mode: 0o600 });
  const fleet = await import(pathToFileURL(join(repo, 'node_modules/@elpapi42/pi-fleet-sdk/dist/index.js')).href);
  client = await fleet.connectPiFleet({ stateDir: paths.stateDir });
  assert.equal((await client.list()).length, 0, 'Private fleet must start empty');

  function fixture(kind) {
    const manager = sdk.SessionManager.inMemory(paths.cwd);
    const sentinels = {};
    const effective = [];
    const mark = (label, visible = false) => {
      const value = `PARENT_ONLY_${label.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
      sentinels[label] = value;
      if (visible) effective.push(value);
      return value;
    };
    // Explicit system sections also exercise checkpoints; the worker may replace them.
    manager.appendMessage({ role: 'system', content: '', sections: { parent_history: mark('system') }, toolsAdded: [], timestamp: Date.now() });
    if (kind === 'messages') {
      manager.appendMessage(user(mark('user', true)));
      const toolCallId = `historical_${randomUUID().replaceAll('-', '')}`;
      manager.appendMessage({ ...assistant([text(mark('assistant', true)), thinking(mark('thinking', true)),
        { type: 'toolCall', id: toolCallId, name: 'read', arguments: { path: 'unused-fixture-path' } }]), stopReason: 'toolUse' });
      manager.appendMessage({ role: 'toolResult', toolCallId, toolName: 'read', content: [text(mark('tool_result', true))], isError: false, timestamp: Date.now() });
    } else {
      manager.appendMessage(user(mark('compacted_away')));
      manager.appendMessage({ role: 'system', content: '', sections: { parent_checkpoint: mark('checkpoint') }, timestamp: Date.now() });
      const editTarget = manager.appendMessage(user(mark('edit_original')));
      manager.appendMessage(user(mark('retained', true)));
      const compactionId = manager.appendCompaction(mark('compaction_summary', true), editTarget, 50000);
      const compaction = manager.getEntry(compactionId);
      assert(compaction.systemMessage, 'Native compaction must capture a system checkpoint');
      assert(serialize(compaction.systemMessage).includes(sentinels.checkpoint));
      manager.appendMessage(user(mark('abandoned_branch')));
      manager.branchWithSummary(compactionId, mark('branch_summary', true));
      manager.appendContextEdit(editTarget, { content: mark('edit_replacement', true) });
    }
    return { manager, sentinels, effective, mark };
  }

  for (const kind of ['messages', 'transformed']) {
    for (const context of ['inherit', 'isolated']) {
      const data = fixture(kind);
      const nonce = `TASK_NONCE_${randomUUID().replaceAll('-', '')}`;
      const params = { name: 'isolation-test', description: 'Verify worker history isolation', role: 'verify', effort: 'fast', context,
        task: `Do not call tools. Include ${nonce} in your reasoning context only. Return exactly ## Output followed by ISOLATION_TEST_OK and ## Learnings followed by No reusable learnings found. Then stop.` };
      const toolCallId = `create_${randomUUID().replaceAll('-', '')}`;
      data.manager.appendMessage({ ...assistant([
        text(data.mark('invoking_text', true)), thinking(data.mark('invoking_thinking', true)),
        { type: 'toolCall', id: toolCallId, name: 'create_fork', arguments: params },
      ]), stopReason: 'toolUse' });
      // Close the host-managed envelope before automatic parent notification turns.
      data.manager.appendMessage({ role: 'toolResult', toolCallId, toolName: 'create_fork',
        content: [text('Host-managed invocation; result is captured separately.')], isError: false, timestamp: Date.now() });
      const rawParent = serialize(data.manager.getEntries());
      const projectedParent = serialize(data.manager.buildSessionContext().messages);
      for (const sentinel of Object.values(data.sentinels)) assert(rawParent.includes(sentinel), 'Sentinel must originate in parent entries');
      for (const sentinel of data.effective) assert(projectedParent.includes(sentinel), 'Positive sentinel must belong to effective parent projection');
      for (const sentinel of Object.values(data.sentinels)) assert(!serialize(params).includes(sentinel), 'Sentinels must never be included in task/tool arguments');
      for (const path of [join(paths.agentDir, 'settings.json'), join(paths.agentDir, 'models.json'), join(paths.agentDir, 'SYSTEM.md')]) {
        const contents = await readFile(path, 'utf8');
        for (const sentinel of Object.values(data.sentinels)) assert(!contents.includes(sentinel), 'Sentinels must exist only in parent history, never profile resources');
      }
      const parentPath = join(paths.sessions, `${data.manager.getHeader().id}.jsonl`);
      await writeFile(parentPath, `${[data.manager.getHeader(), ...data.manager.getEntries()].map(serialize).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      const sessionManager = sdk.SessionManager.open(parentPath);
      const settingsManager = sdk.SettingsManager.create(paths.cwd, paths.agentDir);
      const resourceLoader = new sdk.DefaultResourceLoader({ cwd: paths.cwd, agentDir: paths.agentDir, settingsManager,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, [], 'Extension loader must succeed');
      const created = await sdk.createAgentSession({ cwd: paths.cwd, agentDir: paths.agentDir, resourceLoader, settingsManager,
        sessionManager, tools: [], thinkingLevel: 'low' });
      currentSession = created.session;
      const extensionErrors = [];
      await currentSession.bindExtensions({ mode: 'json', onError: error => extensionErrors.push({ event: error.event, error: error.error }) });
      const model = currentSession.extensionRunner.getModelRegistry().find(provider, modelId);
      assert(model, 'Local fixture model must be registered');
      await currentSession.setModel(model);
      currentSession.setActiveToolsByName([]);
      const definition = currentSession.extensionRunner.getToolDefinition('create_fork');
      assert(definition, 'Actual create_fork definition must be registered');
      const signal = AbortSignal.timeout(90_000);
      const result = await definition.execute(toolCallId, params, signal, undefined,
        currentSession.extensionRunner.createToolContext(toolCallId, signal));
      const forkId = result.details.forkId;
      const records = type => currentSession.sessionManager.getEntries()
        .filter(entry => entry.type === 'custom' && entry.customType === 'pi-async-fork' && entry.data?.type === type && entry.data.forkId === forkId)
        .map(entry => entry.data);
      const fork = records('fork.created')[0];
      assert(fork, 'Creation must be persisted by the real extension');
      const initial = await jsonLines(fork.sessionPath);
      const header = initial[0];
      assert.equal(header.parentSession, parentPath, 'Isolated lineage must be preserved, not removed to make the test pass');
      assert.notEqual(header.id, sessionManager.getHeader().id);
      assert(initial.some(entry => entry.type === 'custom' && entry.customType === 'pi-async-fork-child'
        && entry.data?.sessionId === header.id && entry.data?.forkId === forkId), 'Child marker must match session and fork');
      assert.equal((await stat(fork.sessionPath)).mode & 0o777, 0o600);
      await access(parentPath); // Parent remains readable throughout the child request.
      const snapshots = await waitFor('real worker full-context capture and wire request', async () => {
        const full = (await jsonLines(paths.transcript)).filter(record => record.kind === 'context_with_system' && record.sessionId === header.id);
        return full.length && requests.some(record => record.sessionId === header.id) ? full : false;
      });
      const destroyed = await waitFor('normal worker finalization', () => records('fork.destroyed')[0]);
      assert.equal(destroyed.kind, 'response');
      assert.match(destroyed.output, /ISOLATION_TEST_OK/);
      const workerRequests = requests.filter(record => record.sessionId === header.id);
      const fullSnapshots = (await jsonLines(paths.transcript)).filter(record => record.kind === 'context_with_system' && record.sessionId === header.id);
      const transcriptText = serialize(fullSnapshots);
      const wireText = serialize(workerRequests.map(record => record.body));
      for (const surface of [transcriptText, wireText]) {
        assert(surface.includes(nonce), 'Task must reach the real worker');
        assert(surface.includes('I am a fork. I am not the main agent.'), 'Boundary must reach the real worker');
        assert(surface.includes(workerSystem), 'Worker environment system prompt must reach the provider');
      }
      const inheritedPresence = {};
      for (const [label, sentinel] of Object.entries(data.sentinels)) {
        inheritedPresence[label] = { transcript: transcriptText.includes(sentinel), wire: wireText.includes(sentinel) };
        if (context === 'isolated') {
          assert(!transcriptText.includes(sentinel), `Parent ${label} leaked into effective isolated transcript`);
          assert(!wireText.includes(sentinel), `Parent ${label} leaked into isolated HTTP request`);
        } else if (data.effective.includes(sentinel)) {
          assert(transcriptText.includes(sentinel), `Missing positive inherited ${label} in effective transcript`);
          assert(wireText.includes(sentinel), `Missing positive inherited ${label} in HTTP request`);
        }
      }
      await access(parentPath);
      assert.deepEqual(extensionErrors, []);
      assert.equal(serverErrors.length, 0, 'Fixture provider must not have rejected requests');
      assert.equal((await client.list()).length, 0, 'Normal extension completion must destroy its worker');
      const resultEvidence = { kind, context, forkId, sessionId: header.id, parentPath, childPath: fork.sessionPath,
        parentSessionPreserved: true, parentAccessible: true, effectiveSentinelCount: data.effective.length,
        sentinels: data.sentinels, inheritedPresence, fullContextCaptures: fullSnapshots.length,
        httpRequests: workerRequests.length, firstCaptureMessages: snapshots[0].messages.length, outcome: 'PASS' };
      evidence.cases.push(resultEvidence);
      console.log(`${kind}/${context}: PASS (${workerRequests.length} HTTP request, ${fullSnapshots.length} full-context capture)`);
      await currentSession.waitForIdle();
      await currentSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
      currentSession.dispose();
      currentSession = undefined;
    }
  }
  assert.equal(evidence.cases.length, 4);
} catch (error) {
  failure = error;
  evidence.failure = { message: error.message, stack: error.stack };
  console.error(error.stack);
} finally {
  // Emergency cleanup is restricted to this newly created private fleet and FAILS the run.
  if (currentSession) {
    try { await currentSession.abort(); } catch (error) { failure ??= error; }
  }
  if (client) {
    try {
      for (const info of await client.list()) {
        assert.equal(info.cwd, paths.cwd, 'Refuse cleanup of an unexpected agent');
        failure ??= new Error('Emergency cleanup required; integration is not a clean PASS');
        evidence.cleanup.push({ agentId: info.id, agentName: info.name, action: 'emergency_destroy' });
        await (await client.get(info.name)).destroy();
      }
      assert.equal((await client.list()).length, 0);
    } catch (error) {
      failure ??= error;
      evidence.cleanup.push({ action: 'cleanup_error', error: error.message });
    }
  }
  if (currentSession) {
    try { await currentSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); }
    catch (error) { failure ??= error; evidence.cleanup.push({ action: 'shutdown_error', error: error.message }); }
    currentSession.dispose();
  }
  if (client) {
    try { await client.close(); } catch (error) { failure ??= error; }
  }
  if (server.listening) {
    await new Promise(resolveClose => {
      server.close(resolveClose);
      server.closeIdleConnections();
    });
  }
  evidence.outcome = failure ? 'FAIL' : 'PASS';
  evidence.serverErrors = serverErrors;
  if (failure && !evidence.failure) evidence.failure = { message: failure.message, stack: failure.stack };
  await writeFile(paths.evidence, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(`OUTCOME=${evidence.outcome} EVIDENCE=${paths.evidence}`);
}
process.exitCode = failure ? 1 : 0;
