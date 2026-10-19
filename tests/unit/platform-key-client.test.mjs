import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importFrontend } from '../helpers/bundle-frontend.mjs'
const { createAdminApi } = await importFrontend('frontend/platform/src/admin/api.ts')

function harness(t, replies) {
  const previousFetch = globalThis.fetch, previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const calls = [], ceremonies = []
  const bytes = new Uint8Array([1,2,3]).buffer
  const credential = {id:'synthetic',rawId:bytes,type:'public-key',getClientExtensionResults:()=>({}),response:{clientDataJSON:bytes,attestationObject:bytes,authenticatorData:bytes,signature:bytes,userHandle:bytes}}
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{credentials:{get:async()=>{ceremonies.push('existing-key');return credential},create:async()=>{ceremonies.push('new-key');return credential}}} })
  globalThis.fetch = async (url, init) => {
    calls.push(url)
    assert.equal(init.headers['X-CSRF-Token'], 'synthetic-csrf')
    const next = replies.shift(); assert.ok(next, 'unexpected retry')
    return new Response(JSON.stringify(next.body), {status:next.status||200,headers:{'content-type':'application/json'}})
  }
  t.after(()=>{globalThis.fetch=previousFetch;if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else delete globalThis.navigator})
  return {calls,ceremonies,api:createAdminApi('synthetic-csrf',()=>assert.fail('unexpected logout'))}
}

test('adding a security key verifies the existing factor before requesting a fresh enrollment', async t => {
  const {api,calls,ceremonies} = harness(t, [
    {status:403,body:{code:'MFA_STEP_UP_REQUIRED'}},
    {body:{challengeId:'assertion',options:{challenge:'dGVzdA',allowCredentials:[]}}},
    {body:{success:true}},
    {body:{challengeId:'registration',options:{challenge:'dGVzdA',user:{id:'dGVzdA'},excludeCredentials:[]}}},
    {body:{success:true}},
  ])
  await api.registerSecurityKey()
  assert.deepEqual(ceremonies,['existing-key','new-key'])
  assert.deepEqual(calls.map(url=>url.replace('/api/auth/mfa/','')),['registration/options','assertion/options','assertion/verify','registration/options','registration/verify'])
})

test('expired first-key enrollment asks for sign-in again without recursive retries', async t => {
  const {api,calls,ceremonies} = harness(t, [{status:403,body:{code:'MFA_REAUTH_REQUIRED',message:'Sign in again.'}}])
  await assert.rejects(api.registerSecurityKey(), error=>error.code==='MFA_REAUTH_REQUIRED')
  assert.equal(calls.length,1)
  assert.deepEqual(ceremonies,[])
})
