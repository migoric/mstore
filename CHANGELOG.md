# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

文件格式版本独立于包版本：`format_ver` 变动代表**旧文件需要迁移**，
包版本变动不代表格式变动。两者都记在下面。

## [Unreleased]

### Added
- **持久化统一 key 索引与二进制页目录**：`PageTable` / `BizIndex` 共享 `KeyDirectory`；磁盘按 key 与 rowid 双排序分块，打开只读稀疏索引、Bloom 和页目录，点查按块读取并校验 CRC。新写入只进入小型增量目录，flush 时物化有序块；普通快照命中该目录时跳过全部 `ROWS` 字符串解码。新增 `T.KEYS` 段与 `test/keydir.test.ts`，不改变 `format_ver`。
- **分页查询下推**：`BizIndex.queryPage` / `Store.bizQueryPage` 只物化当前页，`matched` 仍精确统计全部命中行；纯枚举过滤直接用位图计数，CLI 与 stdio `biz.query` 不再先创建全量结果再 `slice`。
- `body.range` 协议与 `Store.getBodyRange`：body 预览只读取指定范围，macOS 客户端固定只传前 4KB，不再把完整 body 编成 base64 后截取。
- **业务页聚合写**：满页先进入脏页队列，提交时按物理偏移把相邻页合成最高 1MB 的写；页分配不再逐 4KB 调用 `ftruncate`。公开 `flushOpen()` 仍在返回前把全部脏页落盘。
- **异步提交管线**：同时只有一个 `fsync` 在途，等待期间 Node 事件循环和读请求可继续运行；ack 仍严格等待对应刷盘完成。
- **枚举字典 ID**：每行记录旧枚举值，更新和删除只清目标位图，不再遍历该字段的全部取值。
- **快照 v3**：页目录物理偏移升级为 u64，枚举行字典直接进入快照，TypedArray 使用整块拷贝；旧快照自动回退逐页重放。打开 meta 时先读长度，再读实际内容，不再固定读取两份 1MB。
- **页缓存（`StoreOpts.pageCachePages`，默认 1024 页）**：点查的成本 64% 在
  「把整页 48 行 JSON.parse 出来」（19.6µs），pread 只占 3.7µs，所以缓存的是
  解码后的页而不是原始字节。LRU 用 `Map` 插入序实现；返回值一律深拷贝（约 1.1µs），
  语义与无缓存时完全一致。写路径在 `writePage`（唯一写页内容的地方）同步更新缓存，
  put/delete 的读-改-写不需要各自管缓存。实测 2 万行随机点查 33.2µs → 1.9µs
  （命中率 99%）。容量必须盖住工作集，否则 LRU 抖动等于没加。
- `bench/vs-sqlite.ts`：与 SQLite 的四方对等对比基准（mstore / sqlite-full /
  sqlite-wal / sqlite-quick），四引擎分进程跑避免内存互相污染，见 README 性能节。

### Changed
- **组提交不再让队首请求空等**：`submit` 改为 0ms 定时器立即 drain。
  窗口的作用是让后来者搭车，不是让第一个请求罚站——串行 `for await put` 时
  队列永远只有 1 个 op，原实现每条白等一整个 window（实测 40ms 窗口 + 20ms fsync
  = 16 行/秒）。同一 tick 内的后续 op 仍并进同一批，真正的合批能力来自 fsync 在途。
  串行逐条 16 → 42 行/秒，并发组提交 2,824 → 7,332 行/秒。
- `stats.fsyncs` 修复为真实计数（原来从未自增，`report()` 里恒为 0）。

