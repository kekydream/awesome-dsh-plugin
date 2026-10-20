# 发布清单（npm 与社区目录）

本文件是**发布前照着做**的清单：先把包装到 npm，再把条目提交到社区插件目录。
当前包版本见 `package.json`（`0.1.0-preview.6`，已发布）。

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

- `npm view dsh-meeting-room dist-tags` 应显示 `preview: 0.1.0-preview.6`；
- 国内镜像（npmmirror）会自动同步，用户安装会自动走镜像；
- 想升级正式版：`npm dist-tag add dsh-meeting-room@<version> latest`。

> 本机默认 registry 是 npmmirror（只读镜像，发不上去）。发布必须显式指定：
> `npm publish --registry=https://registry.npmjs.org --tag preview`，
> 否则会报权限/404 之类的误导性错误。

### 已发布状态（2026-10-21 实测：0.1.0-preview.6）

| 项 | 结果 |
| --- | --- |
| 包 | `dsh-meeting-room@0.1.0-preview.6`（维护者 `kekydream`），`npm publish --registry=https://registry.npmjs.org --tag preview` 一次成功 |
| dist-tags | `preview` 与 `latest` **都**指向 `0.1.0-preview.6`（`dist-tag add … latest` 同步升级） |
| 包体积 | 36 个文件 / 294.7 kB 打包 / 993.9 kB 解包；`shasum 78d913e2344436ed2e660180a9ce23eafadb2a63` |
| 暂存延迟 | 发布命令 0 退出并打印 `+ dsh-meeting-room@0.1.0-preview.6`，但版本 URL 约 **100 秒**内仍 404，之后转 200；dist-tag 约 20 秒生效 |
| npmmirror | 已自动同步（`registry.npmmirror.com/dsh-meeting-room/latest` = 0.1.0-preview.6），未手工触发 |
| 安装副本 | 临时目录 `npm install dsh-meeting-room@0.1.0-preview.6` 通过：**14 个 `host-*.js` + `client.js` + `index.js` + 两个 locale** 齐全 |
| 历史 | `0.1.0-preview.3`（2026-10-19）、`0.1.0-preview.4`（同日）已发布，现均被 preview.6 覆盖在 tag 上 |

### 已发布状态（2026-10-19，历史：0.1.0-preview.3）

| 项 | 结果 |
| --- | --- |
| 包 | `dsh-meeting-room@0.1.0-preview.3`（维护者 `kekydream`） |
| dist-tags | `latest` 与 `preview` **都**指向 `0.1.0-preview.3` —— 因此 `dsh plugin add dsh-meeting-room` 与 `…@preview` 都能装 |
| npmmirror | 已自动同步；实测从镜像 `npm install dsh-meeting-room` 成功（29 秒，10 个包） |
| 安装副本 | **11 个 `host-*.js` + `client.js` + `index.js` 齐全** —— 即 0.1.0-preview.1 那个"缺宿主代码"的问题在 npm 侧已被反证 |
| 清单字段 | `engines.dsh = ">=0.2.0"`、`engines.node = ">=20"`、`dsh.bundle.patch` 均在包里 |
| 遗留 | 有 `0.0.0-stage` 一个版本 —— 那是首次尝试时 npm 2FA 的**暂存占位版本**，无害；不想要可在 72 小时内 `npm unpublish dsh-meeting-room@0.0.0-stage` |

**为什么 `latest` 也指向预发布版**：首次发布时 npm 会把 `latest` 指向首个版本。这带来一个方便
（按包名直接安装即可用），代价是语义上不够严格。**建议保持现状直到第一个正式版**；
届时 `latest` 会自动移到正式版，`preview` 仍留在预发布线上。

**cnpm / npmmirror 不需要发布**：它是**只读镜像**，会从 npmjs 自动同步（本包已同步）。
要强制触发同步：`cnpm sync dsh-meeting-room`，或访问
`https://npmmirror.com/sync/dsh-meeting-room`。发布永远只发到 `registry.npmjs.org`。

### 关于 `engines.dsh`（已决定）

社区目录与 DSH 会读 `engines.dsh`（或同版本线 `@deepseek-ai/dsh-*` peer）来判断兼容性，
**并且会用不满足条件的版本阻止安装**。所以只在**实测过的**范围内声明。

**当前取值：`">=0.2.0"`**（本机实测运行版本 0.2.1-rc.2）。注意 `-rc` 预发布号低于同号正式版，
所以 `0.2.1-rc.2` 满足 `>=0.2.0`；而 `0.1.x` 的宿主会被这条挡住 —— 那是刻意的：
那些版本没有验证过。等你在更早的宿主上验证过，再放宽这里。

同时声明了 `engines.node: ">=20"`（代码用到 `fetch`/`FormData`/`AbortSignal.timeout`）。

### 发布包里有什么

`npm pack --dry-run` 的实际输出（36 个文件，约 295 KB）：

```
index.js  client.js  host-*.js（14 个）  speaker-worker.js  handwriting-worker.js
skill-meeting-scribe.js  minutes-docx.py  scores-xlsx.py  cordis.patch.yml
locale/{zh,en}.json  icon.svg  package.json
LICENSE  README.md  CHANGELOG.md  DESIGN.md  FEATURES.md  MODELS.md
TESTING.md  THIRD-PARTY-NOTICES.md  PUBLISHING.md  smoke.mjs
```

`__pycache__/` 与 `tools/`（开发用脚本）被 `files` 白名单挡在包外，属预期。

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

### 镜像怎么保持同步（本机连不上 github.com）

实测：本机 **`github.com` 不通**（8 秒超时），但 **`raw.githubusercontent.com` 通**
（HTTP 200，目录 CI 读的正是它）。所以：

- **本地不推 GitHub**，改由 **GitHub 侧拉 Gitee**：镜像仓库里放
  `.github/workflows/mirror-from-gitee.yml`（本仓库已带此文件），
  它每天用 `GITHUB_TOKEN` 把 `master` / `develop` / 标签从 Gitee 同步过去，
  不需要任何自定义 secret（Gitee 仓库是公开的）；
- 镜像仓库请把**默认分支设为 `master`** —— 目录 CI 读的是 `HEAD`
  （即默认分支）的 `package.json`；
- 工作流只推 `refs/heads/*` 与 `refs/tags/*`，**不用 `--mirror`**：否则会把镜像侧
  独有的分支（含工作流所在的分支）一并删掉。

### 发布被 npm 暂存时的现象

账号开启 2FA 时，npm 会把发布**暂存**再异步处理：命令会返回成功
（`+ dsh-meeting-room@<version>`），但紧接着查 `dist-tags` / `versions` 还看不到新版本，
并提示 *"This change is being processed and may take a few minutes to take effect"*。
**等几分钟再查即可**，不要重复发布（重复发布会报版本已存在）。
首次那个 `0.0.0-stage` 版本就是这类暂存过程的产物。

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