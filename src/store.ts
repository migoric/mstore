/**
 * mstore 核心：单文件存储。
 *
 *   [0,4K) 文件头 | [4K,+1M) meta.a | [+1M,+2M) meta.b | [2M,EOF) 段序列
 *
 * 两种落盘单元（踩坑之后的结论）：
 *   - SHELL 段：预分配固定 cap（默认 1MB），记录用 NDJSON 攒在段缓冲里批量写
 *   - BODY 区段：**精确长度、不留预留**，写完即定，永不改写
 *
 * 为什么 body 不预留：实测多次 ftruncate 增长会让 APFS 的稀疏文件失效 ——
 * 预留 16MB × 6 段，把 23MB 数据占成 98MB。所以预留只允许出现在 shell 段，
 * 且 cap 压到 1MB；body 一律精确尺寸追加，写多少占多少。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as F from './format.ts';
import { Io } from './io.ts';
import { BufferPool, SegmentBuffer } from './bufferpool.ts';
import { Committer } from './committer.ts';
import { crc32, crc32Impl } from './crc32.ts';
import { PageTable } from './pagetable.ts';
import { BizIndex } from './bizindex.ts';
import type { Filter } from './bizindex.ts';
import type {
  Meta,
  SegMeta,
  Entry,
  Locator,
  CheckReport,
  CheckIssue,
  StoreStats,
  NsName,
} from './types.ts';

const MB = 1024 * 1024;

export interface StoreOpts {
  /** shell 段预留大小，默认 1MB。不要随意调大：预留会真占磁盘 */
  shellCap?: number;
  /** @deprecated 用 shellCap；保留是为了老脚本兼容 */
  segSize?: number;
  /** 业务数据里走位图的枚举字段，默认 dept / status / type / kind */
  bizEnumFields?: string[];
  /** 业务数据里走数值范围的字段，默认 level / updated_at / ms / bytes */
  bizNumFields?: string[];
  /** 页大小（CoW 页表），默认 4096 */
  pageSize?: number;
}

const DEFAULT_ENUM_FIELDS = ['dept', 'status', 'type', 'kind'];
const DEFAULT_NUM_FIELDS = ['level', 'updated_at', 'ms', 'bytes'];

export interface PutResult {
  seq: number;
  loc?: Locator;
}

export interface ListOpts {
  limit?: number;
  after?: string;
}

interface FreeSpan {
  off: number;
  len: number;
}

export class Store {
  readonly io: Io;
  readonly pool: BufferPool;
  readonly committer: Committer;
  meta: Meta;
  readonly shellCap: number;
  closed = false;

  private idx = new Map<number, Map<string, Entry>>();
  private order = new Map<number, string[]>();
  private active = new Map<number, SegmentBuffer>();
  private segById = new Map<number, SegMeta>();
  private freeSpans: FreeSpan[] = [];
  private metaSlot: 'a' | 'b' = 'a';
  private metaDirty = false; // equiv: 初值 true 只让首次提交多写一次 meta，落盘结果相同
  private seqsDirty = false; // equiv: 初值 true 只会让首次提交多写一次 meta，结果一样
  private lastMetaAt = 0;
  readonly pages: PageTable;
  readonly biz: BizIndex;

  private constructor(io: Io, meta: Meta, slot: 'a' | 'b', shellCap: number, opts: StoreOpts = {}) {
    this.io = io;
    this.meta = meta;
    this.metaSlot = slot;
    this.shellCap = shellCap;
    this.pool = new BufferPool(io);
    this.committer = new Committer({
      flush: () => this._flushNow(),
      fsync: () => this.io.fsync(),
    });
    for (const s of meta.segs) this.segById.set(s.id, s);
    this.freeSpans = meta.freeSpans ?? [];
    this.pages = new PageTable(
      io,
      meta,
      (bytes) => this._allocRun(bytes),
      () => {
        this.metaDirty = true; // equiv: 每次 writePage 都走 _allocRun，那条路已经标过脏
      },
      { pageSize: opts.pageSize }
    );
    this.biz = new BizIndex(opts.bizEnumFields ?? DEFAULT_ENUM_FIELDS, opts.bizNumFields ?? DEFAULT_NUM_FIELDS);
  }

  // ---------------- 创建 / 打开 ----------------

