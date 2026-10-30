# mstore

单文件本地存储，给「一个 macOS App + 一个 Node sidecar」这类本地优先应用用。
零运行时依赖，TypeScript 源码由 Node 直接执行（类型擦除，无构建步骤）。

```
store.db
├── [0,4K)      文件头      magic "MSTORE01" + format_ver + shellCap
├── [4K,+1M)    meta.a      段表 + 各 ns seq 水位 + 空闲区，CRC32
├── [+1M,+2M)   meta.b      同上，交替写入（原子切换，恢复取 CRC 通过且 gen 更大者）
└── [2M,EOF)    段序列      每段 64B 自描述头 + payload
```

## 为什么长这样

这套设计的出发点是三个实测结论（本机 x64 / Node 22）：

| 事实 | 影响 |
|---|---|
| `write` 4KB 只要 **8.3µs**，`fsync` 要 **20ms** | 写吞吐上限 = 提交频率，必须 group commit |
| 300KB 文档读盘 0.27ms，`JSON.parse` 1.68ms | 大 body 永不 parse，只按 offset 交接 |
| JS 表驱动 CRC 332MB/s，`zlib.crc32` 2812MB/s | CRC 必须用原生实现 |

## 核心机制

- **单写者 + 单 fd + 单 fsync 点**：整个进程只有一个地方调 `fsync`，按窗口合并提交。
- **段（segment）**：分配与回收单位。`shell` 段预分配 1MB 攒批写；`body` 区段精确长度、写完即定。
- **清空 = 标记段组 dead**：不是逐行删，是 O(段数)；尾部死段直接 `ftruncate` 归还空间。
- **shell 段用 NDJSON**：可读性红利——`store dump` 出来的就是人眼可读的行。
- **body 段存原始字节**：不 base64、不 parse、不格式化。

## 三层引擎

同一份文件里住着三类数据，各自的写法和查询路径都不一样：

| 数据 | 形态 | 落盘 | 查询 |
|---|---|---|---|
| **biz** 业务表 | 固定字段、量大、常改 | CoW 页表（4KB 页，页内 JSON 行数组） | 位图索引，p50 **8–9µs** |
| **capture** 抓包 | 只追加、body 大、可整表清空 | NDJSON shell + body 区段 | 按 ns 段组，清空 O(段数) |
| **agent** 执行结果 | schema 不定的大 JSON（100KB–5MB） | body 区段，精确长度、不留预留 | 一次 `pread`，不 parse |

### 业务数据引擎

biz 不是「再开一个 KV 命名空间」，它多两样东西：**页表**和**索引**。

**CoW 页表**（`src/pagetable.ts`）：行按 4KB 页组织，页内是 `{r:[{k,v}]}` 的 JSON。
改一行 = 整页重写到新偏移，旧页变空洞由 `reclaim` 回收。页目录 `pageDir: number[]` 存在 meta 里。

只这么做写放大很难看——每行一次 4KB 重写。所以加了**追加缓冲**：新行先攒在 `openRows`，
满页（按**字节**判断，不是按行数）或提交时才落一次盘。实测写放大从「每行 1 页」降到 **1.7×**。

**位图索引**（`src/bitmap.ts` + `src/bizindex.ts`）：枚举字段建 `Uint32Array` 位图，
数值字段建 `Float64Array`。查询是位图 `and`/`andNot`，不是全表扫。

两个关键优化，都是被压测逼出来的：

- **增量维护 `alive` 位图**：原本每次查询都要重建「死行集」，30k 行下光重建就吃掉 80µs。
  改成删除时增量更新，查询直接 `acc.and(alive)`。
- **`forEachWhile` 提前退出**：`LIMIT 50` 不需要扫完 3 万行匹配集，够了就停。

两项合计把 p50 从 **85µs 打到 8–9µs**（10×）。

## 变异测试

`tools/mutate.ts` 是零依赖变异测试器：改一处运算符 → 跑测试 → 失败=杀死，通过=存活。
单测覆盖率只说明「这行被执行过」，变异得分才说明「这行被验证过」。

```bash
npm run mutate         # src/bitmap.ts   ← test/bitmap.test.ts
npm run mutate:index   # src/bizindex.ts ← test/biz.test.ts
npm run mutate:page    # src/pagetable.ts ← test/pagetable.test.ts
npm run mutate:snap    # src/snapshot.ts ← test/snapshot.test.ts
npm run mutate:store   # src/store.ts    ← test/core.test.ts + test/biz.test.ts
npm run mutate:all
```

规则细节：

