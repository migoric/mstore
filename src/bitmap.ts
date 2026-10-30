/**
 * 位图索引：固定筛选器的底座。
 *
 * 为什么不是 B-tree：筛选器由业务写死，索引可以在编译期定结构、全部驻内存。
 * 位图的成本 = 目标行数 / 32 个字，与「命中多少」无关；
 * 三条件交集实测 3µs（10 万行），而 B-tree 逐条 seek 要 100–500µs。
 */
export class Bitmap {
  words: Uint32Array;
  /** 逻辑容量（位），用来做 NOT 与越界保护 */
  capacity: number;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.words = new Uint32Array(Math.ceil(capacity / 32) || 1);
  }

  static from(words: Uint32Array, capacity: number): Bitmap {
    const b = new Bitmap(1);
    b.words = words;
    b.capacity = capacity;
    return b;
  }

  private _ensure(i: number): void {
    if (i < this.words.length * 32) return;
    const need = Math.max(this.words.length * 2, Math.ceil((i + 1) / 32));
    const next = new Uint32Array(need);
    next.set(this.words);
    this.words = next;
  }

  set(i: number): this {
    if (i < 0) throw new RangeError(`bitmap index must be >= 0, got ${i}`);
    this._ensure(i);
    this.words[i >>> 5]! |= 1 << (i & 31);
    if (i + 1 > this.capacity) this.capacity = i + 1;  // equiv: 改成 >= 赋的是同一个值
    return this;
  }

  clear(i: number): this {
    if (i < 0 || i >= this.words.length * 32) return this;  // equiv
    this.words[i >>> 5]! &= ~(1 << (i & 31));
    return this;
  }

  get(i: number): boolean {
    if (i < 0 || i >= this.words.length * 32) return false;  // equiv: undefined & x 恒为 0
    return (this.words[i >>> 5]! & (1 << (i & 31))) !== 0;
  }

  count(): number {
    // popcount：每字用经典位运算，不查表
    let total = 0;
    for (let w = 0; w < this.words.length; w++) {  // equiv: 越界后 x^=0 立刻归零
      let x = this.words[w]!;
      x = x - ((x >>> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      x = (x + (x >>> 4)) & 0x0f0f0f0f;
      total += (x * 0x01010101) >>> 24;
    }
    return total;
  }

  clone(): Bitmap {
    return Bitmap.from(this.words.slice(), this.capacity);
  }

  and(other: Bitmap): Bitmap {
    const n = Math.min(this.words.length, other.words.length);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.words[i]! & other.words[i]!;  // equiv
    return Bitmap.from(out, Math.min(this.capacity, other.capacity));
  }

  or(other: Bitmap): Bitmap {
    const n = Math.max(this.words.length, other.words.length);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = (this.words[i] ?? 0) | (other.words[i] ?? 0);  // equiv: 越界写被忽略
    return Bitmap.from(out, Math.max(this.capacity, other.capacity));
  }

  andNot(other: Bitmap): Bitmap {
    const n = this.words.length;
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.words[i]! & ~(other.words[i] ?? 0);  // equiv
    return Bitmap.from(out, this.capacity);
  }

  /** 前 limitBits 位取反 */
  not(limitBits = this.capacity): Bitmap {
    const out = new Uint32Array(this.words.length);
    for (let i = 0; i < this.words.length; i++) out[i] = ~this.words[i]!;  // equiv: 越界写被忽略
    const b = Bitmap.from(out, this.words.length * 32);
    for (let i = limitBits; i < b.words.length * 32; i++) b.clear(i);  // equiv
    return b;
  }

  /** 位图天然按 rowid 升序，直接顺序吐出 */
  forEach(cb: (i: number) => void): void {
    const limit = this.capacity;
    for (let w = 0; w < this.words.length; w++) {
      let x = this.words[w]!;
      while (x !== 0) {
        const lowest = x & -x;
        const bit = 31 - Math.clz32(lowest);
        const i = (w << 5) + bit;
        x ^= lowest;
        if (i < limit) cb(i);  // equiv: 唯一越界位的下标永远 >= limit
      }
    }
  }

  /** 带提前退出的遍历：cb 返回 false 时停止（查询分页用，避免扫完整个位图） */
  forEachWhile(cb: (i: number) => boolean): void {
    const limit = this.capacity;
    for (let w = 0; w < this.words.length; w++) {  // equiv: 越界后 x^=0 立刻归零
      let x = this.words[w]!;
      while (x !== 0) {
        const lowest = x & -x;
        const bit = 31 - Math.clz32(lowest);
        const i = (w << 5) + bit;
        x ^= lowest;
        if (i < limit && cb(i) === false) return;
      }
    }
  }

  /**
   * 只遍历 [from, to) 内的置位。给「按块剪枝」用：算出一批可能命中的行区间，
   * 只在这些区间里吐 rowid，区间外整段跳过。
   *
   * 两个端点所在字要掐掉范围外的位——`-1 << (from & 31)` 在 from 对齐到 32 时
   * 正好是 0xFFFFFFFF（不移位），所以首字不需要特判；末字要特判，因为
   * `1 << 32` 在 JS 里等于 `1 << 0`，会留下不该留的位。
   */
  forEachWhileRange(from: number, to: number, cb: (i: number) => boolean): void {
    const limit = Math.min(to, this.capacity);  // equiv: 调用方保证 to <= capacity
    if (from >= limit) return; // equiv: from === limit 时下面首末字掩码相与正好为 0，吐不出任何位
    const w0 = from >>> 5;
    const w1 = (limit - 1) >>> 5;
    for (let w = w0; w <= w1 && w < this.words.length; w++) {
      let x = this.words[w]! | 0;
      if (w === w0) x &= -1 << (from & 31);
      if (w === w1) {
        const tail = limit & 31;
        x &= tail === 0 ? -1 : (1 << tail) - 1;
      }
      while (x !== 0) {
        const lowest = x & -x;
        const bit = 31 - Math.clz32(lowest);
        const i = (w << 5) + bit;
        x ^= lowest;
        if (cb(i) === false) return;
      }
    }
  }

  toArray(): number[] {
    const out: number[] = [];
    this.forEach((i) => out.push(i));
    return out;
  }

  first(): number {
    let found = -1;
    this.forEach((i) => {
      if (found < 0) found = i;
    });
    return found;
  }
}