  static create(file: string, opts: StoreOpts = {}): Store {
    const shellCap = opts.shellCap ?? opts.segSize ?? 1 * MB;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const io = Io.open(file, { create: true });
    io.writeAt(F.encodeHeader({ segSize: shellCap, createdAt: Math.floor(Date.now() / 1000) }), 0);
    io.truncate(F.DATA_OFF);
    const meta = F.newMeta(shellCap);
    const store = new Store(io, meta, 'a', shellCap, opts);
    store._writeMeta();
    io.fsync();
    return store;
  }

  static open(file: string, opts: StoreOpts = {}): Store {
    const io = Io.open(file);
    const head = F.decodeHeader(io.readAt(0, F.HEADER_SIZE));
    const a = F.decodeMeta(io.readAt(F.META_A_OFF, F.META_SIZE));
    const b = F.decodeMeta(io.readAt(F.META_B_OFF, F.META_SIZE));
    const candidates: Array<{ meta: Meta; slot: 'a' | 'b' }> = [];
    if (a) candidates.push({ meta: a, slot: 'a' });
    if (b) candidates.push({ meta: b, slot: 'b' });
    if (candidates.length === 0) throw new Error('both meta blocks are corrupt');
    candidates.sort((x, y) => y.meta.gen - x.meta.gen);
    const picked = candidates[0]!;
    const store = new Store(io, picked.meta, picked.slot, opts.shellCap ?? opts.segSize ?? head.segSize ?? MB, opts);
    store._rebuildIndex();
    store._reopenShell();
    store.pages.load();
    store._rebuildBiz();
    return store;
  }

  /** 从 shell 段重放索引；body 区段不扫（由 shell 里的 locator 引用） */
  private _rebuildIndex(): void {
    const shells = this.meta.segs
      .filter((s) => s.type === F.T.SHELL && s.live && s.len > 0)
      .sort((x, y) => x.id - y.id);
    for (const seg of shells) {
      const payload = this.io.readAt(seg.off + F.SEG_HEADER_SIZE, seg.len);
      let at = 0;
      while (at < payload.length) { // equiv: at === length 时 indexOf 返回 -1，一样是 break
        const nl = payload.indexOf(0x0a, at);
        if (nl < 0) break; // 尾部半行：崩溃残留，丢弃
        const line = payload.subarray(at, nl).toString('utf8');
        at = nl + 1;
        if (!line) continue;
        let rec: { op: string; k: string; v?: unknown; b?: Locator; t?: number; q?: number };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const n = F.nsId(seg.ns);
        if (typeof rec.q === 'number' && rec.q > (this.meta.seqs[String(n)] ?? 0)) {
          this.meta.seqs[String(n)] = rec.q;
        }
        if (rec.op === 'd') this._dropFromIndex(n, rec.k);
        else {
          this._upsertIndex(n, rec.k, {
            v: rec.v as unknown,
            b: rec.b,
            segId: seg.id,
            ts: rec.t ?? 0,
          });
        }
      }
    }
  }

  /** 从页表重建位图索引（页表是唯一真相，索引只是加速结构） */
  private _rebuildBiz(): void {
    this.biz.clear();
    for (const [key, value] of this.pages.entries()) {
      this.biz.put(key, value);
    }
  }

  /** 打开时把每个 ns 的最后一个 shell 段接上继续追加 */
  private _reopenShell(): void {
    for (const seg of this.meta.segs) {
      if (!seg.live || seg.type !== F.T.SHELL) continue;
      const cur = this.active.get(seg.ns);
      if (cur && cur.id > seg.id) continue; // equiv: seg id 不重复，cur.id 不可能等于 seg.id
      const b = new SegmentBuffer({
        id: seg.id,
        off: seg.off,
        cap: seg.cap,
        ns: seg.ns,
        type: seg.type,
        session: seg.session,
      });
      b.used = seg.len;
      b.flushed = seg.len;
      b.rows = seg.rows;
      b.crc = seg.crc;
      this.pool.add(b);
      this.active.set(seg.ns, b);
    }
  }

  // ---------------- 段分配 ----------------

  /** 分配一段空间：优先复用空洞，否则追加到高水位 */
  /** 在文件尾部申请一段连续空间（8 字节对齐），给页表用 */
  private _allocRun(bytes: number): number {
    const off = this.meta.hwm;
    this.meta.hwm = off + bytes;
    this.io.reserve(this.meta.hwm);
    this.metaDirty = true; // equiv: hwm 直接长在 meta 对象上，写 meta 时必然带上；页表 persistDir 也会标脏
    return off;
  }

