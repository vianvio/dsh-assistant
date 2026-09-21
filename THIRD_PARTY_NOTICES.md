# 第三方组件、素材与致谢

本项目自身以 MIT 许可发布（见 [`LICENSE`](LICENSE)）。以下是随包分发或依赖的第三方内容。

## 角色素材 · [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume)

> MIT License · Copyright © 2026 **Sutera-Diffusus**

`assets/pack/` 与 `runtime/bin/**/Contents/Resources/` 中的角色素材取自该仓库
（它的定位是 DeepSeek Harness 桌宠插件，"元气鲸鱼娘"）。

本仓库中的素材是**加工后的产物**：统一缩放到固定高度、按显示尺寸烘焙为 WebP；
其中一部分（`*-motion` 序列帧）由作者使用阿里云百炼的图生视频模型生成中间帧后，
再经抠像、底边对齐、插值处理而来。

**加工不改变上游的许可与署名要求** —— 角色形象版权仍归原作者。
换成自己的角色：把图丢进一个目录，改 `scripts/build_pack.py` 顶部的
`STATE_ASSETS` / `ACTION_ASSETS`，重跑 `npm run build:pack`（宿主与原生端都不用改）。

## 原生悬浮窗骨架 · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu)

> MIT License · Copyright © 2026 **QCYTSN**

本项目"原生透明面板 + stdio JSON 协议 + 会话事件归约"的架构参考了它 ——
这条路线是那个仓库用生产代码先跑通的。本仓库**未复制其代码或素材**，
只沿用架构思路，并做了四处加固（帧内存、可访问性、僵尸进程、布局路径，详见 README）。

## 运行时依赖

项目**不打包** Node 依赖；运行期的 `@deepseek-ai/*` 由 DSH 自身提供。

素材管线脚本（`scripts/*.py`）需要自行安装：Pillow；动图生成还需要 ffmpeg 与
阿里云百炼的 `DASHSCOPE_API_KEY`（只从环境变量读取，不落盘）。
