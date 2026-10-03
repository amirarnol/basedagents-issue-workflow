const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Exercise the shipped workflow script itself; there is no duplicate implementation.
const yaml = fs.readFileSync(path.join(__dirname, '../.github/workflows/basedagents-task.yml'), 'utf8');
const script = yaml.split('          script: |\n')[1].split('\n')
  .map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('require', 'process', 'context', 'github', 'core', 'exec', script);
const secret = JSON.stringify({ publicKey: 'test-public-only', privateKey: 'test-private-only' });

function harness(options = {}) {
  const calls = [], logs = [], masks = [], files = new Map();
  const issue = { number: 17, title: 'Improve the export flow', body: 'Add a JSON export.',
    html_url: 'https://github.com/example/owned-repo/issues/17',
    labels: [{ name: 'bounty' }, { name: 'bounty:automation' }], ...options.issue };
  const context = { eventName: options.manual ? 'workflow_dispatch' : 'issues',
    repo: { owner: 'example', repo: 'owned-repo' }, payload: { issue } };
  const env = { BASEDAGENTS_DRY_RUN: options.variable === undefined ? (options.dry === false ? 'false' : 'true') : options.variable,
    BASEDAGENTS_KEYPAIR: options.secret === undefined ? secret : options.secret,
    DISPATCH_ISSUE_NUMBER: options.number || '17', DISPATCH_DRY_RUN: options.dispatchDry || 'false',
    RUNNER_TEMP: path.resolve(__dirname, '.mock-runner') };
  const core = { info: message => logs.push(message), setSecret: value => masks.push(value) };
  const fakeFs = {
    mkdtempSync: prefix => prefix + 'fixture',
    writeFileSync: (file, data, config) => { assert.equal(config.mode, 0o600); assert.equal(config.flag, 'wx'); files.set(file, data); },
    rmSync: file => { files.delete(file); calls.push(['removeFile', file]); }
  };
  const wrap = (name, result) => async input => {
    assert.equal(input.owner, context.repo.owner); assert.equal(input.repo, context.repo.repo);
    if ('issue_number' in input) assert.equal(input.issue_number, 17);
    calls.push([name, input]);
    if (options.fail === name) throw Object.assign(new Error('Mock failure: ' + name), { status: 503 });
    if (name === 'getLabel' && options.missingLabel) throw Object.assign(new Error('Missing label'), { status: 404 });
    return result;
  };
  const issues = {
    get: wrap('get', { data: issue }),
    listComments: () => {},
    getLabel: wrap('getLabel', {}), createLabel: wrap('createLabel', {}),
    createComment: wrap('createComment', {}), addLabels: wrap('addLabels', {})
  };
  const github = { rest: { issues }, paginate: async (_, input) => {
    assert.equal(input.issue_number, 17); calls.push(['comments', input]); return options.comments || [];
  } };
  let postedTask, bridge;
  const exec = {
    exec: async (command, args, config) => {
      calls.push(['install']); assert.equal(command, 'npm');
      assert(args.includes('basedagents@0.10.1')); assert(args.includes('--ignore-scripts')); assert.equal(config.silent, true);
    },
    getExecOutput: async (command, args, config) => {
      calls.push(['post']); assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 2), ['--input-type=module', '-e']); assert.equal(args.length, 3);
      assert.equal(config.silent, true); assert.equal(files.get(config.env.BASEDAGENTS_KEYPAIR_PATH), env.BASEDAGENTS_KEYPAIR);
      postedTask = JSON.parse(files.get(config.env.BASEDAGENTS_TASK_PATH)); bridge = args[2];
      assert(!('bounty' in postedTask)); assert(!('escrow' in postedTask));
      if (options.fail === 'post') throw new Error('Mock posting timeout');
      return { stdout: JSON.stringify({ task_id: options.taskId || 'task_test123', status: 'open' }) };
    }
  };
  const fakeRequire = module => module === 'node:fs' ? fakeFs : require(module);
  return { calls, logs, masks, files, issue,
    execute: () => run(fakeRequire, { env, execPath: process.execPath }, context, github, core, exec),
    task: () => postedTask, bridge: () => bridge };
}
const count = (h, name) => h.calls.filter(call => call[0] === name).length;
const preview = h => JSON.parse(h.logs.find(log => log.startsWith('{')));