  private _registerSeg(ns: number, type: number, cap: number, len: number, rows: number, crc: number): SegMeta {
    const need = F.SEG_HEADER_SIZE + cap;
    let off: number;
    const i = this.freeSpans.findIndex((s) => s.len >= need);
    if (i >= 0) {
      const span = this.freeSpans[i]!;
      off = span.off;
      if (span.len - need < F.SEG_HEADER_SIZE + 4096) this.freeSpans.splice(i, 1);
      else {
        span.off += need;
        span.len -= need;
      }
    } else {
      off = this.meta.hwm;
      this.meta.hwm = off + need;
      this.io.reserve(this.meta.hwm);
    }
    const id = this.meta.nextId++;
    const seg: SegMeta = { id, type, ns, off, cap, len, rows, crc, session: 0, live: true };
    this.meta.segs.push(seg);
    this.segById.set(id, seg);
    this.metaDirty = true;
    return seg;
  }

  private _allocShell(ns: number): SegmentBuffer {
    const seg = this._registerSeg(ns, F.T.SHELL, this.shellCap, 0, 0, 0);
    const b = new SegmentBuffer({ id: seg.id, off: seg.off, cap: seg.cap, ns, type: F.T.SHELL, session: 0 });
    this.pool.add(b);
    this.active.set(ns, b);
    return b;
  }

  private _currentShell(ns: number): SegmentBuffer {
    return this.active.get(ns) ?? this._allocShell(ns);
  }

  private _syncSeg(b: SegmentBuffer): void {
    const seg = this.segById.get(b.id);
    if (!seg) return;
    seg.len = b.used;
    seg.rows = b.rows;
    seg.crc = b.crc;
    // 故意不标 metaDirty：段进度由 500ms 心跳持久化，
    // 崩溃最多丢一个心跳窗口（与设计总纲 §3.5 的「抓包每 2s」同源）。
  }

  private _appendShell(ns: number, bytes: Buffer): number {
    let b = this._currentShell(ns);
    if (!b.append(bytes)) {
      b = this._allocShell(ns);
      if (!b.append(bytes)) {
        throw new Error(`record too large for shellCap (${bytes.length}B > ${this.shellCap}B)`);
      }
    }
    this._syncSeg(b);
    return b.id;
  }

  /**
   * body 区段：精确长度、不留预留、写完即定。
   * 直接写盘不进 buffer pool —— body 通常几百 KB 起，攒批没意义，
   * 而且省掉一次内存拷贝。
   */
  private _writeBodyExtent(ns: number, frame: Buffer): Locator {
    const seg = this._registerSeg(ns, F.T.BODY, frame.length, frame.length, 1, crc32(frame));
    this.io.writeAt(
      F.encodeSegHeader({ id: seg.id, type: F.T.BODY, ns, rows: 1, len: frame.length, crc: seg.crc }),
      seg.off
    );
    this.io.writeAt(frame, seg.off + F.SEG_HEADER_SIZE);
    return { s: seg.id, o: seg.off + F.SEG_HEADER_SIZE + 4, l: frame.length - 4 };
  }

  private _upsertIndex(ns: number, key: string, e: Entry): void {
    let m = this.idx.get(ns);
    if (!m) this.idx.set(ns, (m = new Map()));
    if (!m.has(key)) {
      let o = this.order.get(ns);
      if (!o) this.order.set(ns, (o = []));
      o.push(key);
    }
    m.set(key, e);
  }

  private _dropFromIndex(ns: number, key: string): void {
    this.idx.get(ns)?.delete(key);
  }

  private _nextSeq(n: number): number {
    const seq = (this.meta.seqs[String(n)] ?? 0) + 1;
    this.meta.seqs[String(n)] = seq;
    this.seqsDirty = true;
    return seq;
  }

  // ---------------- 公开读写 API ----------------

  put(ns: NsName | number, key: string, value: unknown): Promise<PutResult> {
    const n = F.nsId(ns);
    return this.committer.submit<PutResult>(() => {
      const seq = this._nextSeq(n);
      const t = Date.now();
      this._appendShell(n, Buffer.from(JSON.stringify({ op: 'p', k: key, v: value, t, q: seq }) + '\n', 'utf8'));
      this._upsertIndex(n, key, { v: value, segId: -1, ts: t });
      return { seq };
    });
  }