### Fixed
- stdio `quit` 改为先完成 `close()`、meta 与索引快照落盘，再返回响应；客户端收到响应后立即终止 sidecar 也不会跳过退出收尾。
- **open 页行迁移不再丢失 rowid**：更新变大导致行迁出时，原实现把统一目录项整条删除（连带 rowid）再重插，BizIndex 会分配新 rowid 而旧位图不清，产生重复 rowid 与幽灵存活行；现在只覆盖 logical，rowid 原样保留。
- **replay 后 `nextRowid` 从 0 撞号**：持久化 key 目录有效但普通快照禁用/损坏/缺失时，重放使用旧 rowid 重建索引却不推进 `nextRowid`，新行从 0 开始覆盖已有位。现在 `BizIndex.put` 对任意已见 rowid 推进 `nextRowid`。
- **`_reclaimTail` 不再回退到未落盘 live 页之前**：页分配改为内存高水位后，尾段回收只看 `io.size()` 会把已分配未写盘的 CoW 页判为不存在，回退 hwm 后新分配覆盖旧页。现在用 `max(io.size(), hwm)` 判断逻辑尾部。
- **页缓存与脏页不再共享调用方对象**：`put` 在入口深拷贝 value，`entries()` 逐行返回副本；原实现调用方修改原对象或遍历结果会绕过写路径，直接改变缓存中的已提交值。
- **close 拒绝关闭期间的新写入**：`closing` 在第一次 await 之前置位，写 API 统一走 `_submit` 检查；`close` 幂等并等待已接受操作全部 drain。
- **快照编码不再把缺 rowid 的 key 伪造为 rowid 0**：此类 key 正确写入 `LOOSE` 块；缺 logical 的条目直接报错，不静默写 0。
- **key 块字节账修正**：首条记录与 8B 块头计入预算，实际块长不再超过声明的 4096B；单条超预算仍允许独占一块。
- **二进制页目录增加 `dirCrc`**：页目录损坏时整份 key 索引回退页扫描，不再携带错误物理偏移。key 块损坏仍在读取时显式报错（懒加载换完整性可见性，未做自动回退）。
- 保留 `PageTable.snapshotIndex()` 兼容包装（内部改用共享目录实现），删除它的破坏性改动已撤销。

### Performance
- 本轮同机前后对照：10 万行批量写入 **759 → 46,260 行/秒（约 61×）**，主要来自脏页合并写与去除逐页 `ftruncate`；3 万行 `bench/open.ts --rounds 3` 快照中位 **29.21ms**、重放 **185.85ms（6.4×）**，5 组筛选器结果一致。
- 20 万行、单部门命中 4 万行的微基准：旧的全量物化 p50 **1.974ms**；分页接口在保留精确 `matched` 的同时 p50 **0.126ms**，只返回 50 行。

20 万行 `bench/vs-sqlite.ts` 实测（各引擎独占进程，持久级别显式对齐）：

| 逐条持久写 | 行/秒 | 物理持久 |
|---|---:|---|
| sqlite-full（DELETE+FULL+fullfsync=ON） | 16 | ✓ |
| mstore 串行 | **45** | ✓ |
| sqlite-wal（WAL+FULL+fullfsync=ON） | 50 | ✓ |
| sqlite-quick（WAL+NORMAL，不保证持久） | 8,954 | ✗ |
| mstore 批量导入（组提交） | **46,576** | ✓ |

过滤查询：枚举+数值组合快 16–17×，区间命中 20% 快 9–12×；
点查在默认页缓存下慢 2–3.9×（工作集盖不住时 LRU 抖动），
区间命中 0 慢 21–72×（块级 min/max 剪不掉落在块内部的空隙，结构性代价）。
代价：RSS 约为 SQLite 的 2 倍，冷启动 313ms vs 2ms。完整表与解读见 README。

## [0.3.0] — 2026-10-31

### Added
- **数值列块级剪枝**：数值列按 4096 行记 `min/max`（100 万行只占 4KB），
  区间查询先问块统计，整块不可能命中就跳过。`Bitmap.forEachWhileRange` 是它的底座。
  命中率接近 100% 时自动退回全量遍历（剪不掉 1/4 以上，剪枝本身就成了开销）。
- `bench/predicate.ts`（`npm run bench:predicate`）：全表扫 vs 块剪枝的 A/B，
  逐行比对结果。**结果不一致会让脚本 exit 1**。
- `bench/scale.ts`（`npm run bench:scale`）：规模可行性实验，输出每行索引成本、
  每行磁盘字节、open 随行数的曲线，并外推到 10GB。必须带 `--expose-gc`。
- `test/predicate.test.ts`：9 个用例，重点不在「快」而在「剪枝不能漏行」——
  逐条与 `bruteForce` 对拍，并专门覆盖删除、覆盖写、NaN、块边界、限流与游标。
- `docs/scale-10g.md`：撑到 10GB 的现状、三个硬门槛与四阶段改造，每阶段带验收判据。

### Changed
- `bizindex.query` 的逐行判定改成扁平数组 + 一条比较链（`v >= lo && v <= hi`）：
  NaN 与越界 `undefined` 都会让比较返回 false，不需要额外判断。
  命中 100% 的场景从「比全表扫慢 20%」回到 1.0×。
