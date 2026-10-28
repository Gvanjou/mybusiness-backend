import assert from 'node:assert/strict'
import { test } from 'node:test'

// Google sign-in in the backend, without calling Google: the redirect carries PKCE and state, a callback that does
// not match the sign-in started in this browser is refused, and nothing in the chat works signed out.

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
const { app } = await import('../src/app.js')
const site = { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' }

test('sign-in starts at Google with PKCE, state and our callback', async () => {
  const res = await app.request('/api/auth/google?next=/en', { headers: site })
  assert.equal(res.status, 302)
  const url = new URL(res.headers.get('location')!)
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/callback')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('state'))
  const cookie = res.headers.get('set-cookie') ?? ''
  assert.match(cookie, /mb_oauth=/)
  assert.match(cookie, /HttpOnly/)
})

test('a callback that was not started in this browser is refused', async () => {
  const start = await app.request('/api/auth/google?next=/en', { headers: site })
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!
  const res = await app.request('/api/auth/callback?code=abc&state=forged', { headers: { ...site, cookie } })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'http://localhost:3000/ka?auth=failed')
  const noCookie = await app.request('/api/auth/callback?code=abc&state=x', { headers: site })
  assert.equal(noCookie.headers.get('location'), 'http://localhost:3000/ka?auth=failed')
})

test('signed out: the user and the chat answer 401', async () => {
  for (const path of ['/api/auth/me', '/api/assistant/session', '/api/assistant/usage', '/api/assistant/conversations']) {
    const res = await app.request(path, { headers: site })
    assert.equal(res.status, 401, path)
  }
})

test('changes from another website are blocked', async () => {
  const res = await app.request('/api/assistant/session', { method: 'POST', headers: { ...site, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"locale":"ka"}' })
  assert.equal(res.status, 403)
})
