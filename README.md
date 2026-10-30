# mstore

单文件本地存储，给「本地优先应用 + 一个 sidecar 进程」这类形态用。
零运行时依赖，TypeScript 源码由 Node 直接执行（类型擦除，无构建步骤）。

一个 `store.db` 顶一个数据库：段表 + CRC32 + group commit，没有服务端、没有端口、没有迁移。

## 功能

**三类数据住在同一个文件里，写法和查询路径各自不同**

| 命名空间 | 形态 | 适合什么 | 查询 |
|---|---|---|---|
| `biz` | CoW 页表（4KB 页）+ 位图索引 | 固定字段、量大、常改的业务表 | 位图 and，µs 级 |
| `capture` | NDJSON shell 段 | 只追加、可整表清空的日志/抓包 | 按 ns 段组，清空 O(段数) |
| `agent` / `mock` | 独立 body 区段 | schema 不定的大 JSON（100KB–5MB） | 一次 `pread`，不 parse |

**存储层**

- **group commit**：整个进程只有一个 `fsync` 点，按窗口合并提交
- **单文件 + 段表**：每段 64B 自描述头，双 meta（1MB×2 交替写，恢复取 CRC 通过且 gen 更大者）
- **清空 = 标记段组 dead**：O(段数)，不是逐行删；尾部死段直接 `ftruncate` 归还
- **崩溃最多丢一个心跳窗口**：段进度 500ms 落一次 meta，`flush()` / `close()` 强制落盘

**业务表**

- **CoW 页表 + 追加缓冲**：改一行重写整页，但新行先攒在内存，满页（按字节）才落一次盘
- **位图索引**：枚举字段 `Uint32Array` 位图，数值字段 `Float64Array` 列
- **数值区间块级剪枝**：数值列按 4096 行一块记 min/max，`{gte, lte}` 整块不可能命中就跳过
- **索引快照**：冷启动跳过逐页重放，一次 `pread` + 一次 `memcpy`；快照失效自动回退

**外围**

- **stdio NDJSON 协议**（`serve`）：一行一请求、一行一响应，给 macOS 客户端类的外部进程驱动
- **APFS clone 备份**：`backup` 是时点快照，几乎 0 秒
- **NDJSON 导出**：`dump` / `export` 把任何二进制内容变成文本，数据可携带
- **自检**：`check` 校验段头、CRC、索引、locator

## 性能

本机 Intel i7-1068NG7 / x64 / Node 22.22 / V8 12.4。手边没有的机器不猜测，以下全部是实测。

**KV 写入与点查**（16.8MB 库，7100 条 KV）

| 场景 | 结果 |
|---|---|
| 逐条 `await` 写入（每条约一次 fsync） | 300 条 **18.2s** → 16 条/秒 |
| 同批并发写入（group commit） | 5000 条 **91ms** → **54,877 条/秒** |
| 点查（内存索引，批量折算） | p50 **82 ns** / p99 156 ns |
| 列表 50 条 | p50 **7 µs** / p99 112 µs |
| 读 101KB body（一次 pread，不 parse） | p50 **87 µs** ≈1.2 GB/s |
| 清空 5001 段 | **81.5 ms** |
| 冷启动（重放 7100 条 KV 索引） | **60.6 ms** |

**业务表**（30k 行，6.1MB 文件 / 3.7MB 有效负载）

| 场景 | 结果 |
|---|---|
| 批量写入 | **24,999 行/秒**（写放大 1.6×） |
| `dept=R&D` 单条件 | 位图 p50 **9 µs** ／ 全表扫 1.94 ms |
| `dept ∈ {R&D, QA}` | 位图 p50 **10 µs** ／ 全表扫 1.67 ms |
| 三条件组合（`5≤level≤8`） | 位图 p50 **8 µs** ／ 全表扫 2.55 ms |
| 冷启动 open（索引快照） | **35.9 ms** |

位图相对全表扫快 **~170–320×**。

**数值区间查询**（100 万行，块级剪枝 vs 全表扫）

| 场景 | 全表扫 | 块剪枝 | 加速 |
|---|---|---|---|
| 命中 0（区间落在空隙） | 6.22 ms | **0.02 ms** | ~230× |
| 命中 0.01% | 6.44 ms | **0.06 ms** | ~105× |
| 命中 20%（取前 50） | 2.47 ms | **0.05 ms** | ~47× |
| 命中 20%（取全部 20 万行） | 17.03 ms | 11.50 ms | ~1.5× |
| 命中 100% | 61.87 ms | 60.20 ms | 1.0×（无退化） |

块统计本身的开销：4096 行 16 字节，100 万行 **4KB**。

**冷启动随行数**（索引快照 vs 逐页重放，多轮取中位数）

| 行数 | 索引快照 | 逐页重放 | 加速 |
|---|---|---|---|
| 10k | 20.5 ms | 58.8 ms | 2.9× |
| 30k | 35.9 ms | 159.0 ms | 4.4× |
| 50k | 48.2 ms | 250.1 ms | 5.2× |
| 100k | 178.1 ms | 593.2 ms | 3.3× |

50k→100k 快照解码撞上 V8 老生代 GC，加速比回落到 3.3×。这是当前天花板，
要到百万行得把 key 块改成「偏移表 + 共享字符串池」。10GB 的完整瓶颈分析见
[`docs/scale-10g.md`](docs/scale-10g.md)。

## 用法

