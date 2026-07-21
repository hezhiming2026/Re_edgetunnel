
import { loginPage } from '../utils/pages.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24;
const SESSION_PREFIX = 'session:';

function getAdminPassword(env) {
    return env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || env.UUID || env.uuid;
}

function getCookie(request, name) {
    const cookies = request.headers.get('Cookie') || '';
    return cookies.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function sessionKey(token) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return `${SESSION_PREFIX}${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function createSessionToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isTrustedRequestOrigin(request) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin) return origin === requestUrl.origin;

    const referer = request.headers.get('Referer');
    if (!referer) return false;
    try {
        return new URL(referer).origin === requestUrl.origin;
    } catch {
        return false;
    }
}

export async function checkAuth(request, env) {
    const authCookie = getCookie(request, 'auth');
    if (!authCookie || !env.KV?.get) return false;

    return (await env.KV.get(await sessionKey(authCookie))) === 'active';
}

export async function handleLogin(request, env) {
    const adminPassword = getAdminPassword(env);

    if (request.method === 'POST' && adminPassword && env.KV?.put) {
        const formData = await request.text();
        const params = new URLSearchParams(formData);
        const inputPassword = params.get('password');
        if (inputPassword === adminPassword) {
            const authValue = createSessionToken();
            await env.KV.put(await sessionKey(authValue), 'active', { expirationTtl: SESSION_TTL_SECONDS });
            const response = new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json;charset=utf-8' } });
            response.headers.set('Set-Cookie', `auth=${authValue}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
            return response;
        }
    }
    return new Response(loginPage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handleLogout(request, env) {
    const authCookie = getCookie(request, 'auth');
    if (authCookie && env.KV?.delete) {
        await env.KV.delete(await sessionKey(authCookie));
    }
    const response = new Response('Redirecting...', { status: 302, headers: { 'Location': '/login' } });
    response.headers.set('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return response;
}