- 逐行扫运算符（`>` `>=` `===` `!==` `&&` `||` `true` `false` …），替换成近似变异后跑测试
- 剥掉行尾注释、跳过字符串字面量，否则注释里的 `→ x >= 0` 会被误当运算符
- 语义等价的变异用**同行尾注** `// equiv` 标记跳过，写在上一行无效——工具是逐行处理的
- `--tests a.ts,b.ts` 支持一次跑多个测试文件（`store.ts` 的分支散在两组用例里）
- 得分低于 70% 直接 `exit 1`

当前得分：

| 模块 | 杀死/总数 | 得分 |
|---|---|---|
| `src/bitmap.ts` | 9/9 | **100%** |
| `src/bizindex.ts` | 9/9 | **100%** |
| `src/pagetable.ts` | 32/32 | **100%** |
| `src/snapshot.ts` | 24/24 | **100%** |
| `src/store.ts` | 61/62 | **98.4%** |

**它抓出来的问题（都是人工 review 会漏的）：**

1. `pageKeys` 只写不读——上线 `alive` 位图后没人再读它，纯死状态 → 删掉
2. `bizindex` 里两个分支一模一样的循环（`bm.constructor === Bitmap ? bm : bm`）→ 删掉
3. `_writeMeta(force)` 的 `force` 参数三个调用点全传 `true`，`if (!force && …)` 是死分支 → 参数整个去掉
4. 页表用「每行 + 2 字节逗号余量」估算用量，**单行时低估 6 字节**（多算了不存在的逗号、少算了
   `{"r":[]}` 空壳）。结果是刚好超页的行能过检查、到 flush 才炸 → 改成精确字节账
5. 快照的 `sniffSnapshot()` 没有任何调用点、`MAX_BLOCKS` 是两趟扫描已经拦得住的纯防御 → 都删掉

顺带补出的用例都是「flush 之后没验证」这类漏洞：更新只改了内存没落盘、删除的行重开又复活、
重复 flush 白写一页、`after` 落在第 0 个时不往后挪。

`store.ts` 剩下的 1 个存活变异在空洞阈值上：

```ts
if (span.len - need < F.SEG_HEADER_SIZE + 4096) this.freeSpans.splice(i, 1);
//                                   ↑ 改成 <= 也测不出行为差异
```

它只决定「剩余不到 4KB 的空洞要不要继续留着」，改坏了只是多浪费几 KB 空间，不产生错误行为。
要精确打这个边界得先造一个「剩余正好 4160 字节」的空洞（混合 cap 的 shell + body 段拼出来），
成本高于收益，留着当已知项。

## 用法

```bash
node cli.ts init data/app.db            # 建库
node cli.ts put data/app.db biz u_1 '{"name":"张远","dept":"R&D"}'
node cli.ts get data/app.db biz u_1
node cli.ts list data/app.db capture --limit 5
node cli.ts dump data/app.db capture    # NDJSON 到 stdout
node cli.ts cat data/app.db agent run_0 # body 原样输出
node cli.ts check data/app.db           # 自检：段头 / CRC / 索引 / locator
node cli.ts export data/app.db out/     # 全库导出 NDJSON（数据可携带性）
node cli.ts backup data/app.db snap.db  # APFS clone 时点快照（≈0 秒）
node cli.ts serve data/app.db           # stdio NDJSON 协议，给 macOS 客户端用
```

业务表走另一组命令（走页表 + 位图，不是 KV）：

```bash
node cli.ts biz-put   data/app.db u_1 '{"name":"张远","dept":"R&D","level":7}'
node cli.ts biz-get   data/app.db u_1
node cli.ts biz-del   data/app.db u_1
node cli.ts biz-query data/app.db --filter '{"eq":{"dept":"R&D"},"gte":{"level":5}}' --limit 20
node cli.ts biz-stats data/app.db        # 页数 / 行数 / 位图数 / 占用
```

`--filter` 就是 `Filter` 的 JSON：`{eq: {字段: 值 | 值数组}, gte: {数值字段: n}, lte: {...}, limit, after}`。

想先看点东西：`npm run demo` 生成 `data/demo.db`（3000 行业务 + 2000 条抓包 + 20 个 agent body，
1.6 秒），然后 `node cli.ts serve data/demo.db` 丢给客户端。

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

```ts
import { Store } from './src/store.ts';

const db = Store.create('data/app.db');
await db.put('biz', 'u_1', { name: '张远', dept: 'R&D' });
await db.putBody('agent', 'run_1', bigJsonBytes, { agent: 'reviewer', status: 'done' });

db.get('biz', 'u_1');            // 内存索引，µs 级
db.getBody('agent', 'run_1');    // 一次 pread，不 parse
await db.clearNs('capture');     // 清空 = 标记段组
await db.close();
```

