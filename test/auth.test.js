import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAuth, handleLogin, handleLogout, isTrustedRequestOrigin } from '../src/controllers/auth.js';

class MemoryKV {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key) ?? null; }
    async put(key, value) { this.values.set(key, value); }
    async delete(key) { this.values.delete(key); }
}

function request(url, options = {}) {
    return new Request(url, options);
}

test('admin sessions are random, server-backed, and revoked on logout', async () => {
    const env = { ADMIN: 'correct horse battery staple', KV: new MemoryKV() };
    const login = await handleLogin(request('https://worker.example/login', {
        method: 'POST',
        body: 'password=correct+horse+battery+staple',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }), env);
    const cookie = login.headers.get('Set-Cookie');

    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(await checkAuth(request('https://worker.example/admin', { headers: { Cookie: cookie } }), env), true);

    await handleLogout(request('https://worker.example/logout', { headers: { Cookie: cookie } }), env);
    assert.equal(await checkAuth(request('https://worker.example/admin', { headers: { Cookie: cookie } }), env), false);
});

test('trusted mutation origin only accepts the Worker origin', () => {
    assert.equal(isTrustedRequestOrigin(request('https://worker.example/admin/init', { method: 'POST', headers: { Origin: 'https://worker.example' } })), true);
    assert.equal(isTrustedRequestOrigin(request('https://worker.example/admin/init', { method: 'POST', headers: { Origin: 'https://attacker.example' } })), false);
    assert.equal(isTrustedRequestOrigin(request('https://worker.example/admin/init', { method: 'POST' })), false);
});

test('login fallback is self-hosted and does not require a remote page', async () => {
    const response = await handleLogin(request('https://worker.example/login'), { ADMIN: 'secret', KV: new MemoryKV() });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<form method="post">/);
});
