import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wrangler declares sqlite durable optimizer coordinator', async () => {
    const config = await readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    assert.match(config, /\[\[durable_objects\.bindings\]\][\s\S]*name = "OPTIMIZER_COORDINATOR"[\s\S]*class_name = "OptimizerCoordinator"/);
    assert.match(config, /\[exports\.OptimizerCoordinator\][\s\S]*type = "durable-object"[\s\S]*storage = "sqlite"/);
});