  putBody(ns: NsName | number, key: string, body: Uint8Array, value: unknown = null): Promise<PutResult> {
    const n = F.nsId(ns);
    return this.committer.submit<PutResult>(() => {
      const seq = this._nextSeq(n);
      const t = Date.now();
      const loc = this._writeBodyExtent(n, F.frameBody(body));
      this._appendShell(n, Buffer.from(JSON.stringify({ op: 'p', k: key, v: value, b: loc, t, q: seq }) + '\n', 'utf8'));
      this._upsertIndex(n, key, { v: value, b: loc, segId: loc.s, ts: t });
      return { seq, loc };
    });
  }

  del(ns: NsName | number, key: string): Promise<PutResult> {
    const n = F.nsId(ns);
    return this.committer.submit<PutResult>(() => {
      const seq = this._nextSeq(n);
      this._appendShell(n, Buffer.from(JSON.stringify({ op: 'd', k: key, t: Date.now(), q: seq }) + '\n', 'utf8'));
      this._dropFromIndex(n, key);
      return { seq };
    });
  }

  get(ns: NsName | number, key: string): Entry | undefined {
    return this.idx.get(F.nsId(ns))?.get(key);
  }

  // ---------------- 业务数据（CoW 页表 + 位图） ----------------

  /** 业务行写：页表 CoW + 位图同步更新 + 一次 group commit */
  bizPut(key: string, value: unknown): Promise<{ seq: number; rowid: number }> {
    const n = F.nsId('biz');
    return this.committer.submit(() => {
      const seq = this._nextSeq(n);
      this.pages.put(key, value);
      const rowid = this.biz.put(key, value);
      this.metaDirty = true; // equiv: pages.put 已经通过 markDirty 标过脏，这里只是不依赖那条路径
      return { seq, rowid };
    });
  }

  bizGet(key: string): unknown {
    return this.pages.get(key);
  }

  bizDel(key: string): Promise<{ seq: number; removed: boolean }> {
    const n = F.nsId('biz');
    return this.committer.submit(() => {
      const seq = this._nextSeq(n);
      const removed = this.pages.delete(key);
      this.biz.delete(key);
      this.metaDirty = true; // equiv: pages.delete 要么 writePage（persistDir 标脏），要么 flushOpen 时落盘，总会走到

      return { seq, removed };
    });
  }

  /** 固定筛选器 → 位图执行；返回 key 列表（天然按 rowid 升序） */
  bizQuery(filter: Filter = {}): { keys: string[]; rowids: number[] } {
    return this.biz.query(filter);
  }

  bizStats(): { pages: ReturnType<PageTable['stats']>; index: ReturnType<BizIndex['stats']> } {
    return { pages: this.pages.stats(), index: this.biz.stats() };
  }

  bizClear(): Promise<{ seq: number; rows: number }> {
    const n = F.nsId('biz');
    return this.committer.submit(() => {
      const seq = this._nextSeq(n);
      const rows = this.biz.size;
      this.pages.clear();
      this.biz.clear();
      this.metaDirty = true; // equiv: pages.clear 走 persistDir，已经标过脏
      return { seq, rows };
    });
  }

  getBody(ns: NsName | number, key: string): Buffer | null {
    const e = this.get(ns, key);
    if (!e?.b) return null;
    return this.io.readAt(e.b.o, e.b.l);
  }

  bodyAt(loc: Locator): Buffer {
    return this.io.readAt(loc.o, loc.l);
  }

  list(ns: NsName | number, opts: ListOpts = {}): Array<{ key: string; value: unknown; ts: number }> {
    const n = F.nsId(ns);
    const m = this.idx.get(n);
    const ord = this.order.get(n) ?? [];
    const limit = opts.limit ?? 50;
    const out: Array<{ key: string; value: unknown; ts: number }> = [];
    let start = 0;
    if (opts.after) {
      const i = ord.indexOf(opts.after);
      if (i >= 0) start = i + 1;
    }
    for (const k of ord.slice(start)) {
      if (out.length >= limit) break;
      const e = m?.get(k);
      if (!e) continue;
      out.push({ key: k, value: e.v, ts: e.ts });
    }
    return out;
  }

  count(ns: NsName | number): number {
    return this.idx.get(F.nsId(ns))?.size ?? 0;
  }

