import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { parseToolkitState, makeAction, messages, createToolkitClient } from '../client/toolkit.js'

const state = { scope: 'a'.repeat(64), key: 'b'.repeat(64), settings: { revision: 'initial', hiddenModels: [], reasoning: {} }, models: [], runtime: {}, retry: {}, diagnostic: {} }
test('client validates state identity and creates closed scoped actions', () => {
  assert.equal(parseToolkitState({ ...state, scope: 'bad' }), undefined)
  assert.equal(parseToolkitState({ ...state, key: '' }), undefined)
  assert.deepEqual(makeAction(state, 'clear-cache'), { action: 'clear-cache', scope: state.scope, revision: 'initial' })
  assert.deepEqual(makeAction(state, 'settings', { hiddenModels: ['glm'] }).patch.hiddenModels, ['glm'])
  assert.ok(messages.zh.title.includes('ZCode'))
  assert.ok(messages.en.title.includes('ZCode'))
})
test('client contributes the existing DSH config seat and disposes through host lifetimes', () => {
  const registrations = []
  const ctx = { effect: callback => callback(), locale: { register: () => () => {}, bind: () => key => messages.zh[key] },
    slots: { inject: (_, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {} } } }
  const client = createToolkitClient({ createElement() {}, useState() {}, useEffect() {}, useRef() {} })
  client.apply(ctx)
  assert.equal(registrations[0].options.key, 'dsh-zcode-plan-bridge')
  assert.equal(registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(typeof registrations[0].component, 'function')
})
test('browser artifact registers through the module loader with only host React', () => {
  let module
  const window = { __ModuleLoader__: { load: value => { module = value } } }
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window })
  assert.equal(module.id, 'dsh-zcode-plan-bridge')
  const loaded = module.factory(name => { assert.equal(name, 'react'); return {} })
  assert.equal(typeof loaded.apply, 'function')
  assert.doesNotMatch(source, /node:|dangerouslySetInnerHTML|innerHTML\s*=/)
})
