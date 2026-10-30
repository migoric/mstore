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

## 已知取舍与坑

- **body 不预留空间**：实测多次 `ftruncate` 增长会让 APFS 稀疏文件失效，预留 16MB×6 会把 23MB 数据占成 98MB。所以只有 shell 段预留（1MB），body 精确分配。
- **清空后空间不一定立刻归还**：尾部死段用 `ftruncate`，中间死段先登记为可复用空洞。要立刻归还需要 `F_PUNCHHOLE`（Node 无 `fcntl`，需 20KB C helper，见 `MSTORE_PUNCH_HELPER`）。
- **崩溃最多丢一个心跳窗口**：段进度 500ms 落一次 meta；`flush()`/`close()` 强制落盘。
- **单写者**：不要开两个进程写同一个 `store.db`。
- **meta 上限 1MB**（约 1.2 万段）：超了需要调大 `META_SIZE` 或压缩段表。

## 需要什么

- Node **≥ 22.18**（能直接跑 `.ts` 的类型擦除；更早版本需要先 `tsc` 编译，且没有 `zlib.crc32`）
- 类型检查：`npm run typecheck`（TypeScript 7）
- 测试：`npm test`（`node --test`）

## 设计来源

完整设计文档：`docs/design.md`（《本地数据子系统 · 设计总纲》，含单文件形态、段表、清空三档、跨表索引、可读性预算）。
本仓库是实现侧的最小可用内核（M1），尚未实现：位图索引、抓包列存、向量旁路。

## License

MIT