```bash
node cli.ts init data/app.db            # 建库
node cli.ts put data/app.db biz u_1 '{"name":"张远","dept":"R&D"}'
node cli.ts get data/app.db biz u_1
node cli.ts list data/app.db capture --limit 5
node cli.ts dump data/app.db capture    # NDJSON 到 stdout
node cli.ts check data/app.db           # 自检
node cli.ts export data/app.db out/     # 全库导出 NDJSON
node cli.ts backup data/app.db snap.db  # APFS clone 时点快照
node cli.ts serve data/app.db           # stdio 协议
```

业务表走另一组（页表 + 位图，不是 KV）：

```bash
node cli.ts biz-put   data/app.db u_1 '{"name":"张远","dept":"R&D","level":7}'
node cli.ts biz-query data/app.db --filter '{"eq":{"dept":"R&D"},"gte":{"level":5}}' --limit 20
node cli.ts biz-stats data/app.db
```

`--filter` 就是 `Filter` 的 JSON：`{eq: {字段: 值 | 值数组}, gte: {数值字段: n}, lte: {...}, limit, after}`。

想先看点东西：`npm run demo` 生成 `data/demo.db`（3000 行业务 + 2000 条抓包 + 20 个 agent body，1.6 秒）。

### 作为库用

```ts
import { Store } from './src/store.ts';

// open 打开已有库；create 会 truncate 重建，只在建新库时用
const db = Store.open('data/app.db');

await db.put('biz', 'u_1', { name: '张远', dept: 'R&D' });
await db.putBody('agent', 'run_1', bigJsonBytes, { agent: 'reviewer', status: 'done' });
db.get('biz', 'u_1');            // 内存索引，µs 级
db.getBody('agent', 'run_1');    // 一次 pread，不 parse
await db.clearNs('capture');     // 清空 = 标记段组

// 业务表（带索引维护）
await db.bizPut('u_1', { name: '张远', dept: 'R&D', level: 7 });
db.bizQuery({ eq: { dept: 'R&D' }, gte: { level: 5 }, limit: 50 });
await db.bizDel('u_1');          // 增量更新 alive 位图，不重建
db.bizStats();                   // { pages: {...}, index: { rows, bitmaps, enumValues } }
await db.close();
```

## stdio 协议

一行一个请求、一行一个响应，用自增 `id` 对号。启动先发一条 `{hello: {pid, crc, stats}}`。

| op | 参数 | 返回 |
|---|---|---|
| `info` / `check` | — | 库统计 / 自检报告 |
| `list` | `ns`, `limit`, `after` | 记录数组 |
| `get` | `ns`, `key` | `{value, body, seg, ts}` |
| `body` | `ns`, `key` | `{base64, len}`（演示用；大 body 别走这条） |
| `put` | `ns`, `key`, `value` | `{seq}` |
| `putbody` | `ns`, `key`, `base64`, `meta` | `{seq, loc}` |
| `clear` | `ns` | `{freedBytes, deadSegs, truncated}` |
| `biz.info` | — | `{pages, index}` |
| `biz.query` | `filter`, `limit` | `{matched, took_us, rows:[{key, rowid, value}]}` |
| `biz.get` / `biz.put` / `biz.del` / `biz.clear` | `key`, `value` | 同上对应语义 |
| `backup` / `quit` | `value`(目标路径) / — | — |

出错一律 `{id, ok: false, error}`，未知 op 也不会把进程带死。

## 已知限制

- **单写者**：不要开两个进程写同一个 `store.db`
- **body 不预留空间**：预留 16MB×6 会把 23MB 数据占成 98MB，所以 body 精确分配
- **清空后空间不一定立刻归还**：尾部死段 `ftruncate`，中间死段登记为可复用空洞；
  立刻归还需要的 `F_PUNCHHOLE` 在 Node 里没有（需 C helper，见 `MSTORE_PUNCH_HELPER`）
- **meta 上限 1MB**：约 1.2 万段，超了要调大 `META_SIZE` 或压缩段表
- **10GB 目前不可用**：内存里有四份全量 key 索引，6600 万行约 6.0GB、冷启动约 90 秒。
  改造路线与验收判据见 [`docs/scale-10g.md`](docs/scale-10g.md)
- **KV 命名空间每次打开都重放**：索引快照目前只覆盖 `biz`

## 需要什么

- Node **≥ 22.18**（能直接跑 `.ts` 的类型擦除；更早版本没有 `zlib.crc32`）
- macOS 客户端：[`mstore-db`](https://github.com/migoric/mstore-db)

```bash
npm run typecheck    # TypeScript 7
npm test             # 122 个用例，约 58s
npm run mutate:all   # 变异测试五组，100%（store 那组 84/85）
npm run bench:predicate -- --rows 1000000   # 区间查询 A/B
npm run bench:scale  -- --rows 1000000      # 索引内存与冷启动
```

## 文档

- [`docs/design.md`](docs/design.md)——设计总纲，改架构先改它
- [`docs/scale-10g.md`](docs/scale-10g.md)——10GB 的三道门槛与四阶段改造
- [`AGENTS.md`](AGENTS.md)——在仓库里干活的操作手册（模块边界、测试要求、已知坑）
- [`CHANGELOG.md`](CHANGELOG.md)——版本与格式变更（`format_ver` 与包版本是两件事）
- [`SECURITY.md`](SECURITY.md)——威胁模型（明文、无访问控制、单写者）

硬要求只有一条：**任何改动都要同时给单测和变异测试**。

## License

MIT
