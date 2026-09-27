/**
 * 旧名转发：本文件已改名为 `site-live.ts`（多工位：工位1 + 工位2）。
 *
 * 保留旧名的理由：现场命令、笔记与文档里写的是 `public/station1-live.ts`，
 * 直接删文件会让"照着旧命令跑"的人以为脚本丢了。这里**只有一行转发**，
 * 不含任何实现——两份实现必然漂移，转发不会。
 *
 * 用法（与 `site-live.ts` 完全一致）：
 *   node --import tsx public/station1-live.ts 8731
 *   node --import tsx public/site-live.ts 8731      # 推荐用这个新名
 *
 * 参数见 `site-live.ts` 头部注释（`--subnet2=` / `--identity2=` 等为工位2 专用）。
 */
import './site-live.js';
