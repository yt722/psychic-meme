import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARAM,
  ParamRegistry,
  DEFAULT_PARAMS,
  assertRequiredParams,
  type ParamId,
} from '../src/index.js';

describe('params: 基线默认值（说明书 §11）', () => {
  it('连接器参数默认值正确', () => {
    const p = new ParamRegistry();
    assert.equal(p.number(PARAM.CONNECTOR_TIMEOUT), 5000);
    assert.equal(p.number(PARAM.CONNECTOR_RETRY), 2);
    assert.equal(p.number(PARAM.CONNECTOR_POLL), 5 * 60 * 1000);
  });

  it('调度关键参数默认值正确', () => {
    const p = new ParamRegistry();
    assert.equal(p.number(PARAM.SEAT_HOLD), 15 * 60 * 1000);
    assert.equal(p.number(PARAM.HEARTBEAT), 30 * 1000);
    assert.equal(p.number(PARAM.DEAD_CYCLES), 2);
    assert.equal(p.number(PARAM.TTL_GRACE), 10 * 60 * 1000);
    assert.equal(p.number(PARAM.RENEW_MAX), 3);
    assert.equal(p.number(PARAM.SEAT_HANDOVER), 60 * 1000);
    assert.equal(p.number(PARAM.VU_LICENSE), 30);
    assert.equal(p.number(PARAM.RELEASE_RETRY), 2);
    assert.equal(p.number(PARAM.RECLAIM_BATCH), 50);
    assert.equal(p.number(PARAM.RECLAIM_GAP), 5000);
  });

  it('地图判离线/恢复默认值正确', () => {
    const p = new ParamRegistry();
    assert.equal(p.number(PARAM.OFFLINE_JUDGE), 2 * 60 * 1000);
    assert.equal(p.number(PARAM.ONLINE_JUDGE), 1 * 60 * 1000);
    assert.equal(p.number(PARAM.MAP_FALLBACK), 6000);
    assert.equal(p.number(PARAM.MAP_BROADCAST), 1);
    assert.equal(p.number(PARAM.MAP_RECONCILE), 5 * 60 * 1000);
  });

  it('报警与 AI 参数默认值正确', () => {
    const p = new ParamRegistry();
    assert.equal(p.number(PARAM.ALARM_MERGE), 5 * 60 * 1000);
    assert.equal(p.number(PARAM.ALARM_STORM), 60 * 1000);
    assert.equal(p.number(PARAM.AI_TIMEOUT), 2000);
    assert.equal(p.number(PARAM.AI_CONCURRENCY), 20);
    assert.equal(p.number(PARAM.AI_BREAK), 3);
  });

  it('运维参数默认值正确', () => {
    const p = new ParamRegistry();
    assert.equal(p.number(PARAM.REAL_CELL_PARALLEL), 2);
    assert.equal(p.number(PARAM.P1_NOTIFY), 15 * 60 * 1000);
    assert.equal(p.number(PARAM.MAINT_NOTICE), 48 * 60 * 60 * 1000);
  });
});

describe('params: 非数值参数', () => {
  it('保留原始字符串值', () => {
    const p = new ParamRegistry();
    assert.equal(p.string(PARAM.MASK_STUDENT), '前 2 + **** + 后 2');
    assert.equal(p.string(PARAM.BATCH_WINDOW), '22:00-06:00');
    assert.equal(p.string(PARAM.TTL_WARN), '60s/30s/5s');
    assert.equal(p.string(PARAM.TEACHING_HOURS), '工作日 8:00-18:00');
  });

  it('对数值型参数调用 string() 抛错', () => {
    const p = new ParamRegistry();
    assert.throws(() => p.string(PARAM.HEARTBEAT), /未配置为字符串/);
  });

  it('对字符串型参数调用 number() 抛错', () => {
    const p = new ParamRegistry();
    assert.throws(() => p.number(PARAM.MASK_STUDENT), /未配置为有效数值/);
  });
});

describe('params: 部署覆盖', () => {
  it('覆盖值生效，未覆盖的保持默认', () => {
    const p = new ParamRegistry({
      [PARAM.HEARTBEAT]: 15_000,
      [PARAM.VU_LICENSE]: 60,
    });
    assert.equal(p.number(PARAM.HEARTBEAT), 15_000);
    assert.equal(p.number(PARAM.VU_LICENSE), 60);
    assert.equal(p.number(PARAM.DEAD_CYCLES), 2, '未覆盖项应保持默认');
  });

  it('numberOr 在缺失时用兜底值', () => {
    const p = new ParamRegistry();
    assert.equal(p.numberOr(PARAM.SERVER_INSTANCE_MAX, 10), 10);
    assert.equal(p.numberOr(PARAM.HEARTBEAT, 999), 30_000);
  });

  it('snapshot 导出全部参数供诊断', () => {
    const p = new ParamRegistry();
    const snap = p.snapshot();
    assert.equal(snap[PARAM.HEARTBEAT], 30_000);
    assert.equal(snap[PARAM.MASK_STUDENT], '前 2 + **** + 后 2');
  });
});

describe('params: 必须由部署提供的参数', () => {
  it('PARAM-SERVER-INSTANCE-MAX 默认未配置（不猜测兜底）', () => {
    const p = new ParamRegistry();
    assert.equal(p.has(PARAM.SERVER_INSTANCE_MAX), false);
  });

  it('缺失时必须由 assertRequiredParams 暴露，而不是运行期兜底', () => {
    const p = new ParamRegistry();
    assert.throws(
      () => assertRequiredParams(p, [PARAM.SERVER_INSTANCE_MAX]),
      /必须由部署配置提供/,
    );
  });

  it('配置后校验通过', () => {
    const p = new ParamRegistry({ [PARAM.SERVER_INSTANCE_MAX]: 20 });
    assert.doesNotThrow(() => assertRequiredParams(p, [PARAM.SERVER_INSTANCE_MAX]));
  });
});

describe('params: 编号完整性', () => {
  it('所有参数编号符合 PARAM-<大写-连字符> 格式', () => {
    for (const id of Object.values(PARAM)) {
      assert.match(id, /^PARAM-[A-Z0-9-]+$/, `编号格式不符：${id}`);
    }
  });

  it('参数编号无重复', () => {
    const ids = Object.values(PARAM);
    assert.equal(new Set(ids).size, ids.length, '存在重复的参数编号');
  });

  it('DEFAULT_PARAMS 覆盖全部编号', () => {
    for (const id of Object.values(PARAM)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, id),
        `DEFAULT_PARAMS 缺少 ${id}`,
      );
    }
  });

  it('每个默认值类型合法（number 有限 / string 非空 / undefined 表示必须部署提供）', () => {
    for (const [id, value] of Object.entries(DEFAULT_PARAMS) as [ParamId, number | string | undefined][]) {
      if (value === undefined) continue;
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${id} 数值非法`);
      } else {
        assert.ok(value.length > 0, `${id} 字符串为空`);
      }
    }
  });
});