  /** 清空一个 ns：标记段组 dead → 尾部截断 → 其余登记为可复用空洞（§15.4 档位 A） */
  clearNs(ns: NsName | number): Promise<{ freedBytes: number; deadSegs: number; truncated: number }> {
    const n = F.nsId(ns);
    return this.committer.submit(() => {
      let dead = 0;
      for (const seg of this.meta.segs) {
        if (seg.ns !== n || !seg.live) continue;
        seg.live = false;
        dead++;
      }
      const b = this.active.get(n);
      if (b) {
        this.pool.remove(b.id);
        this.active.delete(n);
      }
      this.idx.delete(n);
      this.order.delete(n);
      this.meta.seqs[String(n)] = 0;
      const before = this.io.size();
      const truncated = this._reclaimTail();
      const freedBytes = Math.max(0, before - this.io.size());
      this.metaDirty = true;
      return { freedBytes, deadSegs: dead, truncated };
    });
  }

  private _reclaimTail(): number {
    let n = 0;
    for (;;) {
      const dead = this.meta.segs.filter((s) => !s.live);
      if (dead.length === 0) break;
      dead.sort((a, b) => b.off - a.off);
      const last = dead[0]!;
      const end = last.off + F.SEG_HEADER_SIZE + last.cap;
      if (end < this.io.size()) break; // 不是物理尾部，留着复用
      this.io.truncate(last.off);
      this.meta.hwm = Math.min(this.meta.hwm, last.off);
      this.meta.segs = this.meta.segs.filter((s) => s.id !== last.id);
      this.segById.delete(last.id);
      this.meta.pending = this.meta.pending.filter((id) => id !== last.id);
      n++;
    }
    for (const seg of this.meta.segs) {
      if (seg.live) continue;
      if (this.meta.pending.includes(seg.id)) continue;
      this.meta.pending.push(seg.id);
      this.freeSpans.push({ off: seg.off, len: F.SEG_HEADER_SIZE + seg.cap });
    }
    return n;
  }

  /** 可选：把 pending 段真正还给文件系统（需 MSTORE_PUNCH_HELPER） */
  reclaim(): { punched: number; bytes: number } {
    let punched = 0;
    let bytes = 0;
    const keep: number[] = [];
    for (const id of this.meta.pending) {
      const seg = this.segById.get(id);
      if (!seg) continue;
      if (this.io.punchHole(seg.off, F.SEG_HEADER_SIZE + seg.cap)) {
        punched++;
        bytes += seg.cap;
        this.meta.segs = this.meta.segs.filter((s) => s.id !== id);
        this.segById.delete(id);
      } else {
        keep.push(id);
      }
    }
    this.meta.pending = keep;
    this.metaDirty = true;
    return { punched, bytes };
  }

  // ---------------- 提交与元数据 ----------------

  private _flushNow(): void {
    this.pool.flushAll();
    this.pages.flushOpen(); // 追加缓冲先落盘，再写页目录
    const now = Date.now();
    const structural = this.metaDirty;
    if (structural || (this.seqsDirty && now - this.lastMetaAt > 500)) { // equiv: 500ms 边界差 1ms 观察不到
      this._writeMeta();
      this.lastMetaAt = now;
    }
  }

  /** 无条件写一份 meta 到另一个槽（要不要写由调用方判断，这里不做二次过滤） */
  private _writeMeta(): void {
    this.meta.gen += 1;
    this.meta.freeSpans = this.freeSpans;
    const buf = F.encodeMeta(this.meta);
    const off = this.metaSlot === 'a' ? F.META_B_OFF : F.META_A_OFF; // equiv: 两个槽交替写，相位不影响恢复（恢复按 gen 取大）
    this.io.writeAt(buf, off);
    this.metaSlot = this.metaSlot === 'a' ? 'b' : 'a'; // equiv: 两值取反，`!==` 与本式逐值相同
    this.metaDirty = false;
    this.seqsDirty = false; // equiv: 只有 _flushNow 读它，而下一次提交碰 seq 就会重新置 true
  }

  async flush(): Promise<void> {
    await this.committer.drainNow();
    this.pool.flushAll();
    this.pages.flushOpen();
    this._writeMeta();
    this.io.fsync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.pool.clear();
    this.io.close();
    this.closed = true;
  }

  // ---------------- 诊断 ----------------

