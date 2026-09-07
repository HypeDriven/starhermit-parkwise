const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

test('score comparisons filter before ranking; malformed URLs leave server alive', { timeout: 15000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parkwise-test-'));
    const file = path.join(dir, 'scores.json');
    const base = { board: 'global', mode: 'daily', seed: 123, day: '2026-09-07', contentVersion: 1, score: 10, seconds: 20 };
    const entries = [{ ...base, id: 'match' },
        ...['mode', 'seed', 'day', 'contentVersion'].map(key => ({ ...base, [key]: 'different', id: key, score: 999 }))];
    await writeFile(file, JSON.stringify({ version: 1, entries }));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PORT: '0', PARKWISE_SCORES_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const port = await new Promise((resolve, reject) => {
            let output = '';
            child.stdout.on('data', data => {
                output += data;
                const match = output.match(/localhost:(\d+)/);
                if (match) resolve(match[1]);
            });
            child.once('error', reject);
            child.once('exit', code => reject(new Error('server exited: ' + code)));
        });
        const url = 'http://127.0.0.1:' + port;
        const query = new URLSearchParams({ board: base.board, mode: base.mode, seed: base.seed, day: base.day, contentVersion: base.contentVersion });
        const result = await (await fetch(url + '/api/v1/scores?' + query)).json();
        assert.deepEqual(result.entries.map(e => e.id), ['match']);
        assert.equal((await fetch(url + '/%E0%A4%A')).status, 400);
        assert.equal((await fetch(url + '/healthz')).status, 200);
    } finally {
        if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
        await rm(dir, { recursive: true, force: true });
    }
});
