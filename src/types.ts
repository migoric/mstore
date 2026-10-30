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
}

export interface Entry {
  v: unknown;
  b?: Locator;
  segId: number;
  ts: number;
}

export interface StoreStats {
  file: string;
  bytesLogical: number;
  bytesAllocated: number;
  segSize: number;
  segs: { shell: number; body: number; free: number };
  deadSegs: number;
  pendingReclaim: number;
  records: Record<string, number>;
  seqs: Record<string, number>;
  crcImpl: string;
  fsyncs: number;
  committer: ReturnType<() => unknown> | unknown;
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