- `bizindex.query` 无枚举条件时不再 `clone()` 存活位图（只读使用），省一次 memcpy。
- **快照 `SNAP_VER` 1 → 2**：数值块追加块级 `min/max`。版本不符整份拒绝并回退逐页重放，
  旧库只会慢一次，不会拿错位数据恢复索引。快照里不存统计的话，「快照打开」与
  「重放打开」的查询性能会不一致——那是最难查的一类问题。

### Performance
| 场景（100 万行） | 全表扫 | 块剪枝 | 加速 |
|---|---|---|---|
| 命中 0（区间落在空隙） | 6.22ms | **0.02ms** | ~230× |
| 命中 0.01% | 6.44ms | **0.06ms** | ~105× |
| 命中 20%（取前 50） | 2.47ms | **0.05ms** | ~47× |
| 命中 20%（取全部） | 17.03ms | 11.50ms | 1.5× |
| 命中 100% | 61.87ms | 60.20ms | 1.0×（无退化） |

- 逐行判定按条件数量特化：`{gte, lte}` 落在同一列（区间查询最常写的形状）时合并成
  `[max(lo), min(hi)]` 一条比较链，不再每行过一次循环 + 三处数组间接寻址。
  命中率高的场景会退回全量遍历，那条路上每行开销会被放大几十万倍，所以值得特化。
- 「候选块 / 总块」的分母从 `capacity` 改成 `ceil(nextRowid / 4096)`：
  `capacity` 按 2 的幂翻倍，尾上一串空块会把候选比例稀释掉，让「所有有数据的块都命中」
  这种最该退回全量的情形被判成「剪得挺好」。

### Fixed
- **压测脚本的三处测量错误**（数字曾被低估或虚高，都是脚本的问题，不是内核的）：
  - `bench/open.ts` 用 `void s.close()`，下一轮 `open` 与上一轮的写快照并发，量到的是 I/O 竞争。
    改为 `await close()` + 预热一轮丢弃 + `--rounds` 取中位数。
  - `bench/bench.ts` 直接清空原库的 `capture`，第二次跑就空转并报「清空 0 条」，还把压测库破坏。
    改为在副本上清空，并断言清空后剩 0 条。
  - 点查报「p50=0µs」是 `performance.now()` 分辨率假象（单次点查 <1µs）。
    改为每批 2000 次折算 `ns/op`，真实值是 **p50 82ns / p99 156ns**。
    同时读压测改为断言数据非空、用 `list()` 拿真实 key——之前 capture 为空时全部 miss，
    测的是 miss 分支。
- `bench/biz.ts` 的查询加 200 次预热（第一次查询的 JIT 编译会抬高 p50），
  冷启动打印实际 `openPath` 与 `note`，并区分「首次含 JIT」与「JIT 已热稳态」。
- **区间查询的基准本身是错的**：早先用 `salary` 字段测 `{gte, lte}`，但 `salary` 不在
  `DEFAULT_NUM_FIELDS`（`level / updated_at / ms / bytes`）里，查询走的是
  「字段不存在 → 立刻返回空」的快路径。那个 21.9ms 是「为返回空而扫完全表」，不是区间扫描。
  现在基准用 `ms`，并在 `bench/predicate.ts` 顶部写明这个前提。
- **快照的两条失败路径从来没被走过**。「CRC 不对」有人测，「压根读不出来」和
  「读出来了但结构坏」没人测——各有一个 `return false`，改成 `true` 都不会红。
  补了「meta 里的长度改到越过文件尾」与「CRC 改对了但 magic 被抹掉」两个用例。
- **`PageTable.restoreSnapshot` 的洞处理反了也测不出来**：`keys` 里的 `undefined`
  被当成一行装回索引，`size()` 会多算。补了直接用带洞的 `keys` 调 `restoreSnapshot` 的用例。
- **区间查询的基准有系统性偏置**：「旧算法连跑 40 次、再新算法连跑 40 次」，
  后跑的那个要承受前面积累的 GC 压力，命中 100% 那档因此报成 0.9×（真实 1.0–1.1×）。
  改成同一轮内交错、下一轮反序。**任何固定顺序的 A/B 都在给后跑的那个扣分。**

### Tests
- 变异测试五组：`bitmap` 15/15、`bizindex` 57/57、`pagetable` 35/35、`snapshot` 24/24
  全部 100%；`store` **84/85 = 98.8%**（唯一存活是空洞阈值的等值边界，属已知项）。
