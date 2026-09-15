# TauriTavern 存储适配 tt.1

## 基线

- 千千结：`atonal519/ST-MyriadKnots`，`5904f43b0631f5cddb33f31dfe125a239105f7fc`，0.2.3。
- 白鳥 API 参考：`atonal519/ST-BaiNiaoData`，`fa0b8f8d668e19fcb260b37e58161e6af274338d`。
- TT：正式标签 `v2.2.0`，`2b4de4b8a8aab467d9e75d546be84754918cc026`。
- TT 官方接口：[extension.store](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/docs/API/Extension.md)。

## 实现

`src/backend-client.js` 在识别 TT 宿主时选择 `src/tauri-backend.js`；普通 ST/Luker 和调用方明确注入的 fetch 保留原行为。没有全局替换 fetch，模型 API、聊天和世界书请求仍走宿主原有通道。

等待 TT ready 后调用公开的 `tryGetJson / setJson / listKeys / listTables`。不存在的记录返回 404，revision 不匹配返回 409；读盘失败和损坏数据会明确失败，不能当成空记录覆盖。

数据位置：`data_root/_tauritavern/extension-store/qqj-bainiao-v1/kv/`。table 是 namespace 与 collection 的 SHA-256，key 是 recordId 的 SHA-256，原始键保存在文件内容中并在读取时校验。中文、较长键和特殊字符不会直接作为路径使用。

每个键对应一个文件，文件内同时保存当前 envelope 与删除历史。删除、恢复和更新都只提交一次 TT `setJson`，复用 TT 的临时文件替换机制。支持读、写、列出、删除、回收站查询和恢复；回收站没有自动清理。其磁盘布局不同于原白鳥服务端，不能直接互相覆盖或迁移。

同一应用运行环境共享写入队列；如宿主提供 Web Locks 则同时使用。TT 的公开 API 没有原生 compare-and-swap，**不承诺多个应用进程、外部文件写入者、设备同步并发写入时的版本原子性**。这是单个 TT 应用内的适配。

取消/超时会阻止尚未提交的写入；已经交给原生层的写入无法撤回，可能在调用方超时后完成。发生此类异常应重新读取确认，不能盲目重试旧 revision。队列会等原生写入结束后才释放。

## 验证

- 生产构建成功；安装所需 `dist/qqj-app.js` 已编译，manifest 的 cache key 对应产物哈希。
- 新增 12 项适配测试全部通过：本地文件持久化、模拟重启、中文/长键、并发冲突、删除恢复、写入失败、损坏数据、取消、启动等待与超时、路由选择。
- 另有一项生产 bundle 的 TT 启动测试，验证经本地存储建立聊天身份，并且不请求白鳥 HTTP 后端。
- 完整回归最初 900 项中 898 通过：缺少 ST-SevenDaysCal 测试夹具一项，补齐后其所在文件 31 项全部通过；另一个「刷新中断后手动补最后 CSE 才通知时间并落盘」测试失败，已在**未修改的上游同一提交**独立复现。没有为适配改动该业务逻辑。
- 没有 iOS 真机、真实模型 API 或用户现有长档的端到端测试。自动化测试中的原生存储接口使用临时文件替身，不等于真机验证。

## 本地开发

```sh
npm ci
npm run build
node scripts/tt-stamp.mjs
npm test
```

上游 `tests/settings-api.test.mjs` 要求本仓库同级目录有 `ST-SevenDaysCal/runtime/settings.js`（来自 atonal519/ST-SevenDaysCal），仅为测试夹具，不是使用本适配版的必装依赖。

本分叉的前端业务版本保留 0.2.3，适配版本记为 tt.1。更新上游后需要重新构建、生成缓存哈希并回归验证；不要直接用原版 dist 覆盖本分叉。