test('label-trigger dry run preserves exact fields and makes no writes or SDK calls', async () => {
  const h = harness(); await h.execute();
  assert.deepEqual(preview(h), { title: h.issue.title, description: h.issue.body + '\n\nSource: ' + h.issue.html_url,
    category: 'automation', output_format: 'json' });
  assert.deepEqual(h.calls.map(call => call[0]), ['get']); assert.equal(h.masks.length, 0);
});
test('manual default true keeps preview on when repository variable is false', async () => {
  const h = harness({ manual: true, dry: false, dispatchDry: 'true' }); await h.execute();
  assert(preview(h)); assert.equal(count(h, 'post'), 0);
});
test('repository switch true overrides manual false (trimmed and case insensitive)', async () => {
  const h = harness({ manual: true, variable: ' TRUE ', dispatchDry: 'false' }); await h.execute(); assert(preview(h));
});
test('already-posted marker is a complete no-op', async () => {
  const h = harness({ dry: false, issue: { labels: ['bounty', 'bounty:posted'] } }); await h.execute();
  assert.deepEqual(h.calls.map(call => call[0]), ['get']);
});
test('removed bounty label prevents stale queued events from posting', async () => {
  const h = harness({ dry: false, issue: { labels: [] } }); await h.execute(); assert.equal(count(h, 'post'), 0);
});
test('no category label defaults to code; unrelated bounty-prefixed labels are ignored', async () => {
  const h = harness({ issue: { labels: ['bounty', 'bounty:other', 'help wanted'] } }); await h.execute();
  assert.equal(preview(h).category, 'code');
});
test('all five supported categories are read from their label', async () => {
  for (const category of ['code', 'research', 'data', 'content', 'automation']) {
    const h = harness({ issue: { labels: ['bounty', 'bounty:' + category] } }); await h.execute();
    assert.equal(preview(h).category, category);
  }
});
test('conflicting category labels fail without publishing', async () => {
  const h = harness({ dry: false, issue: { labels: ['bounty', 'bounty:code', 'bounty:data'] } });
  await assert.rejects(h.execute(), /only one category/); assert.equal(count(h, 'post'), 0);
});
test('description budget includes the source suffix and handles null bodies', async () => {
  const h = harness({ issue: { body: 'x'.repeat(12000) } }); await h.execute();
  assert.equal(preview(h).description.length, 10000); assert(preview(h).description.endsWith('Source: ' + h.issue.html_url));
  const empty = harness({ issue: { body: null } }); await empty.execute();
  assert.equal(preview(empty).description, '\n\nSource: ' + empty.issue.html_url);
});
test('title and description clipping do not split surrogate pairs', async () => {
  const h = harness({ issue: { title: 'x'.repeat(199) + '😀', body: '😀'.repeat(6000) } }); await h.execute();
  assert.equal(preview(h).title.length, 199); assert(!preview(h).description.includes('\uFFFD'));
  assert(!/[\uD800-\uDBFF]$/.test(preview(h).description.split('\n\nSource: ')[0]));
});
test('issue content cannot inject workflow log commands', async () => {
  const h = harness({ issue: { body: '\n::error::fake\n::add-mask::hidden\n' } }); await h.execute();
  assert(h.logs.every(log => !log.includes('\n'))); assert.equal(preview(h).description, h.issue.body + '\n\nSource: ' + h.issue.html_url);
});
test('invalid manual numbers and pull requests are rejected', async () => {
  for (const number of ['0', '-1', '01', '1e2', '99999999999999999999', '17; echo unsafe']) {
    const h = harness({ manual: true, number }); await assert.rejects(h.execute(), /positive integer/); assert.equal(h.calls.length, 0);
  }
  const pr = harness({ issue: { pull_request: {} } }); await assert.rejects(pr.execute(), /not pull requests/);
});
test('real publishing uses the official SDK, masks credentials, comments and labels only the source issue', async () => {
  const h = harness({ dry: false, missingLabel: true }); await h.execute();
  assert.equal(count(h, 'post'), 1); assert.equal(count(h, 'createComment'), 1); assert.equal(count(h, 'addLabels'), 1);
  assert.equal(count(h, 'createLabel'), 1); assert.equal(h.files.size, 0);
  assert(h.masks.includes(secret)); assert(h.masks.includes('test-private-only'));
  assert(h.logs.every(log => !log.includes(secret) && !log.includes('test-private-only')));
  assert(h.calls.find(call => call[0] === 'createComment')[1].body.includes('https://basedagents.ai/tasks/task_test123'));
});
test('shell text and reserved CLI flags remain JSON data', async () => {
  const h = harness({ dry: false, issue: { title: '--bounty', body: '$(echo unsafe); " --payment-signature' } }); await h.execute();
  assert.equal(h.task().title, '--bounty'); assert(h.task().description.startsWith(h.issue.body));
  assert(!h.bridge().includes(h.issue.body)); assert(!h.bridge().includes(secret));
});
test('existing bot receipt recovers a missing label without posting or needing a secret', async () => {
  const h = harness({ dry: false, secret: '', comments: [
    { user: { login: 'github-actions[bot]' }, body: '<!-- basedagents-task:v1 task_previous -->' }
  ] }); await h.execute();
  assert.equal(count(h, 'post'), 0); assert.equal(count(h, 'addLabels'), 1); assert.equal(count(h, 'createComment'), 0);
});
test('a user-authored imitation receipt cannot skip posting', async () => {
  const h = harness({ dry: false, comments: [{ user: { login: 'someone' }, body: '<!-- basedagents-task:v1 task_fake -->' }] });
  await h.execute(); assert.equal(count(h, 'post'), 1);
});
test('missing or malformed secret fails without installing or posting', async () => {
  for (const value of ['', '{broken']) {
    const h = harness({ dry: false, secret: value }); await assert.rejects(h.execute(), /KEYPAIR/); assert.equal(count(h, 'install'), 0);
  }
});
test('posting timeout cleans up private files and propagates failure without a comment', async () => {
  const h = harness({ dry: false, fail: 'post' }); await assert.rejects(h.execute(), /timeout/);
  assert.equal(h.files.size, 0); assert.equal(count(h, 'createComment'), 0);
});
test('invalid API response cannot produce a bogus issue link', async () => {
  const h = harness({ dry: false, taskId: '../../bad' }); await assert.rejects(h.execute(), /valid task ID/);
  assert.equal(count(h, 'createComment'), 0); assert.equal(h.files.size, 0);
});
test('comment failure records the real task URL and requires manual recovery', async () => {
  const h = harness({ dry: false, fail: 'createComment' }); await assert.rejects(h.execute(), /Do not rerun/);
  assert(h.logs.some(log => log.includes('/tasks/task_test123'))); assert.equal(count(h, 'addLabels'), 0); assert.equal(h.files.size, 0);
});
test('the exact SDK bridge signs a free task with official 0.10.1 SDK and an offline transport', async () => {
  const sdkRoot = path.resolve(__dirname, '../../runtime');
  if (!fs.existsSync(path.join(sdkRoot, 'node_modules/basedagents/dist/index.js'))) {
    throw new Error('Install SDK fixture first: npm install --prefix ../runtime --ignore-scripts basedagents@0.10.1');
  }
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'node_modules/basedagents/dist/index.js')).href);
  const h = harness({ dry: false }); await h.execute();
  const fixture = fs.mkdtempSync(path.join(__dirname, '.test-temp-'));
  try {
    const keyFile = path.join(fixture, 'fixture-keypair.json'), taskFile = path.join(fixture, 'task.json');
    fs.writeFileSync(keyFile, sdk.serializeKeypair(await sdk.generateKeypair()), { mode: 0o600 });
    fs.writeFileSync(taskFile, JSON.stringify(h.task()));
    const mockTransport = `
      import assert from 'node:assert/strict';
      let requests = 0;
      globalThis.fetch = async (url, config) => {
        assert.equal(String(url), 'https://api.basedagents.ai/v1/tasks');
        assert.equal(config.method, 'POST');
        const headers = new Headers(config.headers);
        assert.match(headers.get('Authorization'), /^AgentSig [^:]+:[A-Za-z0-9+/=]+$/);
        assert(headers.has('X-Timestamp')); assert(headers.has('X-Nonce'));
        const task = JSON.parse(config.body);
        assert.equal(task.output_format, 'json'); assert.equal(task.category, 'automation');
        assert(!('bounty' in task)); assert(!('escrow' in task));
        requests++;
        return new Response(JSON.stringify({ok:true, task_id:'task_offline123', status:'open'}), {status:200});
      };
      process.on('beforeExit', () => assert.equal(requests, 1));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', mockTransport + h.bridge()], {
      encoding: 'utf8', env: { ...process.env, BASEDAGENTS_SDK_DIR: sdkRoot,
        BASEDAGENTS_KEYPAIR_PATH: keyFile, BASEDAGENTS_TASK_PATH: taskFile }
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).task_id, 'task_offline123');
  } finally {
    const resolved = path.resolve(fixture);
    if (!resolved.startsWith(path.join(path.resolve(__dirname), '.test-temp-'))) throw new Error('Unsafe cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
