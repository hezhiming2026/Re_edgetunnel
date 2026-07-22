import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJavaScriptTree(directory) {
    return readdirSync(directory, { withFileTypes: true }).map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? readJavaScriptTree(path) : (entry.name.endsWith('.js') ? readFileSync(path, 'utf8') : '');
    }).join('\n');
}

test('runtime source has no third-party repository or implicit public resolver dependency', () => {
    const source = readJavaScriptTree(join(repositoryRoot, 'src'));
    assert.doesNotMatch(source, /check\.socks5\.090227\.xyz/i);
    assert.doesNotMatch(source, /raw\.githubusercontent\.com|github\.com\/|gitlab\.com\//i);
    assert.doesNotMatch(source, /\b(?:1\.1\.1\.1|8\.8\.8\.8|8\.8\.4\.4)\b/);
    assert.doesNotMatch(source, /https:\/\/speed\.cloudflare\.com\/locations/i);
});

test('legacy single-file backup is not present', () => {
    assert.equal(existsSync(join(repositoryRoot, '_worker.js.bak')), false);
});
