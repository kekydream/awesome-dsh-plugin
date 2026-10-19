# 发布清单（npm 与社区目录）

本文件是**发布前照着做**的清单：先把包装到 npm，再把条目提交到社区插件目录。
当前包版本见 `package.json`（`0.1.0-preview.3`）。

## 一、发布到 npm

### 发布前检查（四条）

```sh
# 1) 包名是否可用（404 = 没人占用；有版本号返回说明已被占用，需要改名）
npm view dsh-meeting-room version

# 2) 包内容是否正确 —— 必须看到 11 个 host-*.js 与 client.js（历史上曾漏掉宿主代码）
npm pack --dry-run

# 3) 自动化冒烟（含发布清单守卫：逐条核对相对引用是否被 files 覆盖）
node smoke.mjs

# 4) 登录状态
npm whoami
```

### 发布

```sh
# 版本是预发布号（-preview.N），必须显式指定 dist-tag：
# npm 不会把预发布版本推到 latest，不加 --tag 会被拒绝。
npm publish --tag preview
```

发布后：

- `npm view dsh-meeting-room dist-tags` 应显示 `preview: 0.1.0-preview.3`；
- 国内镜像（npmmirror）会自动同步，用户安装会自动走镜像；
- 想升级正式版：`npm dist-tag add dsh-meeting-room@<version> latest`。

### 关于 `engines.dsh`（已决定）

社区目录与 DSH 会读 `engines.dsh`（或同版本线 `@deepseek-ai/dsh-*` peer）来判断兼容性，
**并且会用不满足条件的版本阻止安装**。所以只在**实测过的**范围内声明。

**当前取值：`">=0.2.0"`**（本机实测运行版本 0.2.1-rc.2）。注意 `-rc` 预发布号低于同号正式版，
所以 `0.2.1-rc.2` 满足 `>=0.2.0`；而 `0.1.x` 的宿主会被这条挡住 —— 那是刻意的：
那些版本没有验证过。等你在更早的宿主上验证过，再放宽这里。

同时声明了 `engines.node: ">=20"`（代码用到 `fetch`/`FormData`/`AbortSignal.timeout`）。

### 发布包里有什么

`npm pack --dry-run` 的实际输出（31 个文件，约 213 KB）：

```
index.js  client.js  host-*.js（11 个）  speaker-worker.js  handwriting-worker.js
minutes-docx.py  scores-xlsx.py  cordis.patch.yml  locale/{zh,en}.json  icon.svg
LICENSE  README.md  CHANGELOG.md  DESIGN.md  FEATURES.md  MODELS.md
TESTING.md  THIRD-PARTY-NOTICES.md  smoke.mjs  package.json
```

模型**不在**包内（首次使用时按需下载并校验 sha256，见 `THIRD-PARTY-NOTICES.md`）。

## 二、提交到社区插件目录（dsh-market / awesome-dsh-plugin.com）

> ⚠️ **目录只认 GitHub。** 这一点是查它的代码确认的，不是惯例：
> - `scripts/probe-npm.mjs` 只从 `https://raw.githubusercontent.com/<repo>/HEAD/package.json`
>   取清单做 `dsh.bundle` 校验；
> - `scripts/publish-catalog.mjs` 的注释写明"拒绝任何非 github.com 的主机名"；
> - `scripts/build-site.mjs` 的图片来源也只允许 GitHub 自有域名。
>
> **条目里的 `url` 必须是 GitHub 仓库地址**（Gitee 地址过不了 CI）；CI 另有一条
> **仓库年龄 ≥ 1 天**的门槛。
>
> 因此建议的发布策略：**Gitee 继续作主仓库**，另外在 GitHub 建一个镜像仓库
> （如 `github.com/kekydream/dsh-meeting-room`），把同一条发布线推过去，条目指向镜像。
> 相应地，npm 包里的 `repository` 字段必须指回**被收录的那个仓库**（即 GitHub 镜像），
> 否则包与条目不会互相关联。

目录数据在 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/`，
**一个插件一个 YAML 文件**（两个 README 由脚本生成，不要手改）：

- 文件名：`data/plugins/<owner>__<repo>.yml`
- 字段：`url`（必须与仓库完全一致）、`name`（`owner/repo`）、`category`、`description.en`（必填）、`description.zh`（可选）
- 硬性要求：仓库的 `package.json` 声明 **`dsh.bundle`**（本插件有：`dsh.bundle.patch = ./cordis.patch.yml`）；
  ⚠️ 只声明 `dsh.client` 是最常见的被拒原因
- 描述里出现 `: `（冒号+空格）必须给整行加引号

本插件的条目文件内容：

```yaml
url: https://github.com/kekydream/dsh-meeting-room   # 必须是 GitHub，且与仓库完全一致
name: kekydream/dsh-meeting-room
category: voice                                      # 语音类；维护者如认为更贴切会自行改
description:
  zh: "..."
  en: "..."
```

完整草稿（含中英描述）已写好，放在 `awesome-dsh-plugin` 的 Gitee 试验副本里：
`data/plugins/kekydream__dsh-meeting-room.yml` —— 提交时把它复制进
`awesome-dsh-plugin/awesome-dsh-plugin` 的同名路径即可。

本地预览生成结果（可选）：

```sh
npm ci
node scripts/generate-readme.mjs
```

## 三、发布流程备忘

1. 功能在 `develop` 上做，`node smoke.mjs` 全绿；
2. 合入 `master`（发布线）并打标签 `v<version>`；插件仓库的 `master` 是保护分支，
   走 `release/*` 分支 + PR；
3. 打开 Gitee Release，用标签创建，粘贴 `CHANGELOG.md` 里对应版本那一段；
4. `npm publish --tag preview`（或正式版 `--tag latest`）；
5. 若这是**首次**发布：先完成上面第二节的目录条目提交。