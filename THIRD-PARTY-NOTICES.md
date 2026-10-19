# 第三方组件与模型声明

本插件（`dsh-meeting-room`）以 **MIT** 协议发布，见 [LICENSE](LICENSE)。
下面是它运行时用到、但不属于本插件的组件与模型。**这些资产各自适用其作者/发布方的条款**，
本插件只是调用或下载它们；本声明用于说明来源，便于部署方核对合规。

## 一、随插件安装的运行时依赖

| 组件 | 版本 | 协议 | 用途 |
| --- | --- | --- | --- |
| `onnxruntime-node` | 1.20.1 | MIT | 在本机执行声纹与会话识别模型（子进程 `speaker-worker.js` / `handwriting-worker.js`） |
| `pinyin-pro` | ^3.27.0 | MIT | 中文同音订正（术语表里的同音替换） |

## 二、由运行环境提供、本插件不打包的组件

| 组件 | 协议 | 说明 |
| --- | --- | --- |
| `sherpa-onnx-node`（peer，可选） | 上游 k2-fsa/sherpa-onnx 采用 Apache-2.0；**以你实际安装版本附带的 LICENSE 为准** | 语音识别后端；由 DSH 的语音能力提供 |
| React / ReactDOM | MIT | 面板与浏览器半边的界面运行时，由 DSH 客户端提供 |
| `@deepseek-ai/dsh-client-*` 系列 | 随 DeepSeek Harness 分发 | 客户端槽位、侧栏、设置等平台模块，由宿主在运行时提供 |

## 三、运行时下载的模型（不属于本插件，也不随包分发）

插件只做"下载 + 校验（大小与 sha256）+ 在本机使用"，**不再分发**这些模型；
它们的版权与使用条款归各自发布方，若将其用于对外服务或再分发，请自行核对其模型卡。

| 模型 | 来源 | 校验（插件内置） | 用途 |
| --- | --- | --- | --- |
| `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`（3D-Speaker CAM++，中英文，16 kHz） | k2-fsa/sherpa-onnx 的 GitHub Release（speaker-recongition-models） | 28,281,138 字节；sha256 `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11` | 发言人分离（声纹向量与聚类） |
| `handwriting-damo.onnx` + `vocab.txt`（DAMO 手写行识别，ConvNeXt-Tiny） | ModelScope：`iic/cv_convnextTiny_ocr-recognition-handwritten_damo` | 76,859,029 字节；sha256 `a98dddb2b4ee1bd0b358bd087ecebc242767eae6657682569fb5e87ce96ea82e` | 手写笔记的本地离线识别 |
| 语音识别模型（SenseVoice 等） | **由 DeepSeek Harness 的语音能力提供**，本插件不下载也不管理 | — | 录音转写 |

模型落盘位置：`$DSH_HOME/speech-to-text/speakers/`（声纹）与 `$DSH_HOME/handwriting/`（手写）。

## 四、说明

- 插件**不上传**音频、实录或任何会议内容；模型下载与识别都在本机完成（见 README「数据位置」）。
- 推送到钉钉/企业微信时，只有你确认过的工作安排会按你在「会议管理 → 设置」里配置的方式发出。
- 若你是部署方，需要更细的清单（含传递依赖），可用 `npm ls --all` 结合各包自带的 LICENSE 生成。
- 本声明如与实际安装的版本不一致，以**实际版本附带的 LICENSE** 为准；发现遗漏欢迎发邮件指出
  （见 README「反馈」）。