# AGENTS.md

给在这个仓库里干活的人（或 agent）看的操作手册。README 讲「这是什么」，
[`docs/design.md`](docs/design.md) 讲「为什么这么设计」，这里只讲**动手时必须知道的事**。

先读这三条，能省掉大部分返工：

1. **任何改动都必须同时给单测和变异测试**，缺一个不算完成（见 [测试要求](#测试要求)）。
2. **文件格式是契约**：改了二进制布局就要升 `format_ver`，或者保证旧文件仍能被读（见 [改动纪律](#改动纪律)）。
3. **不要凭文档改口**：结论必须来自实跑。这个仓库里每一个性能数字、每一条变异存活清单，
   都能用 `npm run` 复现；写着 38ms 就是本机量出来的 38ms。

---

## 结构

```
src/
  format.ts      文件格式常量：magic、段头布局、ns id、段类型、页大小。改布局只改这里
  types.ts       全部对外类型：Meta / SegMeta / Locator / StoreStats / SnapshotStats / CheckReport
  crc32.ts       CRC 实现选择（zlib.crc32 优先，JS 查表兜底），导出 crc32Impl 供输出
  io.ts          裸 fd 读写：pread/pwrite/fsync/ftruncate + APFS clonefile
  bitmap.ts      定长位图（enum 值索引、alive 标记）—— 手写 Uint32Array，不用 Set
  bufferpool.ts  段缓冲区：shell 段预分配 1MB，攒够一批再写；body 段精确长度
  committer.ts   提交协调：单 fsync 在途、异步等待、pending 队列，读不被刷盘阻塞
  pagetable.ts   CoW 页表：key → logical page，页内 JSON 行数组；脏页在 commit 时按偏移合并写
  bizindex.ts    业务索引：enum 位图、数值列 Float64Array、活行位图；与页表共享 key 目录
  keydir.ts      统一 key 目录：内存 Map / 磁盘有序块 + 稀疏索引 + Bloom + rowid 反查 + 二进制页目录
  snapshot.ts    索引快照编解码（二进制，7 种块）；命中 keydir 时跳过 ROWS 字符串解码
  store.ts       Store 门面：open/create/close、三层 API（biz / ns shell / body）、flush、check
  index.ts       公开导出面。新增导出只能加在这里，不要让人从 src/xxx.ts 深引

cli.ts           CLI + stdio 协议服务端（serve）。协议 op 列表见 README「stdio 协议」
bench/
  gen.ts         造 30k 行业务库（dept/level/status/score 四个字段）
  bench.ts       写吞吐 / 读延迟 / 查询 p50-p99
  biz.ts         业务引擎专项压测
  open.ts        冷启动对比：逐页重放 vs 索引快照，逐字节比对两边查询结果
  predicate.ts   区间查询 A/B：全表扫 vs 块级剪枝，逐行比对结果
  scale.ts       规模可行性实验：每行索引成本 / open 曲线 / 外推 10GB
  demo.ts        小样本演示
test/            按模块一一对应：bitmap/pagetable/biz/predicate/core/snapshot/protocol/store
tools/mutate.ts  变异测试工具（每个 worker 一份源码副本，并行改写 + 跑测试，统计存活）
docs/design.md   设计总纲。改架构先改它
docs/scale-10g.md  撑到 10GB 的现状、瓶颈与四阶段改造（每阶段带验收判据）
```

**模块边界**：`store.ts` 是唯一的门面，其它模块**不许互相反向依赖**——
`pagetable`/`bizindex` 不知道 `store` 存在，`snapshot` 只依赖 `pagetable`/`bizindex` 的
`snapshot*` / `restoreSnapshot` 接口。破坏这条会造成循环引用，而 TS7 的类型擦除会把这个错误
推迟到运行时才炸。

## 常用命令

```bash
npm run typecheck          # tsc 7.0.2，noEmit。必须零错误，CI 第一道门
npm test                   # 156 个用例
npm run mutate             # src/bitmap.ts       15/15  100%
npm run mutate:index       # src/bizindex.ts     69/69  100%
npm run mutate:page        # src/pagetable.ts    52/52  100%
npm run mutate:snap        # src/snapshot.ts     25/25  100%
npm run mutate:keys        # src/keydir.ts       48/48  100%
npm run mutate:store       # src/store.ts        99/99  100%
npm run mutate:all         # 六组全跑（日常只跑目标文件那组）

# 变异默认 4 个 worker 并行。单 worker 也只改临时副本（调试用）：
node tools/mutate.ts --target src/bitmap.ts --tests test/bitmap.test.ts --workers 1

npm run gen                # 生成 data/biz.db（30k 行）
npm run bench              # 写读压测
npm run bench:open         # 冷启动对比（先跑 npm run gen）
npm run bench:predicate    # 区间查询 A/B（自带 --expose-gc）
npm run bench:scale        # 规模曲线 + 外推 10GB（自带 --expose-gc）
npm run demo               # 小样本演示

./cli.ts info data/biz.db  # CLI 全部命令见 ./cli.ts --help
```

`npm test` 慢是因为业务写路径每条都 fsync（本机约 60ms/次）。**测试里要批量写就用
`putRows()`（内部 500 条一批 + 200 并发）**，不要 for 循环里 `await bizPut`——
一开始这么写让 snapshot 单测跑了 24 秒。

## 代码约定

### TypeScript

- **`erasableSyntaxOnly: true`**：不能用 `enum`、`namespace`、构造函数参数属性
  （`constructor(private x)`）。用 `const` 对象 + `as const`，或者联合类型。
  这不是风格偏好——类型擦除才能让 Node 直接跑 `.ts`，无需构建。
- **`verbatimModuleSyntax: true`**：纯类型导入必须写 `import type`，否则运行时会留下
  一个空的 import 语句去加载不存在的模块。
- **`noUncheckedIndexedAccess: true`**：`arr[i]` 的类型是 `T | undefined`。
  不要到处 `!`——先用 `if` 收窄，或者证明过下标合法时在同一行写 `// equiv` 之外的注释说明。
  `!` 只在已经做了边界检查的位置用。
- 导入路径带 `.ts` 后缀（`allowImportingTsExtensions`）。
- 零运行时依赖是硬约束。需要新依赖先证明用标准库做不到。

### 命名与形状

- 段类型/ns 名等常量集中在 `format.ts`，别在业务代码里写字面量。
- 对内接口用**并行数组**而不是二元组数组。`restoreSnapshot(dir, keys[], logicals[])`
  是刻意的：3 万个 `[k, v]` 二元组光分配就要好几毫秒，快照的全部收益会被吃掉。
- 数值列一律 `Float64Array`，枚举列一律 `Bitmap`。不要在热路径上引入 `Map<string, Set<>>`。
- 抛出错误时带上足够定位的信息：`seek past end (${pos} > ${buf.length})`。

### 注释

注释写**为什么**，不写**是什么**。`// 自增` 没有价值；
`// 快照必须在回收之前退役，否则旧快照会指向已被复用的段` 有价值。
遇到反直觉的实现（比如「手写开放寻址表不比 Map 快」），把实测结论写进注释，
避免下一个人（或下一个 agent）重新走一遍。

## 改动纪律

### 文件格式

`docs/design.md` 是格式的唯一权威。改二进制布局时按影响面选一条路：

| 改动 | 做法 |
|---|---|
| 新增段类型 / ns | 加常量即可，**不升版本**（读取侧按类型分派，旧文件没有该类型就不走那条路） |
| 新增快照块 | 同上。`decodeSnapshot` 遇未知 tag 应跳过而非报错（`len` 已足够跳过） |
| 改变已有字段语义 / 长度 | **必须升 `format_ver`**，并在 `check()` 里加对应告警 |
| 改 meta 布局 | 升版本。meta 双份交替写，旧 gen 会被覆盖，没有回头路 |

任何格式改动都要补一条**旧文件仍可打开**的用例，或者明确写「不兼容」进 CHANGELOG。

### 索引快照

快照的唯一有效性判据是 **`snap.epoch === meta.bizEpoch`**。

不允许用「段表签名一致」「行数一致」这类近似判据替代——页内原地更新会让段表一模一样
但数据已经变了，近似判据会判成有效，然后读到旧数据。这是本仓库最容易踩的坑，已在
`test/snapshot.test.ts` 里用「同长度原地改值」的用例锁住。

配套不变量，改动 `store.ts` 时必须一起维护：

- 每个 `bizPut` / `bizDel` / `bizClear` 都必须走 `_bumpBizEpoch()`。漏一处 = 旧快照复活。
- `flush()` 里 `_writeSnapshot()` 必须在 `_writeMeta()` **之前**。
  反过来的话，meta 里的 `snap` 指针会指向一个还没写下来的段。
- 写新快照的顺序是：退役旧的 → `_reclaimTail()` → 写新的。
  这样写完之后快照一定在物理尾部，下次 flush 能直接 `ftruncate` 掉。
- 快照段挂在 `ns = sys(5)`、`type = SNAP(3)`：它是基础设施，不属于任何业务 ns，
  否则 `clearNs('biz')` 会顺手把它标死。

### 提交路径

单写者、单 fd、单 fsync 点。**不要在 `store.ts` 之外调 `io.sync()`**，
也不要新增第二个写 fd。group commit 的全部前提就是这两条。

## 测试要求

一个改动算「完成」，必须同时满足：

1. `npm run typecheck` 零错误。
2. `npm test` 全绿，且**新增的逻辑有对应用例**（不是把老用例改一改让它过）。
3. 目标文件的变异得分 **100%**。做不到的话，每个存活变异要么补用例杀掉，
   要么在同一行尾注 `// equiv` 并说明为什么等价。

变异工具本身有三条要注意的：

- **永远不碰主工作区**（连 `--workers 1` 也是先复制副本再跑）。以前是原地改写 + `finally`
  恢复，被 `kill -9` 强杀时恢复没机会跑，`src/bizindex.ts` 里 `bruteForce` 的 `ok = false`
  被留成了 `true`，之后所有 `{gte}` 查询都多返回行——白花两小时追一个根本不存在的剪枝 bug。
  现在结束时会校验主工作区 sha256，变了直接 `exit 1`。
- **默认并行 4 个 worker**。每个 worker 复制一份 `src/` + `test/` 到临时目录，各自改写、各自跑，
  结束后目录自动删掉。加这个是因为给 bizindex 补了 9 个 12000 行的用例后，单轮从 0.5s 变成
  20s，100 个变异体串行要 33 分钟——CI 必超时。并行后 bizindex 那组 33 分钟 → **约 1 分钟**。
  `store.ts` 那组因为要连 `snapshot.test.ts` 一起跑，仍然要 **约 5.5 分钟**——它是最慢的一组，
  别以为是卡住了。
- 单个变异体的超时是 60s。**超时算「杀死」**：变异体能让测试挂死，说明测试确实依赖那段逻辑。
- **`--tests` 必须覆盖到被测文件的全部分支**。`store.ts` 的快照逻辑只用 `core` + `biz` 跑会
  留下 26 个存活变异（得分 70.1%），加上 `snapshot.test.ts` 才回到 98.8%
  （剩下 1 个是空洞阈值的等值边界，已记为已知项）。看到「某个文件得分
  突然掉下来」，先查测试集漏了哪个分支，而不是去补断言。

变异判定细节容易卡人，踩过三次：

- **`// equiv` 写在被变异那一行的行尾**（首选）。写在上一行也行，但那一行必须是纯注释
  且带 `equiv`——我在这条上栽过三次，工具后来才加了「上一行也算」的容错。
- 等价变异要真等价。`Writer.need` 的两处边界、`MAX_BLOCKS` 这类纯防御断言都是真等价；
  但「`rows: snap ? biz.size : 0`」这种是**不可观测**，不是等价，应该改写成
  `this.snapInfo?.rows ?? 0` 并补断言。
- 变异抓到过**死代码**：`sniffSnapshot()` 没有任何调用点、`MAX_BLOCKS` 永不触发。
  两个都删了。变异测试的价值一半在这里。

写用例的几条经验：

- 涉及 fsync 的用例统一走 `putRows()` 批量写。
- 断言不要依赖「存活行数」，那和 `nextRowid` 不是一个东西（删过行的库两者不等）。
- 临时库统一放 `os.tmpdir()`，用例结束删掉；不要在 `data/` 里造垃圾。
- 崩溃现场用「写完不 close 直接丢弃实例」模拟，不要真去 kill 进程。
- **验证「剪枝 / 快照」这类优化，必须和 `bruteForce` 逐行对拍**，不能只断言行数。
  剪枝剪错的行不会报错，只会静默少返回——这比慢危险一个量级。

## 已知坑

| 坑 | 说明 |
|---|---|
| 快照只带来 2.6× 而非 4.3× | 曾经把同一个 key 存两遍（索引侧 + 页表侧各一份）并解析两遍。现在 `ROWS` 块一行同时给 `rowid` 和 `logical`，恢复时同一个字符串对象插两个 Map |
| 手写哈希表比 Map 慢 | 试过开放寻址表替换 `Map<string, number>`，并不更快——V8 已经内部化字符串键，`Map.set` 三万次 9ms。别重做这个实验 |
| `store.ts` 那 1 个存活变异 | 空洞阈值（`span.len - need < 头部 + 4KB`）。触发它需要精确构造的空洞，成本高于收益，已记为已知项 |
| KV 索引仍走逐页重放 | `capture` / `mock` / `agent` 三个 ns 每次打开都重放 shell 段。块格式已带 tag，加 `KV` 块不用升版本，但还没做 |
| `F_PUNCHHOLE` 需要 C helper | 当前用 `ftruncate` 回收尾部死段；中间空洞要靠 `fcntl(F_PUNCHHOLE)`，Node 没有，得编译一个小 `.node`。`reclaim` 命令检测 `MSTORE_PUNCH_HELPER` 环境变量 |
| 段头读错 1 字节就炸 | 块头是 `[tag u8][pad u8][pad u16][len u32]`，共 8 字节。少读一个 pad 会导致 `seek past end (1371509067 > 1966466)` 这种天文数字报错——看到这种错误先数字节 |
| 快照在 10 万行级别失去线性 | 10k/30k/50k 是 20/36/48ms（约 0.6ms/千行），100k 跳到 178ms、加速比从 5.2× 回落 3.3×，各轮波动 105–190ms。原因：10 万个 key 字符串 + 两遍 Map 插入撞上 V8 老生代 GC。要往上走得改成「偏移表 + 共享字符串池」 |
| `void close()` 会污染下一次测量 | 笔测脚本里写 `void s.close()`，下一轮 `open` 与上一轮的「写快照 + 写 meta」并发跑，量到的是 I/O 竞争。**压测里每一轮都要 `await close()`** |
| 压测不能改原库 | `bench/bench.ts` 曾在 `data/bench.db` 上直接 `clearNs('capture')`：第二次跑就空转，报「清空 0 条」还以为快得不真实，而且库被永久破坏。现在清空在副本上做 |
| `p50=0µs` 是假象 | `performance.now()` 在 macOS 上分辨率约 1µs，纯内存点查落在 0。必须**批内累加再折算 ns/op**（每批 2000 次）。真实值是 p50 82ns / p99 156ns |
| 空 ns 的读压测没有意义 | 点查 `get('capture', k)` 在 capture 为空时全部 miss，返回 null 极快——报出来的延迟测的是 miss 分支。压测前必须断言数据非空，并用 `list()` 拿真实 key |
| 区间基准写在没入索引的字段上 | 默认数值字段只有 `level / updated_at / ms / bytes`。用 `salary` 测 `{gte, lte}` 走的是「字段不存在 → 立刻返回空」，那个 21.9ms 是「为返回空而扫完全表」。**区间基准必须落在真实入索引的字段上** |
| 对照组做了不等量的事 | 拿「只返回 rowids」的旧算法和「返回 rowids + keys」的新算法比，结论会完全反过来：新算法在高命中率下看起来慢一倍，其实是多建了一个 6 万字符串的数组。做 A/B 前先数清楚两边的分配 |
| 块级剪枝在命中率 100% 时会变慢 | 一块都剪不掉时，每块重算字范围纯属开销（实测慢 10–20%）。所以先数候选块，剪不掉 1/4 以上就退回全量遍历 |
| 数值列的块统计只能放宽不能收窄 | 删行、覆盖写都不收缩 min/max。收缩会把「其实仍能命中」的块剪掉，静默丢行。多扫几块只是慢，剪错是错 |
| 掐掉变异测试会留下被改写的源码 | 2026-10-31 实测：串行版变异跑到第 31 分钟被 Ctrl-C，`finally` 没执行，`bruteForce` 里的 `ok = false` 被留在 `ok = true`。之后所有「剪枝漏行」的失败都是这个假象。**现在变异工具一律在临时副本里改，主工作区一个字都不碰，并在结束时校验 sha256**。若见到主工作区莫名多出 `git diff`，先怀疑这个 |

## 提交规范

Conventional Commits，中文正文：

```
feat: 索引快照——冷启动 166ms → 38ms
fix(snapshot): 块头少读一个 pad 字节导致 seek 越界
test: 补 snapshot 的 11 个用例，变异得分 100%
perf: ROWS 块一行同时给 rowid 与 logical，快照体积 -4.4%
docs: design.md 补快照段的生命周期
chore: 升 typescript 到 7.0.2
```

- 一个提交做一件事。格式改动和性能优化分开提，便于 bisect。
- 提交信息里出现数字，必须是自己实跑出来的，并且写清机器条件（本机 x64 / Node 22.22）。
- 不提交 `data/*.db`、`node_modules`、`.DS_Store`（`.gitignore` 已覆盖）。

## 发布

版本号在 `package.json`。当前是源码直跑（`type: module` + Node 类型擦除），
发布 = 打 tag + 在 CHANGELOG 里补一节。`files` 字段只带 `src` / `cli.ts` / `README.md` / `LICENSE`，
新增运行时必需文件记得加进去。

---

有任何一条与实际代码不符，改这个文件，别绕过去。
