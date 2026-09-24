# TauriTavern 存储适配 tt.2

## 基线

- 千千结：`atonal519/ST-MyriadKnots`，`e4e2d14a44a8a9845db1e2f16d1f300a34885252`，0.5.1。
- 白鳥 API 参考：`atonal519/ST-BaiNiaoData`，`e86262c`，2026-09-22 新增永久删除接口。
- TT：正式标签 `v2.2.0`，`2b4de4b8a8aab467d9e75d546be84754918cc026`。
- TT 官方接口：[extension.store](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/docs/API/Extension.md)。

## 实现

`src/backend-client.js` 在识别 TT 宿主时选择 `src/tauri-backend.js`；普通 ST/Luker 和调用方明确注入的 fetch 保留原行为。没有全局替换 fetch，模型 API、聊天和世界书请求仍走宿主原有通道。

等待 TT ready 后调用公开的 `tryGetJson / setJson / deleteJson / listKeys / listTables`，这些接口均存在于 TT v2.2.0。不存在的记录返回 404，revision 不匹配返回 409；读盘失败和损坏数据会明确失败，不能当成空记录覆盖。

数据位置：`data_root/_tauritavern/extension-store/qqj-bainiao-v1/kv/`。table 是 namespace 与 collection 的 SHA-256，key 是 recordId 的 SHA-256，原始键保存在文件内容中并在读取时校验。中文、较长键和特殊字符不会直接作为路径使用。

每个键对应一个文件，文件内同时保存当前 envelope 与删除历史。删除、恢复和更新都只提交一次 TT `setJson`，复用 TT 的临时文件替换机制。支持读、写、列出、删除、回收站查询和恢复；回收站没有自动清理。其磁盘布局不同于原白鳥服务端，不能直接互相覆盖或迁移。

tt.2 增加 `DELETE /records/:namespace/:collection/:recordId/permanent`，供新版存储管理及已停止时间事项清理使用。校验 revision 后仅永久删除当前记录，不产生回收站副本；若该键已有旧回收站记录则原子保存这些历史，否则调用 `deleteJson` 释放整个键文件。与新版白鳥一致，此接口不清理旧回收站。普通删除与恢复语义不变。

从 tt.1 升级不修改 namespace、哈希键或 `qqj-tt-record-v1` 文件格式，不移动现有记忆；新增字段由上游 0.5.1 业务逻辑管理。保留上游列表读取的独立 120 秒超时。升级前请导出 TT 完整数据备份，更新后重启；不需要卸载或完全重构。旧摘要不会自动重跑，旧楼千事需按需补齐。

同一应用运行环境共享写入队列；如宿主提供 Web Locks 则同时使用。TT 的公开 API 没有原生 compare-and-swap，**不承诺多个应用进程、外部文件写入者、设备同步并发写入时的版本原子性**。这是单个 TT 应用内的适配。

取消/超时会阻止尚未提交的写入；已经交给原生层的写入无法撤回，可能在调用方超时后完成。发生此类异常应重新读取确认，不能盲目重试旧 revision。队列会等原生写入结束后才释放。

## 验证

- 生产构建成功；安装所需 `dist/qqj-app.js` 已编译，manifest 的 cache key 对应产物哈希。
- TT 存储适配测试覆盖本地文件持久化、旧格式读取、模拟重启、中文/长键、并发冲突、删除恢复、永久删除与旧回收站保留、写入失败、损坏数据、取消、启动等待与超时、路由选择。
- 另有一项生产 bundle 的 TT 启动测试，验证经本地存储建立聊天身份，并且不请求白鳥 HTTP 后端。
- 0.5.1 完整回归 1169 项全部通过（包含当时的 16 项 TT 存储测试和 1 项 TT 生产启动测试）；随后补充旧格式读取测试、加强 TT 启动持久化与 manifest.author 校验，相关测试另行通过。旧版 0.2.3 的已知失败不再出现在本次回归中。
- 没有 iOS 真机、真实模型 API 或用户现有长档的端到端测试。自动化测试中的原生存储接口使用临时文件替身，不等于真机验证。

## 本地开发

```sh
npm ci
npm run build
node scripts/tt-stamp.mjs
npm test
```

上游 `tests/settings-api.test.mjs` 要求本仓库同级目录有 `ST-SevenDaysCal/runtime/settings.js`（来自 atonal519/ST-SevenDaysCal），仅为测试夹具，不是使用本适配版的必装依赖。

本分叉的前端业务版本为 0.5.1，适配版本记为 tt.2。更新上游后需要重新构建、生成缓存哈希并回归验证；不要直接用原版 dist 覆盖本分叉。