- 补了 5 个「只丢性能、不改结果」的用例，这类分支只有断言 `lastScan` 才测得出：
  两个不同列的通用逐行判定（limit / 游标）、候选块正好 3/4 的阈值边界、
  `restoreSnapshot` 的洞、快照的两条失败路径。
- 两处「防御性冗余赋值」标了 `// equiv`（`_writeSnapshot` / `_retireSnapshot` 的
  `metaDirty = true`）：`_registerSeg` 已经标脏、`flush()` 又无条件写 meta，
  公开 API 上确实区分不出来，留标记而不是删掉，免得将来 `flush` 改成按需写时丢了信号。
  另有 4 处「多跑一个空块也看不出差别」的循环边界同样标了 `// equiv`。
- 变异工具的得分门槛做成参数 `--min`（默认 70，CI 传 95）：全局要求 100% 不现实
  （store 有 1 个构造不出来的边界），但 95% 足够让「新写分支没断言」当场红。

### Docs
- README 压测数字全部重新实测（Intel i7-1068NG7 / Node 22.22）：30k 行查询 p50 8–10µs、
  冷启动快照 35.9ms（重放 159ms，4.4×）、并发写 54,877 条/秒。
- 新增「冷启动随行数怎么变」表：10k/30k/50k 线性，**100k 跳到 178ms**（GC 压力，加速比回落 3.3×）。
- README 重写为「功能 + 性能指标 + 用法」，设计推导与踩坑记录移到 `docs/design.md`。

### 发布
- 新增 `.github/workflows/release.yml`：`v*` tag 触发 → typecheck → test → `npm pack` →
  自检 tarball 内含 `cli.ts` 与 `src/index.ts` → 发 GitHub Release 附 tarball 与 SHA256SUMS。
- 门禁：**tag 必须与 `package.json` 的 version 一致**。否则发出去的包版本号是错的，
  而 Release 页标题看着完全正常，没人会发现。
- 手动触发（`workflow_dispatch`）只产 artifact、不发 release，用来验证打包链路。

### 计划中
- **阶段 2：key 索引落盘（本轮已实现）**。`PageTable` 与 `BizIndex` 已共享目录，
  业务 key 改为按 key / rowid 双排序块 + 稀疏索引 + Bloom + 块缓存，页目录同步改为 u64 二进制。
  新增 `T.KEYS` 段，保持 `format_ver=1`；百万 / 千万行内存与冷启动仍需专项验收。
- 阶段 3：数值列与位图按块落盘（64K 行大块 + 4096 行子块的两级统计）。
- 阶段 4：compaction（压掉 1.6× 写放大）+ 按 key 分区多写者（导入 1000 万行 ≤4 分钟）。
- KV 索引快照：`capture` / `mock` / `agent` 三个 ns 目前每次打开都重放 shell 段。
  快照块格式已带 tag，加一个 `KV` 块即可，不需要升 `format_ver`。
- 快照解码的堆分配优化（偏移表 + 共享字符串池），把 10 万行以上拉回线性。
- `F_PUNCHHOLE` 支持（需要 C helper，`MSTORE_PUNCH_HELPER`）——中间空洞的段回收。

#### 已评估但**不做**：紧凑内存 key 索引

做过原型并实测：把 `Map<string, number>` 换成「开放寻址哈希表 + 缓存 hash + UTF-8 字节 arena」，
1M 行下单份索引从 **53.4 B/行 → 29.4 B/行**，建索引 **1063ms → 314ms**（3.0×），
10 万次点查 95ms → 55ms。

不做的原因是**它达不到阶段 2 的验收判据**（89.3MB → 15MB 以下，差一个数量级），
四份结构摊下来总量只降 1.3×。属于「花了力气还要再推翻一次」的中间态。
原型数据留在这里，等真要做阶段 2 时可以直接复用其中的字节 arena + 开放寻址实现。

## [0.2.0] — 2026-10-31

冷启动优化：新增**索引快照**，把打开 30k 行的 166ms 降到 38ms。
`format_ver` 不变（新增段类型与块 tag，旧文件照常打开；新文件在旧版本上会忽略快照段并回退逐页重放）。

### Added
- `src/snapshot.ts`：索引快照的二进制编解码。7 种块（`DIR` / `ROWS` / `LOOSE` / `ENUM` /
  `NUM` / `ALIVE` / `STATE`），块头 8 字节、带长度，两趟解码（先验块头铺满全文件，再落地）。