  stats(): StoreStats {
    let shell = 0;
    let body = 0;
    let dead = 0;
    let allocated = 0;
    for (const s of this.meta.segs) {
      if (s.type === F.T.SHELL) shell++;
      else if (s.type === F.T.BODY) body++;
      if (!s.live) dead++;
      allocated += F.SEG_HEADER_SIZE + s.cap;
    }
    const records: Record<string, number> = {};
    for (const [ns, m] of this.idx) records[F.NS_NAME[ns] ?? String(ns)] = m.size;
    return {
      file: this.io.path,
      bytesLogical: this.io.size(),
      bytesAllocated: F.DATA_OFF + allocated,
      segSize: this.shellCap,
      segs: { shell, body, free: this.freeSpans.length },
      deadSegs: dead,
      pendingReclaim: this.meta.pending.length,
      records,
      seqs: this.meta.seqs,
      crcImpl: crc32Impl,
      fsyncs: this.io.fsyncCount,
      committer: this.committer.report(),
    };
  }

  /** 全量自检：段头一致性、CRC、shell 行可解析、body locator 越界 */
  check(): CheckReport {
    const issues: CheckIssue[] = [];
    let shellSegs = 0;
    let bodySegs = 0;
    let dead = 0;

    for (const seg of this.meta.segs) {
      if (seg.type === F.T.SHELL) shellSegs++;
      if (seg.type === F.T.BODY) bodySegs++;
      if (!seg.live) {
        dead++;
        continue;
      }
      const hdr = F.decodeSegHeader(this.io.readAt(seg.off, F.SEG_HEADER_SIZE));
      if (!hdr) {
        issues.push({ level: 'error', where: `seg ${seg.id}`, detail: 'bad segment magic' });
        continue;
      }
      if (hdr.id !== seg.id || hdr.type !== seg.type || hdr.ns !== seg.ns) {
        issues.push({
          level: 'error',
          where: `seg ${seg.id}`,
          detail: `header mismatch: meta(${seg.id}/${seg.type}/${seg.ns}) disk(${hdr.id}/${hdr.type}/${hdr.ns})`,
        });
      }
      if (hdr.len !== seg.len) {
        issues.push({
          level: 'warn',
          where: `seg ${seg.id}`,
          detail: `len drift: meta=${seg.len} disk=${hdr.len} (crash before meta commit?)`,
        });
      }
      const payload = this.io.readAt(seg.off + F.SEG_HEADER_SIZE, seg.len);
      const got = crc32(payload);
      if (seg.crc !== got) {
        issues.push({
          level: 'error',
          where: `seg ${seg.id}`,
          detail: `CRC mismatch: meta=${seg.crc.toString(16)} disk=${got.toString(16)}`,
        });
      }
      if (seg.type === F.T.SHELL) {
        let at = 0;
        let lines = 0;
        while (at < payload.length) {
          const nl = payload.indexOf(0x0a, at);
          if (nl < 0) {
            issues.push({ level: 'warn', where: `seg ${seg.id}`, detail: 'trailing partial line' });
            break;
          }
          try {
            JSON.parse(payload.subarray(at, nl).toString('utf8'));
            lines++;
          } catch {
            issues.push({ level: 'error', where: `seg ${seg.id}`, detail: `unparsable line at ${at}` });
            break;
          }
          at = nl + 1;
        }
        if (lines !== hdr.rows) {
          issues.push({
            level: 'warn',
            where: `seg ${seg.id}`,
            detail: `rows drift: header=${hdr.rows} actual=${lines}`,
          });
        }
      }
    }

    let checked = 0;
    for (const [, m] of this.idx) {
      for (const [, e] of m) {
        if (!e.b) continue;
        checked++;
        const seg = this.segById.get(e.b.s);
        if (!seg) {
          issues.push({ level: 'error', where: 'locator', detail: `body points to missing seg ${e.b.s}` });
          continue;
        }
        const min = seg.off + F.SEG_HEADER_SIZE + 4;
        const max = seg.off + F.SEG_HEADER_SIZE + seg.cap;
        if (e.b.o < min || e.b.o + e.b.l > max) {
          issues.push({
            level: 'error',
            where: `seg ${seg.id}`,
            detail: `body range out of bounds: ${e.b.o}+${e.b.l} not in [${min},${max})`,
          });
        }
      }
    }

    return {
      ok: issues.filter((i) => i.level === 'error').length === 0,
      segs: this.meta.segs.length,
      shellSegs,
      bodySegs,
      deadSegs: dead,
      records: [...this.idx.values()].reduce((a, m) => a + m.size, 0),
      orphanQuery: checked,
      issues,
    };
  }
}

/** check() 用：整段 payload 的 CRC（与写入时的增量 CRC 必须一致） */
export function crcOfPayload(payload: Buffer): number {
  return crc32(payload);
}
