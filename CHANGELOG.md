# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

文件格式版本独立于包版本：`format_ver` 变动代表**旧文件需要迁移**，
包版本变动不代表格式变动。两者都记在下面。

## [Unreleased]

### 计划中
- KV 索引快照：`capture` / `mock` / `agent` 三个 ns 目前每次打开都重放 shell 段。
  快照块格式已带 tag，加一个 `KV` 块即可，不需要升 `format_ver`。
- `F_PUNCHHOLE` 支持（需要 C helper，`MSTORE_PUNCH_HELPER`）——中间空洞的段回收。

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
