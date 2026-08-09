import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('worker entrypoint exports OptimizerCoordinator class', async () => {
    const source = await readFile(new URL('../../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /export \{ OptimizerCoordinator \} from '\.\/ops\/optimizer-coordinator\.js';/);
});
