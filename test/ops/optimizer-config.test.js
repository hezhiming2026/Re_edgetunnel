import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wrangler declares sqlite durable optimizer coordinator', async () => {
    const config = await readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    assert.match(config, /\[\[durable_objects\.bindings\]\][\s\S]*name = "OPTIMIZER_COORDINATOR"[\s\S]*class_name = "OptimizerCoordinator"/);
    assert.match(config, /\[exports\.OptimizerCoordinator\][\s\S]*type = "durable-object"[\s\S]*storage = "sqlite"/);
});

test('browser ADD mutations route through durable coordinator instead of KV', async () => {
    const adminSource = await readFile(new URL('../../src/controllers/admin.js', import.meta.url), 'utf8');
    const coordinatorSource = await readFile(new URL('../../src/ops/optimizer-coordinator.js', import.meta.url), 'utf8');

    assert.match(adminSource, /writeManualAddTxt/);
    assert.match(adminSource, /await\s+writeManualAddTxt\(env,\s*txt\)/);
    assert.doesNotMatch(adminSource, /env\.KV\.put\(['"]ADD\.txt['"],\s*txt\)/);
    assert.match(coordinatorSource, /setManualAddTxt\s*\(value\)/);
    assert.match(coordinatorSource, /setManualAuthoritativeAddTxt\(this\.ctx\.storage,\s*value\)/);
});

test('first optimizer publish migrates pre-DO ADD.txt through the durable authority', async () => {
    const coordinatorSource = await readFile(new URL('../../src/ops/optimizer-coordinator.js', import.meta.url), 'utf8');

    assert.match(coordinatorSource, /await\s+this\.env\.KV\.get\(['"]ADD\.txt['"]\)/);
    assert.match(coordinatorSource, /publishAuthoritativePool\(this\.ctx\.storage,\s*request,\s*legacyManualAddTxt\)/);
});

test('subscription honors initialized durable clear before legacy KV fallback', async () => {
    const subSource = await readFile(new URL('../../src/controllers/sub.js', import.meta.url), 'utf8');

    assert.match(subSource, /readOptimizerAddState/);
    assert.match(subSource, /authorityState\.initialized\s*\?\s*authorityState\.add_txt\s*:\s*await\s+env\.KV\.get\(['"]ADD\.txt['"]\)/);
    assert.doesNotMatch(subSource, /authoritativeAddTxt\s*\|\|\s*await\s+env\.KV\.get\(['"]ADD\.txt['"]\)/);
});