- `T.SNAP = 3` 段类型与 `NS_ID.sys = 5` 系统 ns。快照段不属任何业务 ns，
  `clearNs('biz')` 不会误伤它。
- `PageTable.snapshotDir/snapshotIndex/restoreSnapshot`、
  `BizIndex.snapshotRows/snapshotEnums/snapshotNums/snapshotAlive/snapshotState/restoreSnapshot`。
- `Meta.snap`（段号 / offset / len / crc / epoch / 写入时间）与 `Meta.bizEpoch`。
- `StoreStats.snapshot`：`path`（`snapshot` | `replay` | `fresh`）、`openMs`、`epoch`、
  `current`、`bytes`、`rows`、`at`、`note`。侧栏直接显示「索引快照 32.3 ms / 184.9 KB」。
- `check()` 增加快照指针三段一致性校验（error）与 epoch 过期告警（warn）。
- `bench/open.ts`（`npm run bench:open`）：同库跑逐页重放与快照两条路，
  逐字节比对 5 组筛选器的查询结果。
- `test/snapshot.test.ts`：11 个用例，覆盖命中 / 退役 / 免费重写 / 崩溃现场 / CRC 损坏 /
  段被标死 / 长度被改小 / 删行后 rowid 不撞号 / `bizClear` / 自检告警 / 空库不写。
- `npm run mutate:snap`；`BizIndex.stats()` 增加 `enumValues`（升序），供 UI 查询构建器用。

### Changed
- 快照的 `ROWS` 块一行同时给出 `rowid`（索引侧）与 `physical → logical`（页表侧），
  恢复时同一个字符串对象插两个 Map。相比最初的双份存储，体积 6.77MB → 6.47MB，
  打开耗时从 ~64ms 降到 38ms。
- 恢复接口用**并行数组**而不是二元组数组。3 万个 `[k, v]` 二元组光分配就要几毫秒。
- `flush()` 中写快照排在写 meta 之前；写新快照前先退役旧快照并回收尾部。

### Performance
| 场景 | 之前 | 现在 |
|---|---|---|
| `open` 30k 行 | 166ms（逐页重放） | **38ms**（索引快照） |
| 落盘体积 | 6.77MB | **6.47MB** |
| 查询 p50（不变） | 8–9µs | 8–9µs |

### Notes
- 快照的唯一有效性判据是 `snap.epoch === meta.bizEpoch`。
  **不要**改用「段表签名一致」「行数一致」——页内原地更新会让段表一模一样但数据已变。
- `store.ts` 变异得分 98.4%（61/62），唯一存活是空洞阈值，已记为已知项。

## [0.1.0] — 2026-10-30

首个版本：单文件存储内核。

### Added
- 单文件布局：4KB 文件头 + 两份交替 meta（各 1MB，CRC32，取 `gen` 大且 CRC 通过者）+ 段序列。
- 段：64B 自描述头（type / ns / len / phys / crc / gen），`shell` 段预分配 1MB 攒批写，
  `body` 段精确长度。
- **group commit**：单写者、单 fd、单 fsync 点，按窗口合并提交。
- **业务数据引擎**：CoW 4KB 页表（页内 JSON 行数组）+ 位图索引（`key → rowid`、
  `rowid ↔ key`、枚举位图、数值列 `Float64Array`、活行位图）。查询 p50 8–9µs。
- **三种数据形态**：`biz`（业务表）、`capture`（只追加 + body 大 + 可整表清空）、
  `agent`（schema 不定的大 JSON，100KB–5MB，按 offset 交接不 parse）。
- 清空 = 标记段组 dead，O(段数)；尾部死段 `ftruncate` 归还。
- `crc32.ts`：优先用 `zlib.crc32`（2812MB/s），JS 查表兜底（332MB/s），`crc32Impl` 可查。
- CLI：`init` / `info` / `check` / `put` / `get` / `list` / `dump` / `cat` / `export` /
  `backup` / `clear` / `reclaim` / `biz-*` / `serve`。
- `serve`：stdio NDJSON 协议（一行一请求、一行一响应、带自增 id），给 macOS 客户端用。
- `backup`：APFS `clonefile` 时点快照，不做全量拷贝。
- `check`：段头、CRC、索引一致性、locator 四类校验。
- 测试 83 个；变异测试工具 `tools/mutate.ts`，`bitmap` / `bizindex` / `pagetable` 100%。
- 压测脚本 `bench/gen.ts`、`bench/bench.ts`、`bench/biz.ts`、`bench/demo.ts`。
