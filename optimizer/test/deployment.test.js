import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('optimizer container is non-root with a read-only root filesystem and no public ports', async () => {
  const dockerfile = await read('deploy/nas/optimizer.Dockerfile');
  const compose = await read('deploy/nas/docker-compose.optimizer.yml');
  assert.match(dockerfile, /USER\s+10001(?::10001)?/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /- \.\/optimizer-data:\/data/);
  assert.doesNotMatch(compose, /\bports:/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
});

test('example environment is non-publishing and contains placeholders only', async () => {
  const env = await read('deploy/nas/optimizer.env.example');
  assert.match(env, /^PUBLISH_ENABLED=false$/m);
  assert.match(env, /^WORKER_BASE_URL=https:\/\/worker\.example\.invalid$/m);
  assert.match(env, /^EDGE_HOSTNAME=worker\.example\.invalid$/m);
  assert.doesNotMatch(env, /tianbufu|EDGETUNNEL_ADMIN|CLOUDFLARE_API_TOKEN/i);
});

test('NAS runbook documents canary, dry-run, shadow publish, and manual handoff before daemon publishing', async () => {
  const doc = await read('docs/operations/nas-optimizer.md');
  assert.match(doc, /canary/i);
  assert.match(doc, /--dry-run/);
  assert.match(doc, /published_shadow_manual/);
  assert.match(doc, /manual override/i);
  assert.match(doc, /PUBLISH_ENABLED=true/);
});
