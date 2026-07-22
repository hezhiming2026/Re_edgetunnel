import { MD5MD5 } from '../src/utils/helpers.js';

const [baseUrlInput, uuid] = process.argv.slice(2);
const adminPassword = process.env.CLOUDFLARE_TEST_ADMIN;

if (!baseUrlInput || !uuid || !adminPassword) {
    console.error('Usage: CLOUDFLARE_TEST_ADMIN=... node scripts/verify-cloudflare-http.mjs <https-url> <uuid>');
    process.exit(2);
}

const baseUrl = new URL(baseUrlInput);
const request = (path, init = {}) => fetch(new URL(path, baseUrl), { redirect: 'manual', ...init });

function assertStatus(response, expected, label) {
    if (response.status !== expected) {
        throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
    }
    console.log(`${label}=HTTP_${response.status}`);
}

async function waitForKvValue(label, readValue, predicate) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const value = await readValue();
        if (predicate(value)) {
            console.log(`${label}=VISIBLE`);
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${label}: KV value did not become visible within 15 seconds`);
}

const unauthenticatedAdmin = await request('/admin');
assertStatus(unauthenticatedAdmin, 302, 'UNAUTHENTICATED_ADMIN_REDIRECT');

const login = await request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: adminPassword }),
});
assertStatus(login, 200, 'LOGIN');
const setCookie = login.headers.get('set-cookie') || '';
if (!/^auth=[0-9a-f]{64};/i.test(setCookie) || !/HttpOnly/i.test(setCookie) || !/Secure/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) {
    throw new Error('LOGIN: secure random session cookie was not returned');
}
const cookie = setCookie.split(';', 1)[0];

const authenticatedAdmin = await request('/admin/config.json', { headers: { Cookie: cookie } });
assertStatus(authenticatedAdmin, 200, 'AUTHENTICATED_ADMIN');
const config = await authenticatedAdmin.json();
if (!Array.isArray(config.支持协议) || !config.支持协议.includes('vless') || !config.支持协议.includes('trojan')) {
    throw new Error('AUTHENTICATED_ADMIN: expected VLESS and Trojan protocol support');
}

const csrfRejected = await request('/admin/config.json', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
});
assertStatus(csrfRejected, 403, 'CSRF_REJECTED');

const savedAddress = '203.0.113.10:443#operator-owned';
const saveAddressList = await request('/admin/ADD.txt', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl.origin, 'Content-Type': 'text/plain;charset=utf-8' },
    body: savedAddress,
});
assertStatus(saveAddressList, 200, 'OPERATOR_ADDRESS_LIST_SAVED');
await waitForKvValue(
    'OPERATOR_ADDRESS_LIST_KV',
    async () => {
        const response = await request('/admin/ADD.txt', { headers: { Cookie: cookie } });
        assertStatus(response, 200, 'OPERATOR_ADDRESS_LIST_READ');
        return response.text();
    },
    (value) => value.includes(savedAddress),
);

const proxyCheckWithoutOperatorTarget = await request('/admin/check?socks5=127.0.0.1%3A1080', {
    headers: { Cookie: cookie },
});
assertStatus(proxyCheckWithoutOperatorTarget, 503, 'UNCONFIGURED_PROXY_CHECK_REJECTED');

const locationsWithoutOperatorEndpoint = await request('/locations');
assertStatus(locationsWithoutOperatorEndpoint, 501, 'UNCONFIGURED_LOCATIONS_API_REJECTED');

const invalidSubscription = await request('/sub?token=invalid');
assertStatus(invalidSubscription, 403, 'INVALID_SUBSCRIPTION_TOKEN_REJECTED');

const subscriptionToken = await MD5MD5(`${baseUrl.hostname}${uuid}`);
const subscription = await request(`/sub?token=${subscriptionToken}&base64`);
assertStatus(subscription, 200, 'SUBSCRIPTION_GENERATED');
const decodedSubscription = Buffer.from(await subscription.text(), 'base64').toString('utf8');
if (!decodedSubscription.includes(`vless://${uuid}@203.0.113.10:443`)) {
    throw new Error('SUBSCRIPTION_GENERATED: expected VLESS URI was not generated');
}
console.log('SUBSCRIPTION_VLESS_URI_OK');

const trojanConfig = { ...config, 协议类型: 'trojan' };
const saveTrojanConfig = await request('/admin/config.json', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(trojanConfig),
});
assertStatus(saveTrojanConfig, 200, 'TROJAN_CONFIG_SAVED');
await waitForKvValue(
    'TROJAN_CONFIG_KV',
    async () => {
        const response = await request('/admin/config.json', { headers: { Cookie: cookie } });
        assertStatus(response, 200, 'TROJAN_CONFIG_READ');
        return response.json();
    },
    (value) => value.协议类型 === 'trojan',
);

const trojanSubscription = await request(`/sub?token=${subscriptionToken}&base64`);
assertStatus(trojanSubscription, 200, 'TROJAN_SUBSCRIPTION_GENERATED');
const decodedTrojanSubscription = Buffer.from(await trojanSubscription.text(), 'base64').toString('utf8');
if (!decodedTrojanSubscription.includes(`trojan://${uuid}@203.0.113.10:443`) || decodedTrojanSubscription.includes('encryption=none')) {
    throw new Error('TROJAN_SUBSCRIPTION_GENERATED: expected protocol-correct Trojan URI was not generated');
}
console.log('SUBSCRIPTION_TROJAN_URI_OK');

const sameOriginMutation = await request('/admin/init', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl.origin },
});
assertStatus(sameOriginMutation, 200, 'SAME_ORIGIN_RESET');

const logout = await request('/logout', { headers: { Cookie: cookie } });
assertStatus(logout, 302, 'LOGOUT');
if (!/Max-Age=0/i.test(logout.headers.get('set-cookie') || '')) {
    throw new Error('LOGOUT: session cookie was not expired');
}

let revokedSession;
for (let attempt = 0; attempt < 10; attempt += 1) {
    revokedSession = await request('/admin', { headers: { Cookie: cookie } });
    if (revokedSession.status === 302) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
}
assertStatus(revokedSession, 302, 'REVOKED_SESSION_REJECTED');

console.log('CLOUDFLARE_HTTP_AUTH_KV_SUBSCRIPTION_OK');
