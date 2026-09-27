/**
 * 可注入时钟。
 *
 * 所有时间判定必须走时钟，禁止直接 `new Date()` / `Date.now()`——
 * 否则超时、过期、判死窗口无法在测试中推进，也无法做到确定性复现。
 */

export interface Clock {
  /** 当前时间毫秒时间戳 */
  now(): number;
  /** 当前时间 ISO-8601（带时区），用于所有对外响应 */
  iso(): string;
}

/** 真实系统时钟 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  iso(): string {
    return toIso(this.now());
  }
}

/**
 * 可推进的假时钟（替身 D-03）。
 *
 * 用于测试超时重试、租约过期、心跳判死窗口，无需真实等待。
 */
export class FakeClock implements Clock {
  #current: number;
  /** 记录所有被推进的时间点，便于断言 */
  readonly advances: number[] = [];

  constructor(startIso: string | number = '2026-10-12T09:00:00+08:00') {
    this.#current = typeof startIso === 'number' ? startIso : Date.parse(startIso);
    if (Number.isNaN(this.#current)) {
      throw new Error(`FakeClock: 无法解析起始时间 ${String(startIso)}`);
    }
  }

  now(): number {
    return this.#current;
  }

  iso(): string {
    return toIso(this.#current);
  }

  /** 前进指定毫秒 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`FakeClock.advance: 需要非负有限毫秒，收到 ${String(ms)}`);
    }
    this.#current += ms;
    this.advances.push(ms);
  }

  /** 前进指定秒 */
  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  /** 前进指定分钟 */
  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  /** 直接设定到某个时间 */
  set(iso: string | number): void {
    const next = typeof iso === 'number' ? iso : Date.parse(iso);
    if (Number.isNaN(next)) {
      throw new Error(`FakeClock.set: 无法解析时间 ${String(iso)}`);
    }
    this.#current = next;
  }
}

/**
 * 转 ISO-8601 带时区字符串。
 *
 * 说明书要求所有对外响应带 `serverTime`，且必须带时区（避免跨时区歧义）。
 * 统一使用东八区（校方时区），格式 `YYYY-MM-DDTHH:mm:ss+08:00`。
 */
export function toIso(epochMs: number, offsetMinutes = 480): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');

  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');

  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`;
}

/** 解析 ISO-8601 为毫秒时间戳；非法输入抛错（不静默兜底） */
export function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`parseIso: 无法解析 ISO-8601 时间「${iso}」`);
  }
  return ms;
}
