# Contributing

欢迎提交 issue 和 PR。这个仓库对「数字」和「可复现」的要求比一般项目高一点，
下面说明具体期待。

## 开工之前

- 先读 [`AGENTS.md`](AGENTS.md)：结构、命令、代码约定、改动纪律、已知坑都在里面。
- 架构层面的改动（文件格式、提交路径、索引结构）先改 [`docs/design.md`](docs/design.md)，
  在 PR 里一起提。设计先行，代码后到。
- 大改动请先开 issue 对齐思路，避免写完发现方向不对。

## 环境

- Node **>= 22.18**（需要原生 TS 类型擦除 + `zlib.crc32`）
- 零运行时依赖是硬约束。新增依赖需要在 issue 里论证标准库做不到什么。
- 开发依赖只有 `typescript` 和 `@types/node`。

```bash
git clone https://github.com/migoric/mstore.git
cd mstore
npm install
npm run typecheck && npm test
```

## PR 要求清单

一个 PR 算可合并，需要同时满足：

- [ ] `npm run typecheck` 零错误
- [ ] `npm test` 全绿，且新增逻辑有对应用例
- [ ] 改动涉及 `src/` 时，**目标文件变异得分 100%**；有存活变异必须逐个解释
      （真等价的在同一行尾注 `// equiv` 并说明理由）
- [ ] 性能相关改动附上 `npm run bench` / `npm run bench:open` 的前后对比数据，
      并写明机器条件
- [ ] 文件格式有变动时，在 `CHANGELOG.md` 写清「兼容 / 不兼容」
- [ ] 提交信息符合 Conventional Commits（见 AGENTS.md）

变异测试单独跑需要的目标：

```bash
npm run mutate          # bitmap
npm run mutate:index    # bizindex
npm run mutate:page     # pagetable
npm run mutate:snap     # snapshot
npm run mutate:store    # store
```

## 代码风格

- 类型擦除友好：不用 `enum` / `namespace` / 构造函数参数属性（`erasableSyntaxOnly`）。
- 纯类型导入写 `import type`（`verbatimModuleSyntax`）。
- 下标访问先收窄再用（`noUncheckedIndexedAccess`）。
- 注释写「为什么」，特别是反直觉的地方——把实测结论留在代码旁边。
- 不要为了「看起来更优雅」引入抽象层。这个代码库的价值在于每层都能对应到一次系统调用。

## 测试风格

- 用例按模块放，文件名与被测模块对应（`src/pagetable.ts` → `test/pagetable.test.ts`）。
- 涉及 fsync 的用例用 `putRows()` 批量写，别在循环里 `await bizPut`。
- 断言要能被变异杀掉：优先断言**行为**（查询结果、文件字节、统计值），
  而不是断言中间变量。
- 不要为了让用例过而弱化断言。宁可先记成已知问题，也不要写一个永远为真的断言。

## 报 Bug

用 issue 模板，务必包含：

1. `node -v`、操作系统、架构
2. 复现步骤（最好是一条 `cli.ts` 命令或一段最小脚本）
3. `./cli.ts check <file.db>` 的输出
4. 期望行为 vs 实际行为

**不要**在 issue 里贴真实业务数据。如果必须，先脱敏或换成 `bench/gen.ts` 造的样本库。

## 安全

见 [`SECURITY.md`](SECURITY.md)。安全相关问题请走私信，不要开公开 issue。

## 许可

提交即表示同意以 [MIT](LICENSE) 许可发布你的贡献。
