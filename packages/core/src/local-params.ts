/**
 * 服务本地参数容器。
 *
 * 背景：`ParamRegistry` 的键类型被冻结为说明书 §11 的 `ParamId` 联合类型，
 * 服务自身引入的数值（如子应用票据有效期、连接配额）无法挂进去。
 * 但"代码中禁止硬编码数值"是铁律，各泳道不能把数字直接写进逻辑。
 *
 * 因此提供本容器：服务在自己的 `src/params.ts` 里声明参数编号与默认值，
 * 通过 `LocalParams` 读取；部署可用 overrides 覆盖，诊断可导出 snapshot。
 *
 * 用法：
 * ```ts
 * export const SHELL_PARAM = {
 *   TICKET_TTL: 'PARAM-SHELL-TICKET-TTL',
 *   MAX_CONNECTION: 'PARAM-SHELL-MAX-CONNECTION',
 * } as const;
 *
 * export const SHELL_DEFAULTS = {
 *   [SHELL_PARAM.TICKET_TTL]: 60 * 1000,
 *   [SHELL_PARAM.MAX_CONNECTION]: 4,
 * } as const;
 *
 * const params = new LocalParams(SHELL_DEFAULTS);
 * params.number(SHELL_PARAM.TICKET_TTL);
 * ```
 */

export type LocalParamValue = number | string;
export type LocalParamDefaults<TId extends string> = Record<TId, LocalParamValue>;
export type LocalParamOverrides<TId extends string> = Partial<Record<TId, LocalParamValue>>;

/**
 * 参数编号必须显式带 `PARAM-` 前缀，便于静态审计（见 `verification/invariants.test.ts`）。
 */
export function assertParamIdShape(id: string): void {
  if (!/^PARAM-[A-Z0-9-]+$/.test(id)) {
    throw new Error(`参数编号不符合 PARAM-<大写中划线> 规范：${id}`);
  }
}

export class LocalParams<TId extends string> {
  #values: Map<TId, LocalParamValue | undefined>;
  readonly #defaults: LocalParamDefaults<TId>;

  constructor(defaults: LocalParamDefaults<TId>, overrides: LocalParamOverrides<TId> = {}) {
    for (const id of Object.keys(defaults) as TId[]) {
      assertParamIdShape(id);
    }
    this.#defaults = { ...defaults };
    this.#values = new Map(Object.entries(defaults) as [TId, LocalParamValue][]);
    for (const [key, value] of Object.entries(overrides) as [TId, LocalParamValue][]) {
      if (!this.#values.has(key)) {
        throw new Error(`LocalParams: 覆盖了未声明的参数 ${key}`);
      }
      this.#values.set(key, value);
    }
  }

  /** 取数值型参数；缺失或非数值时抛错（不静默兜底） */
  number(id: TId): number {
    const value = this.#values.get(id);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`LocalParams: 参数 ${id} 未配置为有效数值（当前 ${String(value)}）`);
    }
    return value;
  }

  numberOr(id: TId, fallback: number): number {
    const value = this.#values.get(id);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  string(id: TId): string {
    const value = this.#values.get(id);
    if (typeof value !== 'string') {
      throw new Error(`LocalParams: 参数 ${id} 未配置为字符串（当前 ${String(value)}）`);
    }
    return value;
  }

  has(id: TId): boolean {
    return this.#values.get(id) !== undefined;
  }

  /** 恢复到构造时的默认值（测试与回滚用） */
  reset(id?: TId): void {
    if (id === undefined) {
      this.#values = new Map(Object.entries(this.#defaults) as [TId, LocalParamValue][]);
      return;
    }
    this.#values.set(id, this.#defaults[id]);
  }

  /** 运行期覆盖（仅测试与热调整用；生产走构造注入） */
  set(id: TId, value: LocalParamValue): void {
    if (!this.#values.has(id)) {
      throw new Error(`LocalParams: 设置了未声明的参数 ${id}`);
    }
    this.#values.set(id, value);
  }

  raw(id: TId): LocalParamValue | undefined {
    return this.#values.get(id);
  }

  snapshot(): Record<string, LocalParamValue | undefined> {
    return Object.fromEntries(this.#values);
  }

  /** 参数编号清单，供审计与文档生成 */
  ids(): TId[] {
    return [...this.#values.keys()];
  }
}