业务表走另一组 API（带索引维护）：

```ts
const db = Store.open('data/app.db');

// 业务表只有一组命名空间（biz），key 由业务给
for (const u of users) {
  await db.bizPut(u.key, { name: u.name, dept: u.dept, salary: u.salary });
}

db.bizQuery({ eq: { dept: 'R&D' }, gte: { salary: 12000 }, limit: 50 });
// → 位图 and + 提前退出，30k 行下 p50 8–9µs

db.bizGet('u_1');                // key → 行
await db.bizDel('u_1');          // 增量更新 alive 位图，不重建
db.bizStats();                   // { pages: {...}, index: { rows, bitmaps, enumValues } }
```

## 压测（本机 x64 / Node 22.22 / V8 12.4）

```
node bench/gen.ts --out data/bench.db --biz 2000 --cap 5000 --runs 100 --body 200
node bench/bench.ts --file data/bench.db
```

| 场景 | 结果 |
|---|---|
| 逐条 `await` 写入（每条约一次 fsync） | 300 条 **18.3s** → 16 条/秒 |
| 同批并发写入（group commit） | 5000 条 **99ms** → **50,618 条/秒**（2 次 fsync） |
| 点查（内存索引） | p50 **0µs** / p99 **1µs** |
| 列表 50 条 | p50 **5µs** / p99 **28µs** |
| 读 202KB body（一次 pread） | p50 **117µs** |
| 清空 5001 段 | **74.8ms**，自检 0 问题 |
| 冷启动（重放 7100 条索引） | **51.6ms** |

结论一句话：**逐条提交是 16 条/秒，批提交是 5 万条/秒。差 3160 倍，全部来自 fsync 合并。**

### 业务数据引擎压测（30k 行）

```
node bench/biz.ts --rows 30000
```

| 场景 | 结果 |
|---|---|
| 写入 30000 行 | 1306ms → **22,976 行/秒**（页数 1038，重写 1051 次） |
| 文件体积 / 有效负载 | 6.1MB / 3.7MB → 写放大约 **1.6×** |
| `dept=R&D` 单条件 | 位图 p50 **10µs** / p99 72µs　全表扫 1.02ms |
| `dept∈{R&D,QA}` 双值 | 位图 p50 **12µs** / p99 46µs　全表扫 1.26ms |
| 三条件组合 | 位图 p50 **7µs** / p99 42µs　全表扫 1.23ms |
| 冷启动 `open`（逐页重放） | 166ms（行数 30000，重建 11 个位图） |
| 冷启动 `open`（索引快照） | **38ms**（4.3×） |

位图相对全表扫快 **~100–180×**（差距随命中集比例浮动）。5 万行时是 22,817 行/秒、写放大 1.4×。
（页表改成精确字节账之后，同样 3 万行从 1058 页降到 1038 页，写放大 1.7× → 1.6×：原来每行多估 2 字节，
一页实际能多塞一行。）

## 冷启动：索引快照

30k 行的库 `open` 要 166ms，全花在「把索引重新建一遍」：读 1038 个 4KB 页、解 3 万个小 JSON、
往两个 Map 里插 6 万次、再逐行喂给位图索引。数据在盘上没动过，重建的只是**寻址结构**。

所以给它做个快照：页目录、`key → 逻辑页`、`rowid ↔ key`、所有位图、数值列整体序列化成一段
（`type = SNAPSHOT`，ns 是内核自己的 `sys`，不会被 `clearNs` 顺手带走），
`meta.snap` 记下段位置 + CRC + 生成时的 `bizEpoch`。`open` 命中就一次 `pread` + 一次 `memcpy`，
不命中就回退重放。

```
node bench/open.ts          # 同一份数据跑两条路，比耗时 + 逐字节比对 5 组筛选器
node bench/open.ts --rows 50000
```

| 路径 | 30k 行 `open` |
|---|---|
| 逐页重放 | 166ms |
| 索引快照 | **38ms**（4.3×） |

三个决定，都是为了「快照坏了不能比没有快照更糟」：

- **有效性只有一个判据**：`snap.epoch === meta.bizEpoch`。不用「段表签名」「行数对得上」这类近似判据——
  页内原地更新会让段表一模一样但数据已经变了，近似判据在那儿会误判有效，然后读到旧数据。
  每次 `bizPut` / `bizDel` / `bizClear` 都让 `bizEpoch` 自增，旧快照立刻作废。
