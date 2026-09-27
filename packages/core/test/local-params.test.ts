import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalParams, assertParamIdShape } from '../src/index.js';

const P = {
  TICKET_TTL: 'PARAM-SHELL-TICKET-TTL',
  MAX_CONNECTION: 'PARAM-SHELL-MAX-CONNECTION',
  APP_NAME: 'PARAM-SHELL-APP-NAME',
} as const;

const DEFAULTS = {
  [P.TICKET_TTL]: 60_000,
  [P.MAX_CONNECTION]: 4,
  [P.APP_NAME]: 'train-lab',
} as const;

test('默认值可直接读取', () => {
  const params = new LocalParams(DEFAULTS);
  assert.equal(params.number(P.TICKET_TTL), 60_000);
  assert.equal(params.number(P.MAX_CONNECTION), 4);
  assert.equal(params.string(P.APP_NAME), 'train-lab');
});

test('构造覆盖优先于默认值', () => {
  const params = new LocalParams(DEFAULTS, { [P.MAX_CONNECTION]: 8 });
  assert.equal(params.number(P.MAX_CONNECTION), 8);
  assert.equal(params.number(P.TICKET_TTL), 60_000);
});

test('读取缺失参数抛错而不静默兜底', () => {
  const params = new LocalParams({ [P.TICKET_TTL]: undefined as unknown as number } as never);
  assert.throws(() => params.number(P.TICKET_TTL), /未配置为有效数值/);
});

test('numberOr 仅在缺省时使用调用方兜底', () => {
  const params = new LocalParams(DEFAULTS);
  assert.equal(params.numberOr(P.TICKET_TTL, 1), 60_000);
  assert.equal(params.numberOr('PARAM-NOT-DECLARED' as never, 99), 99);
});

test('string 读取非字符串参数抛错', () => {
  const params = new LocalParams(DEFAULTS);
  assert.throws(() => params.string(P.TICKET_TTL), /未配置为字符串/);
});

test('覆盖未声明的参数被拒绝', () => {
  assert.throws(
    () => new LocalParams(DEFAULTS, { ['PARAM-UNKNOWN']: 1 } as never),
    /覆盖了未声明的参数/,
  );
});

test('set 只能改已声明的参数', () => {
  const params = new LocalParams(DEFAULTS);
  params.set(P.TICKET_TTL, 30_000);
  assert.equal(params.number(P.TICKET_TTL), 30_000);
  assert.throws(() => params.set('PARAM-UNKNOWN' as never, 1), /设置了未声明的参数/);
});

test('reset 恢复单个或全部默认值', () => {
  const params = new LocalParams(DEFAULTS);
  params.set(P.TICKET_TTL, 30_000);
  params.set(P.MAX_CONNECTION, 9);
  params.reset(P.TICKET_TTL);
  assert.equal(params.number(P.TICKET_TTL), 60_000);
  assert.equal(params.number(P.MAX_CONNECTION), 9);
  params.reset();
  assert.equal(params.number(P.MAX_CONNECTION), 4);
});

test('参数编号形状校验', () => {
  assert.doesNotThrow(() => assertParamIdShape('PARAM-SHELL-TICKET-TTL'));
  assert.throws(() => assertParamIdShape('SHELL-TICKET-TTL'), /不符合/);
  assert.throws(() => assertParamIdShape('PARAM-shell-ttl'), /不符合/);
  assert.throws(() => assertParamIdShape('PARAM-'), /不符合/);
});

test('声明阶段即校验编号形状', () => {
  assert.throws(() => new LocalParams({ 'bad-id': 1 } as never), /不符合/);
});

test('has / raw / snapshot / ids 诊断接口', () => {
  const params = new LocalParams(DEFAULTS);
  assert.equal(params.has(P.TICKET_TTL), true);
  assert.equal(params.has('PARAM-NOPE' as never), false);
  assert.equal(params.raw(P.MAX_CONNECTION), 4);
  assert.deepEqual(params.snapshot()[P.TICKET_TTL], 60_000);
  assert.deepEqual(params.ids().sort(), [P.APP_NAME, P.MAX_CONNECTION, P.TICKET_TTL].sort());
});
