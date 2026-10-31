/** 共享类型定义（全部是 erasable 的：只用 type / interface，不用 enum） */

export type NsName = 'biz' | 'capture' | 'mock' | 'agent';

/** 段元数据：一个段 = 64B 头 + payload */
export interface SegMeta {
  id: number;
  /** 0=free 1=shell 2=body */
  type: number;
  /** ns 编号 */
  ns: number;
  /** 段头在文件里的偏移 */
  off: number;
  /** payload 已写字节数 */
  len: number;
  /** 这段预留了多少 payload 空间（shell 段 = shellCap，body 区段 = 精确长度） */
  cap: number;
  rows: number;
  crc: number;
  session: number;
  live: boolean;
}

/** body 定位：等于 §9.4 的 offset 交接 */
export interface Locator {
  s: number;
  o: number;
  l: number;
}

/**
 * 索引快照的指针。快照是页表目录 + key→页映射 + 位图索引的一份物化副本，
 * 目的只有一个：把冷启动从「逐页重放 + 重建位图」压成「一次 pread + 一次 memcpy」。
 *
 * `epoch` 是它唯一的有效性判据：它记录快照生成时 `meta.bizEpoch` 的值。
 * 任何改动业务数据（含删除、清空）都会让 bizEpoch 自增，于是旧快照自动失效，
 * 打开时回退逐页重放。这里不用「段表签名」之类的近似判据——近似判据在
 * 「改了数据但段表没变」（页内更新）时会误判有效，那是会读到旧数据的。
 */
export interface SnapMeta {
  /** 快照段的 id */
  seg: number;
  /** 快照段的 payload 起点（段头之后） */
  off: number;
  /** payload 字节数 */
  len: number;
  /** payload 的 CRC32（与段头里那份必须一致） */
  crc: number;
  /** 生成时的 bizEpoch；与 meta.bizEpoch 相等才算有效 */
  epoch: number;
  /** 生成时刻（ms），只用于展示 */
  at: number;
}

export interface KeyIndexMeta {
  seg: number;
  off: number;
  len: number;
  crc: number;
  epoch: number;
  rows: number;
  dirOff: number;
  dirCount: number;
  /** 二进制页目录的 CRC；损坏时整份 key 索引回退为逐页扫描 */
  dirCrc: number;
  primaryOff: number;
  primaryCount: number;
  reverseOff: number;
  reverseCount: number;
  indexOff: number;
  indexLen: number;
  reverseIndexOff: number;
  reverseIndexLen: number;
  bloomOff: number;
  bloomLen: number;
}

export interface Meta {
  gen: number;
  segSize: number;
  nextId: number;
  /** 高水位：下一个段的预留起点 */
  hwm: number;
  segs: SegMeta[];
  /** nsId -> seq */
  seqs: Record<string, number>;
  /** 待回收（已 dead 但还没归还空间）的段 id */
  pending: number[];
  /** 可复用的空洞（打洞或尾部残留产生），alloc 时 first-fit */
  freeSpans?: Array<{ off: number; len: number }>;
  /** 业务数据页表：逻辑页号 → 物理偏移（CoW 写入，旧偏移自动成为垃圾） */
  pageDir?: number[];
  /** 业务数据的修改代数：每次 bizPut/bizDel/bizClear 自增，是快照失效的唯一判据 */
  bizEpoch?: number;
  /** 索引快照指针；不存在表示还没有快照 */
  snap?: SnapMeta;
  /** 持久化 key 索引与二进制页目录；旧库没有该字段时走 JSON / 快照回退 */
  keys?: KeyIndexMeta;
}

export interface Entry {
  v: unknown;
  b?: Locator;
  segId: number;
  ts: number;
}

/** 打开库时走的哪条路，以及快照的现状（客户端「库信息」面板直接展示） */
export interface SnapshotStats {
  enabled: boolean;
  /** 上次 open 走的路：snapshot / replay / fresh */
  path: 'snapshot' | 'replay' | 'fresh';
  /** 上次 open 耗时（ms） */
  openMs: number;
  /** 没用快照时记一句为什么（正常应为空） */
  note: string;
  /** 当前的 bizEpoch */
  epoch: number;
  /** 快照是否与当前 epoch 对齐 */
  current: boolean;
  bytes: number;
  /** 快照里装了多少行（上次恢复的规模；没命中快照时为 0） */
  rows: number;
  /** 生成时刻（ms），0 表示还没有快照 */
  at: number;
}

export interface StoreStats {
  file: string;
  bytesLogical: number;
  bytesAllocated: number;
  segSize: number;
  segs: { shell: number; body: number; free: number; snapshot: number; keys: number };
  deadSegs: number;
  pendingReclaim: number;
  records: Record<string, number>;
  seqs: Record<string, number>;
  crcImpl: string;
  fsyncs: number;
  committer: ReturnType<() => unknown> | unknown;
  snapshot: SnapshotStats;
}

export interface CheckIssue {
  level: 'error' | 'warn';
  where: string;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  segs: number;
  shellSegs: number;
  bodySegs: number;
  deadSegs: number;
  records: number;
  orphanQuery: number;
  issues: CheckIssue[];
}