- **二进制而不是 JSON**：3 万行索引序列化成 JSON 约 3.5MB，解析要 30–40ms，省下来的时间又还回去了。
  二进制版本是一份能直接 memcpy 的内存镜像。
- **一个 key 只存一次**：`ROWS` 块的一行同时给出 `rowid`（索引侧）和 `logical`（页表侧），
  恢复时**同一个字符串对象**插进两个 Map。省掉 3 万次字符串解码和一半字节
  （文件 6.77MB → 6.47MB）。顺带说明：`Map.set` 3 万次就是 9ms，V8 已经对字符串键做了内部化，
  手写开放寻址表实测并不更快——这块成本是硬的，只能靠少插一次来省。

解码是「两趟」的：先扫一遍块头（挡住截断与长度错乱），再逐块落地。中途抛错就由 store 清掉
半成品状态、回退重放——**绝不会拿着半个索引继续跑**。

`stats().snapshot` 把「走的哪条路、为什么没走快照」直接暴露出来：

```json
{ "path": "snapshot", "openMs": 38.4, "note": "", "epoch": 12, "current": true,
  "bytes": 1148930, "rows": 30000 }
```

客户端侧栏直接显示这两项。性能回退必须是可见的，否则它只会以「今天怎么有点慢」的形式出现。

还没做的：KV 索引（抓包 / mock / agent）仍然每次重放 shell 段。它们的量与 30k 业务行不同量级，
真成为瓶颈时再照这个格式加一个 `KV` 块即可（块带 tag，加块不用升版本）。

## 已知取舍与坑

- **body 不预留空间**：实测多次 `ftruncate` 增长会让 APFS 稀疏文件失效，预留 16MB×6 会把 23MB 数据占成 98MB。所以只有 shell 段预留（1MB），body 精确分配。
- **清空后空间不一定立刻归还**：尾部死段用 `ftruncate`，中间死段先登记为可复用空洞。要立刻归还需要 `F_PUNCHHOLE`（Node 无 `fcntl`，需 20KB C helper，见 `MSTORE_PUNCH_HELPER`）。
- **崩溃最多丢一个心跳窗口**：段进度 500ms 落一次 meta；`flush()`/`close()` 强制落盘。
- **单写者**：不要开两个进程写同一个 `store.db`。
- **meta 上限 1MB**（约 1.2 万段）：超了需要调大 `META_SIZE` 或压缩段表。

## 需要什么

- Node **≥ 22.18**（能直接跑 `.ts` 的类型擦除；更早版本需要先 `tsc` 编译，且没有 `zlib.crc32`）
- 类型检查：`npm run typecheck`（TypeScript 7）
- 测试：`npm test` → **94 个用例**（约 56 秒）
  - `bitmap` 16 / `pagetable` 24 / `biz` 9 / `core` 23 / `snapshot` 11 / `protocol` 4 / `store` 7
  - `protocol` 是真的 spawn 一个 `cli.ts serve` 走管道，锁住 macOS 客户端依赖的那套协议
  - `core` 是「快速分支覆盖」，全程批量提交，5 秒跑完，专门喂给变异测试；
    `store` 是「长流程规模验证」（跨段 500 条、清空 200 条），慢但只跑一次
- 变异测试：`npm run mutate:all`（不含 snapshot / store，这两组单跑 `mutate:snap`、`mutate:store`）

## 参与

- [`AGENTS.md`](AGENTS.md)——在仓库里干活的操作手册：模块边界、代码约定、改动纪律、测试要求、已知坑。
  做任何改动之前先读这个。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)——环境、PR 自查清单、报 Bug 要带什么。
- [`CHANGELOG.md`](CHANGELOG.md)——版本与格式变更（`format_ver` 与包版本是两件事）。
- [`SECURITY.md`](SECURITY.md)——威胁模型（明文、无访问控制、单写者）与漏洞报告方式。
- [`docs/design.md`](docs/design.md)——设计总纲，改架构先改它。

硬要求只有一条：**任何改动都要同时给单测和变异测试**，缺一个不算完成。

## 设计来源

完整设计文档：`docs/design.md`（《本地数据子系统 · 设计总纲》，含单文件形态、段表、清空三档、跨表索引、可读性预算）。
本仓库是实现侧的最小可用内核（M1）。已实现：段表 + group commit + CoW 页表 + 位图索引 + 索引快照。
尚未实现：抓包列存、向量旁路、`F_PUNCHHOLE` 打洞（需 C helper）。

## License

MIT
