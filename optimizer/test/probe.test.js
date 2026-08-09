import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { once } from 'node:events';
import { probeCandidate } from '../src/probe.js';

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDh70OGLyM/a/rt
32yle82RWTyciEdPTqN8vQO40DiXWNUi17QqCwA9Wkl31Qc9bgyILKrhsbDR3Dnk
cFyxRBVOPiTw0Wz7RkmaRL5acm8HVdfVn0GBSf1V59BjUk43NxZF7D6J4srWbWv1
t1+uKOCosINFAwz43pAj5/MmYGg+7HItcG0Zq068F6LZCd1lz/GNYzRuZcN2Nb4n
xNaIKisPj9Ws8BPV4TuZjXZvHlARcBaGlG6+/0he+GLQ0GOf0YnfviMOnpEnU7AW
sQC7CbzWUhcZrP1aeVGDjtZwoa3pOATdpve8Xxn0xQXzLLG+KeID5JcFJSxISCih
hOz9p40PAgMBAAECggEAUNueyGKNVFDSPJh12yGcF9UedozlLHJh2y4QK2/FmRCv
MqmM7nECdHKgEXVZgngknwWRYHWF6Q1OYL1/xuctUtO1x8PDo4frpnzMvTTwHGlx
9Z9pw5oVws1UTH9zw5oA7CRY22Mhoa0GcqleYkd545VMXYHyfgy0/EyyPf1JwZ6U
IcgyXFXbKNjyFGQKH2Q2NYhXJ2IRnwxzXpbO7j37hC4hSb/YJOee1ybSWOrBTBD9
qrXxPJxJBOymlcKMJ8m93D/Td6uuhN/ZCEljNj0sT+2hBVr4A3Xsijstsq0mEl1i
UNZ6NaB3XL/qKgl+dfdH6cXtnCOiQnvmv4fXCXO5EQKBgQD4OkWjdytCmDeGuwLR
auEItTWwK+EViyMVSM/PXoS4IGBc4GdgukN5jJ1/+zPo3k9B03gSnnKHaMH4NVRN
142/8wCltk7hhM3P8Ff0WyBsnKP1vJBeA3Qb+L9lLlvtjx7l5YoQk/Rf10vuiSQR
EbrgMPrwwuwhjfP1L7jspzncvwKBgQDpAkv+hDFpg3tmdZ35ztK1z1NNLRWxU+y1
v/lDP3GpPozp0/XENWTcuSSe9SJdvROdsrHgSxQy7QPZKfFMrKKetTnKNk4DmJCP
6JZtbV7akC4jmfYunl2D0jTvGiEzXErftz5Lzp6M5JlDfQ0JhswDVcFG7bOoyHY1
crfc5OxTsQKBgQCDo0t48+KiL10K+zP0YOy0FH1DTxHPvfi9+d4Sx7o0dx8DQhIw
rrbHx/VigJI3xWVcsEu1/Acankh3W7i4iz5l8/V86+CLIkWPJ5NNR+I7FxqwX+5j
nQs/JjxB6ULhCYxGOONuBTiMdv2So3HYB4IGEJOTiJt28/PTLBqyjcBWuwKBgFJq
0pCDF6s3q5VRMwCiTFusqs1Yjhy8D7U14ygLL9vqWRN4Oq0dKcD859wl3vMDJwYX
p90rEUj2Fu9ga45wXdD/TyKcVLnm4/NTFKo+DlgGuZs0ISTaNT+kQb71Ihs1oPJC
sZFE00YIscFyYQMmn9DqK0Q4XdzskwtSuYAzpPfxAoGBAIsb88Ob6VL8ws/GLuBc
Pv/92XF5+f5sDhhIpWogRSH+9qZkfd5jAnr9ndmN6zHisJeJW5iZMhRcGXpOaHUe
P3D0rurRaHbiQYn70mmAjipDsiyPLzhtfw+Utg0p44ZMXQqCo45+fYy7npEhKIW8
gN351JiUmbApxHSbNeGpNJyE
-----END PRIVATE KEY-----`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIULXVHwWnrieODU+so/WXxVYn01bowDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRZWRnZS5leGFtcGxlLnRlc3QwHhcNMjYwODA5MDc1ODAz
WhcNMzYwODA2MDc1ODAzWjAcMRowGAYDVQQDDBFlZGdlLmV4YW1wbGUudGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOHvQ4YvIz9r+u3fbKV7zZFZ
PJyIR09Oo3y9A7jQOJdY1SLXtCoLAD1aSXfVBz1uDIgsquGxsNHcOeRwXLFEFU4+
JPDRbPtGSZpEvlpybwdV19WfQYFJ/VXn0GNSTjc3FkXsPoniytZta/W3X64o4Kiw
g0UDDPjekCPn8yZgaD7sci1wbRmrTrwXotkJ3WXP8Y1jNG5lw3Y1vifE1ogqKw+P
1azwE9XhO5mNdm8eUBFwFoaUbr7/SF74YtDQY5/Rid++Iw6ekSdTsBaxALsJvNZS
Fxms/Vp5UYOO1nChrek4BN2m97xfGfTFBfMssb4p4gPklwUlLEhIKKGE7P2njQ8C
AwEAAaNhMF8wHAYDVR0RBBUwE4IRZWRnZS5leGFtcGxlLnRlc3QwCwYDVR0PBAQD
AgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBSaeLYf5gBo4BPaxC2J
0aDdtzGicDANBgkqhkiG9w0BAQsFAAOCAQEAHWtGAoT3m9VSKljOh8c+Rrdhc0k0
b/ILiqfDF3KJGHETNwwvFgkUei4/T5ZMks7dNjj4LLRzW7Up6kDEwvSiV8BvKwYD
QzqoJLVC9Pya/xaNGP7bgKxK2DQQabon8oS7Aj63U9lDEdROJ/KlM8LH7EIjElGB
NEI/iDaFevpGK56/zJ+g57aEqtGTtF5BlcJ0QYndriqYnfQDyJfeLQcajTK7SRtR
9uL9RreLe34GFNc0BLuePtrKyhM2c7KE1P4QjgoaU3ezhHjGRoDF/ACUOB7DOQcb
/WsicInCH0/buwWyPn8uzZ4WeyMWQ1KIXHN2FfhZIrzK9HEvMAGVVni6wQ==
-----END CERTIFICATE-----`;

