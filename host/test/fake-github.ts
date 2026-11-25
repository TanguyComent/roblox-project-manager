import { createGithubClient } from '../src/github.ts'

// Faux GitHub : repond a GET /user et POST /repos/.../generate, et garde la trace des appels.
export function fakeGithub(o: { login?: string; userStatus?: number; generate?: () => Response } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/user')) {
      return o.userStatus && o.userStatus !== 200
        ? new Response(JSON.stringify({ message: 'Bad credentials' }), { status: o.userStatus })
        : new Response(JSON.stringify({ login: o.login ?? 'acme' }), { status: 200 })
    }
    if (url.includes('/generate')) {
      return o.generate
        ? o.generate()
        : new Response(JSON.stringify({ full_name: 'acme/steal-treasure', html_url: 'https://github.com/acme/steal-treasure' }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { calls, githubFor: (token: string) => createGithubClient(token, fetchImpl) }
}
