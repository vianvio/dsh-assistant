/** 协议编解码与校验。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COALESCED_KINDS,
  PetMessageKind,
  PetState,
  createMessage,
  decodeMessage,
  encodeMessage,
} from '../src/protocol.js'

test('协议：未知 kind / 版本不匹配会被拒绝', () => {
  assert.throws(() => createMessage('nope'))
  const message = createMessage(PetMessageKind.STATE, { state: PetState.IDLE })
  assert.equal(message.v, 1)
  assert.ok(encodeMessage(message).endsWith('\n'))
  // 契约：脏输入一律返回 undefined（调用方只需判空，不必 try/catch）
  assert.equal(decodeMessage(JSON.stringify({ v: 2, kind: 'state', state: 'IDLE' })), undefined)
  assert.equal(decodeMessage(JSON.stringify({ v: 1, kind: 'state', state: 'BUSY' })), undefined)
  assert.equal(decodeMessage('not json'), undefined)
  assert.equal(decodeMessage('   '), undefined)
})

test('协议：state/pulse 必须携带合法状态值', () => {
  assert.throws(() => createMessage(PetMessageKind.STATE, { state: 'BUSY' }), '构造时就该拦住')
  const ok = decodeMessage(encodeMessage(createMessage(PetMessageKind.PULSE, { state: PetState.SUCCESS })))
  assert.equal(ok.state, PetState.SUCCESS)
})

test('协议：通知必须带非空 id（否则永远清不掉）', () => {
  assert.throws(() => createMessage(PetMessageKind.NOTICE, { title: 'x' }))
  assert.throws(() => createMessage(PetMessageKind.NOTICE, { id: '' }))
  assert.ok(createMessage(PetMessageKind.NOTICE, { id: 'a:1' }))
})

test('协议：可合并的消息只列了"覆盖即可"的那几种', () => {
  // 顺序敏感的消息（通知/清通知/总结）必须保序补发，不能进合并表
  assert.deepEqual([...COALESCED_KINDS].sort(), ['config', 'hello', 'overlay', 'state'])
  assert.ok(!COALESCED_KINDS.includes(PetMessageKind.NOTICE))
  assert.ok(!COALESCED_KINDS.includes(PetMessageKind.NOTICE_CLEAR))
})