test('probe connects to candidate IP while using configured SNI and Host', async (t) => {
  let observedSni = null;
  let observedHost = null;
  let observedAuth = null;
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
    observedSni = socket.servername;
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (!request.includes('\r\n\r\n')) return;
      observedHost = /\r\nHost: ([^\r\n]+)/i.exec(request)?.[1] || null;
      observedAuth = /\r\nAuthorization: ([^\r\n]+)/i.exec(request)?.[1] || null;
      const body = Buffer.alloc(64 * 1024, 7);
      const head = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nX-Optimizer-Probe-Version: 1\r\nConnection: close\r\n\r\n`);
      socket.end(Buffer.concat([head, body]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;

  const result = await probeCandidate({
    address: '127.0.0.1',
    hostname: 'edge.example.test',
    token: 'test-machine-token',
    timeoutMs: 2000,
    payloadPath: '/ops/optimizer/v1/probe',
  }, { port, ca: CERT });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, 65536);
  assert.equal(observedSni, 'edge.example.test');
  assert.equal(observedHost, 'edge.example.test');
  assert.equal(observedAuth, 'Bearer test-machine-token');
  assert.ok(result.tcpMs >= 0 && result.tlsMs >= result.tcpMs);
  assert.ok(result.ttfbMs >= result.tlsMs && result.totalMs >= result.ttfbMs);
});

test('certificate hostname validation remains enabled', async (t) => {
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const result = await probeCandidate({
    address: '127.0.0.1',
    hostname: 'wrong.example.test',
    token: 'test-machine-token',
    timeoutMs: 1000,
    payloadPath: '/ops/optimizer/v1/probe',
  }, { port: server.address().port, ca: CERT });
  assert.equal(result.ok, false);
  assert.match(result.error, /tls|certificate/i);
});
