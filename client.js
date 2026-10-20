/**
 * Browser half of the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Loaded through the client module table, so it must be a lazy CommonJS factory and
 * may `require` only the shared platform modules.
 *
 * M1: the recording panel lives in the session's right sidebar, opened from a button in
 * the session header. The session id arrives as a slot prop and travels to the host half
 * with the recording, which is what lets `meeting_read` answer for the right meeting.
 *
 * Capture: microphone → inline AudioWorklet → 16 kHz mono PCM16 → cues endpointed at
 * pauses → same-origin HTTP → local SenseVoice. The terminology list fixes what the
 * local model reliably gets wrong, and composes a correction request for the agent.
 */
window.__ModuleLoader__.load({
  id: 'dsh-meeting-room',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Platform UI primitives. The shared Input is the field the built-in model picker
     * searches with, so it is the one that behaves under an IME; every control here falls
     * back to the plugin's own markup if the module (or one of its members) is absent.
     */
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }

    /** Locale namespace owned by this plugin. */
    const NS = 'meetingRoom'

    /** Tab implementation identity; the body and title register under it. */
    const TAB_ID = 'dsh-meeting-room'

    /** Tab type discriminator used by `sidebarRight.openTab`. */
    const TAB_KIND = 'meeting-room'

    /** Route prefix owned by the host half. */
    const PREFIX = '/meeting-room'

    /** Who to write to about a problem or an idea; the About dialog offers the address. */
    const ABOUT_EMAIL = 'yangdaoquan@qq.com'
    const ABOUT_AUTHOR = '杨道泉'

    /**
     * A meeting the management page asked the panel to show, handed over through this
     * one-slot register: the page switches the conversation first, and the panel that then
     * mounts next to it reads the slot and opens the meeting it names.
     */
    const pendingMeeting = { current: null }

    /** How many times the shell refused to open the right panel; used to log the reason once. */
    let panelOpenFailures = 0

    /** Main-panel key and left-sidebar row id; the row id addresses this page. */
    const PANEL_ID = 'meeting-room'

    /** Browser-storage key holding the terminology list between meetings. */
    const TERMS_KEY = 'dsh-meeting-room.terms'

    /** Target sample rate for the speech provider. */
    const TARGET_RATE = 16000

    /**
     * Cue shaping: the defaults, replaced at runtime by the settings the host reports (a longer
     * cue means fewer requests, a shorter silence hold means a snappier transcript).
     */
    const CUES = { minSeconds: 1.2, maxSeconds: 12, silenceRms: 0.012, silenceHoldSeconds: 0.7 }

    /** Shortest audio a cue may hold; below this a pause is not treated as an endpoint. */
    const MIN_CHUNK_SECONDS = 1.2

    /**
     * Hard ceiling per request; a speaker who never pauses still gets periodic cues. The
     * recognizer is request/response, so this ceiling — not a partial hypothesis — is what
     * decides how live the transcript feels during a long uninterrupted sentence.
     */
    const MAX_CHUNK_SECONDS = 12

    /**
     * Adopt the cue settings the host reports. The capture loop reads CUES on every block, so
     * this takes effect on the next block rather than on the next meeting.
     * @param stored - the transcript settings from the host.
     */
    function applyCueSettings(stored) {
      if (stored === null || typeof stored !== "object") return
      const numbers = {
        minSeconds: Number(stored.minChunkSeconds),
        maxSeconds: Number(stored.maxChunkSeconds),
        silenceRms: Number(stored.silenceRms),
        silenceHoldSeconds: Number(stored.silenceHoldSeconds),
      }
      for (const [key, value] of Object.entries(numbers)) {
        if (Number.isFinite(value) && value > 0) CUES[key] = value
      }
      // Order matters: a minimum above the maximum would make every cue the maximum.
      if (CUES.minSeconds > CUES.maxSeconds) CUES.maxSeconds = CUES.minSeconds
    }

    /** Block RMS under which the microphone hears room noise rather than speech. */
    const SILENCE_RMS = 0.012

    /** Silence that must accumulate before a cue is closed. */
    const SILENCE_HOLD_SECONDS = 0.7

    /**
     * Worklet source, installed from a Blob URL so the client bundle needs no asset.
     * It accumulates render quanta and posts ~128 ms blocks to keep messaging cheap.
     */
    const WORKLET_SOURCE = `
class MeetingCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i]
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}
registerProcessor('meeting-capture', MeetingCapture)
`

    const zh = {
      title: '会议记录',
      guideTitle: '开始会议',
      guideDescription: '立即录音，会议助手自动整理',
      guideOpening: '正在打开会议…',
      open: '会议记录',
      start: '开始记录',
      stop: '停止记录',
      idle: '未开始',
      starting: '正在启动麦克风…',
      transcribing: '识别中…',
      elapsed: '已记录',
      empty: '还没有内容。开始后对着麦克风说话。',
      terms: '会议术语（人名 / 公司 / 项目 / 专业词）',
      termsHint: '每行一条，三种写法：① 错词=正确词 → 直接替换，例如 romi中心=罗米中心；② 只写一个词 → 同音订正，例如 陈一鸣（听到 沉一明 也会改成它）；③ 前面加 * → 连单字也按同音订正，例如 *李（单字容易误替换，只在对某个姓氏有把握时用）。订正不改动原始转写，鼠标停在句子上可看原文。',
      exportFile: '保存为文件',
      copySrt: '复制 SRT',
      copy: '复制全文',
      copyForFix: '复制纠错请求',
      copied: '已复制',
      error: '出错',
      hubTitle: '会议管理',
      hubIntro: '会议实录保存在本机；录制在会话里进行（标题栏的「会议记录」按钮 → 右侧栏面板）。',
      hubCurrent: '当前会话',
      hubNoSession: '还没有打开的会话。',
      hubSessionOpen: '会话已在前台 —— 点标题栏的「会议记录」开始录制。',
      hubSessionBackground: '当前会话不在前台 —— 切回会话后即可开始录制。',
      hubHowTo: '录制在会话作用域进行：它需要会话身份，才能让 Agent 用 meeting_read 读到这场实录。',
      hubRecords: '会议记录（每场会议一条）',
      hubRefresh: '刷新',
        hubLoadMore: '加载更早的会议',
      hubEmpty: '还没有会议记录。开一场会后就会出现在这里。',
        hubFilterEmpty: '这个类型下还没有会议。',
        hubAll: '全部',
        hubGroupBy: '分组',
        hubGroupDay: '按天',
        hubGroupWeek: '按周',
        hubGroupMonth: '按月',
        hubTasksDone: '已完成',
      hubSend: '发送到新对话',
      hubSendHint: '新建一个对话，把这场会议的实录放进去，确认后发送',
      hubOpenSession: '打开会议',
      hubOpenMeetingHint: '切换到这场会议的对话，并在右侧打开它的会议记录',
      hubOpeningMeeting: '正在打开这场会议',
      pushNow: '一键同步到钉钉/企业微信',
      pushNowHint: '按「会议管理 → 设置」里选择的推送方式，发送已确认的工作安排（查看历史会议时发送的是该会议的）',
      pushOne: '发送这条',
      pushOneHint: '只发送这一条已确认的工作安排',
      pushOneNeedsConfirm: '这条还没有确认：勾选后才能发送',
      pushed: '已推送',
      packageSaving: '正在打包这场会议',
      packageSaved: '已保存到文件',
      packageFailed: '打包失败',
      hubImport: '导入会议',
      hubImportHint: '选择之前导出的会议压缩包（.zip），把它导入本机',
      hubImported: '已导入会议',
      about: '关于',
      aboutName: 'dsh-meeting-room · 会议记录（DeepSeek Harness 插件）',
      aboutVersion: '版本',
      aboutAuthor: '作者',
      aboutLab: '博尔塔拉融媒体中心媒体传播与认知重点实验室',
      aboutLicense: '许可',
      aboutFeedback: '这是预览版，正需要你的意见：使用时发现 bug、觉得哪里别扭、或者有想加的功能，都请直接发邮件告诉我。信里附上版本号、DSH 版本、操作步骤与报错文字（有截图更好），我会跟着改。',
      aboutMail: '发邮件',
      pushNothingConfigured: '没有可推送的目标：请先在「会议管理 → 设置」里配置群机器人或工作通知',
      hubOpenPanelManual: '已切到该对话；右侧面板未能自动打开，请点会话右上角的会议按钮',
      hubNoMeeting: '这条记录没有对应的会议',
      hubNoWorkspace: '当前界面不支持新建对话',
      hubClose: '关闭',
      speaker: '发言人',
      speakerEnable: '准备发言人识别',
      speakerDownloading: '正在下载声纹模型…',
      speakerReady: '发言人识别已启用',
      speakerFailed: '发言人识别不可用',
      speakerOff: '发言人识别未启用（准备约需下载 27 MB）',
      points: '要点',
      tasks: '工作安排',
      point_decision: '决定',
      point_point: '要点',
      point_risk: '风险',
      point_question: '待定',
      taskDraft: '待确认',
      taskConfirmed: '已确认',
      noAnalysis: '还没有要点或工作安排。点上面的「本地提取」按规则生成草稿，或在会话里让 Agent 精修。',
      pointsNoRecording: '本场还没有实录。点上方「开始记录」，也可以在下面直接写一条要点。',
      tasksNoRecording: '本场还没有实录。点上方「开始记录」，也可以在下面直接写一条工作安排。',
      tasksEmpty: '还没有工作安排。可以直接添加，或让 Agent 依据实录写进本会；勾选表示人已确认，确认后才能推送。',
      addEntry: '添加',
      entryAdded: '已添加',
      taskTextRequired: '请先写工作安排的内容',
      originManual: '手填',
      kindGeneral: '通用',
        kindAdhoc: '临时会议',
      kindBriefing: '晨会',
      kindReview: '复盘会',
      kindWeekly: '例会',
      kindMonthly: '总结会',
      meetingNameTitle: '这场会议叫什么？',
      kindLabel: '会议类型',
      roleOtherPlaceholder: '其他角色…',
      panelTabMinutes: '会议纪要',
      followNewest: '跟随最新',
      jumpToNewest: '回到最新',
      mergeHint: '勾选多条实录可合并为一个任务',
      mergeSelected: '已选',
      mergeToTask: '合并为任务',
      clearSelection: '清除选择',
      selectCue: '选中这条实录',
      mergeStored: '已合并为一个任务草稿',
      minutesTabEmpty: '还没有纪要。点「生成纪要」让 Agent 依据实录写一份。',
      needTranscript: '需要先有一段实录',
      historyGuardDiscard: '不保存并打开',
      meetingNameHint: '选一个常用名称，或自己写一个；名称会显示在面板、实录抬头与纪要里。',
      meetingNamePlaceholder: '会议名称，如「晨会 · 10月18日」',
        meetingTitleHint: '改完点别处即保存；类型决定周期归属与一键提炼模板',
        seriesPrev: '上一场',
        seriesNext: '下一场',
        seriesNone: '本类型没有更早/更晚的会议',
      meetingNameSkip: '留空并开始（稍后自动命名）',
      meetingNameAutoHint: '标题可以留空：开始记录后，头 5 分钟的内容会自动起一个标题，之后也能在面板里改。',
      meetingNameNone: '（未命名）',
      periodNone: '（无周期）',
      panelTabScores: '评分',
      scoresPrefill: '统计预填',
      scoresExportCsv: '导出 CSV',
      scoresExportXlsx: '导出 Excel',
      scoresHint: '完成率可按本月任务统计预填；质量与学习由人打分（1–10）。勾选＝已确认（需先填依据）。总分按「会议管理 → 设置 → 评分权重」计算，默认质量 40% ＋ 完成率 40% ＋ 学习 20%。',
        scoreBasisPlaceholder: '依据：实录原文或任务 id（多条用；分隔）',
        scoreBasisRequired: '先填一条依据（实录原文或任务 id）才能确认',
        scoreBasisMissing: '缺依据',
      scoresAddPerson: '添加人员',
      scoreHours: '课时',
      scoreCompletion: '完成率 %',
      scoreQuality: '工作质量 1–10',
        scoreWeightTitle: '评分权重',
        scoreWeightHint: '月度总结会的总分按这三项加权：质量（1–10 换算百分制）、完成率（百分制）、学习（1–10 换算百分制）。三项之和须为 100%，保存后对已有评分同样生效。',
        scoreWeightSum: '合计',
        scoreWeightSave: '保存权重',
        scoreWeightSaved: '权重已保存，之后重算的总分都按它算',
        templateTitle: '一键提炼模板',
        templateHint: '每种会议的一键提炼发给 Agent 的原文；留空使用内置文案。可用 {meetingId}、{title}、{period} 占位。',
        templateSave: '保存模板',
        templateSaved: '模板已保存',
      scoreLearn: '学习参与 1–10',
      scoreTotal: '总分',
        scorePerson: '姓名',
        scoreTotalAuto: '留空=按权重自动算',
        scoreTotalManual: '已手改；清空回到自动',
      scoreHighlight: '亮点',
      scoreImprove: '待改进',
      scoreBasis: '依据',
      scoresExported: '已导出',
      needPerson: '请先填写人员姓名',
      carryOverHint: '昨日复盘遗留',
      carryOverAction: '据此派活',
      carryOverOpen: '看复盘会',
      pauseRecording: '暂停',
      resumeRecording: '继续',
      pausedStatus: '已暂停 · 已录',
      pauseLongHint: '仍在暂停（已超过 10 分钟）',
      carryOverPrompt: '昨天复盘会留下了 {count} 项未完成/遗留事项：\n{list}\n\n请在本次晨会实录里对照这些事项，决定今天派给谁、什么时候完成，并用 meeting_write 把结果写成本会 tasks（草稿，等人确认）。只依据实录与上面的清单，不要编造。',
        distillBriefing: '一键提炼部署',
        distillBriefingPrompt: '请整理这场晨会（{title}，{period}，meetingId={meetingId}）的部署安排：先用 meeting_read 读取本场实录，再用 meeting_write 把要点与工作写进这场会议（people 不填，tasks 的 owner/due 按实录写清）。只依据实录，不要编造。完成后在对话里用三句话说明今天谁做什么。',
        distillReview: '一键复盘',
        distillReviewPrompt: '请复盘这场会议（{title}，{period}，meetingId={meetingId}）：先用 meeting_read 读取实录，提炼结论、风险、待办与未决问题，再用 meeting_write 把要点与工作写进这场会议（tasks 到人到时间）。只依据实录；聊天里给出三条最重要的结论。',
        distillWeekly: '一键整理本周',
        distillWeeklyPrompt: '请整理这场例会（{title}，{period}，meetingId={meetingId}）：先用 meeting_query 取本周（period="this-week"）的晨会与复盘会，再结合本场实录，用 meeting_write 把本周进展、风险与下周计划写成要点和任务（写回 meetingId={meetingId}）。只依据记录，不要编造；聊天里给出本周三条结论。',
        distillMonthly: '一键生成评分',
        distillMonthlyPrompt: '请为这场月度总结会（{title}，{period}，meetingId={meetingId}）生成评分建议：先用 meeting_query 取本月（period="this-month"）的会议与任务完成情况，按人给出完成率、质量、学习三项建议分数，每一项都带依据（实录原文或任务 id），再用 meeting_write 写入这场会议的 scores（草稿，等人确认）。没有依据就不打分，并在回复里说明缺什么。',
        extractNow: '本地提取',
        extractDone: '已提取',
      historyPlaceholder: '搜索历史会议（名称 / 日期 / 类型 / 实录关键词）',
      historyOpen: '打开会议',
      historyLoading: '正在读取…',
      historyEmpty: '没有匹配的会议',
      historyBlank: '空',
      historyChoose: '打开',
      historyViewing: '正在查看历史会议',
      historyOpenSession: '打开原会话',
      historyBack: '返回本会话',
      historyViewOnly: '历史会议的内容不可修改：勾选「已确认」可以（只改确认状态，用于发送），其它请先「返回本会话」',
      historyGuardTitle: '当前会议有未保存内容',
      historyGuardBody: '3 秒后自动保存，然后打开所选会议；也可以立即保存或取消。',
      historyGuardNow: '立即保存并打开',
      historyAll: '已全部显示',
      historyMore: '滚动加载更多…',
      extractEmpty: '没有识别出明显的要点或行动项。可在会话里直接对 Agent 说「读一下这场会议，给我要点和行动项」来精修。',
      noMeeting: '这个会话还没有会议记录。点「开始记录」录一场，再来整理要点与工作安排。',
      seekHint: '点击跳到这一句',
      agentDone: '已更新',
      follow: '跟随播放',
      hubNoText: '这段录音没有对应的文字实录。',
      segments: '句',
      remove: '删除',
      ownerPh: '负责人',
      duePh: '时间',
      originRule: '规则',
      originAgent: 'Agent',
      ink: '手写笔记',
      inkHint: '用笔或鼠标在下面书写；Windows 触屏笔的橡皮端会被识别为橡皮。',
      inkPen: '笔',
      inkErase: '橡皮',
      inkUndo: '撤销',
      inkClear: '清空',
      inkSave: '保存为笔记',
      inkSaved: '笔记已保存',
      inkLocal: '识别为文字',
      inkLocalEmpty: '没有识别出文字，写大一点再试',
      inkLasso: '圈选',
      clearEntry: '清除',
      inkLassoHint: '轻点一个字即可选中；长按画布可直接开始圈选',
      inkSelection: '识别选中',
      inkToTask: '转为任务',
      inkToTaskDone: '已转为待确认任务',
        taskMarkDone: '标记为已完成（核销）',
        taskDoneAt: '完成于',
      needSession: '这需要一个会话：请先在某个对话里打开会议记录面板',
      roleLabel: '我的角色',
      speakingNow: '正在说',
      roleHost: '主持人',
      roleAttendee: '参会人',
      roleObserver: '旁听',
      roleHint: '复盘时会按这个角色组织内容',
      review: '复盘会议',
      pushDone: '已推送到机器人',
      robotSettings: '设置',
      settingsTabs: '设置分类',
      settingsTabPush: '推送与机器人',
      settingsTabCloud: '云端识别',
      settingsTabTranscript: '实录与切句',
      settingsTabSpeaker: '发言人识别',
      settingsTabWeights: '评分权重',
      settingsTabTemplates: '提炼模板',
      robotHint: '填入钉钉 / 企业微信机器人的 Webhook 地址，留空表示不推送；只推送【已确认】的任务。地址保存在本机。',
      robotSave: '保存地址',
      robotSaved: '已保存',
      robotNone: '未配置',
      more: '更多',
      robotAppHint: '私发（工作通知）与通讯录同步都需要钉钉企业内部应用：AppKey / AppSecret / AgentId，且应用已开通对应权限。',
      pushMode: '推送方式',
      pushModeGroup: '群机器人',
      pushModeWork: '工作通知',
      pushModeBoth: '两者都发',
      peopleTitle: '人员（姓名 / 手机号 / 钉钉UserId）',
      peopleHint: '手机号用于群机器人 @人；UserId 用于私发工作通知。任务负责人按姓名匹配这里的人。名册是全机共享的。',
      phonePh: '手机号',
      userIdPh: 'UserId',
      peopleUnit: '人',
      hubTabRecords: '会议记录',
      hubTabModels: '模型',
      modelsHint: '这里决定识别用哪些模型：装好、校验通过（大小与 sha256 都对）才能启用。默认不出本机；换模型只影响之后的识别，不改动已有会议的文字。',
      modelInstall: '下载并安装',
      modelRetry: '重新下载',
      modelInstalled: '已安装',
      modelImportFile: '从本地文件导入',
      modelImportHint: '选这个模型的模型文件（离线机房、内网镜像、或你自己训练的模型都可以）；文件与目录记录对不上时会被拒绝',
      modelImported: '已导入',
      modelActivate: '启用这个',
      modelActivated: '已切换',
      modelRemove: '删除',
      modelRemoved: '已删除文件数',
      modelDownloading: '正在下载',
      modelLicence: '许可',
      modelDirectory: '模型目录',
      modelStateReady: '已装好',
      modelStateMissing: '未安装',
      modelStateBad: '校验不通过',
      modelByDsh: '由 DSH 提供',
      modelInUse: '正在使用',
      cloudTitle: '云端识别（默认关闭）',
      cloudHint: '打开后，录音会发给下面这个地址做识别；不打开则一律在本机识别，插件不会对外发起任何请求。发送时只带当前这一段音频（不是整场录音），并在请求里声明不保留。密钥只存在本机设置里：不显示、不进日志，也不进会议工程包。',
      cloudConsent: '我同意把音频发到下面这个地址做识别',
      cloudProvider: '服务类型',
      cloudOff: '关闭',
      cloudOpenAi: 'OpenAI 兼容（/audio/transcriptions）',
      cloudCustom: '自定义',
      cloudWhere: '音频将发往',
      cloudRetention: '声明不保留',
      cloudNowhere: '还没有填写地址',
      cloudSave: '保存云端设置',
      cloudSaved: '已保存',
      cloudTest: '测试连接',
      cloudOk: '已连通',
      cloudFailed: '未连通',
      cloudFallback: '已回退到本机识别',
      cloudUsed: '这一段由云端识别',
      speakerTitle: '发言人识别',
      transcriptTitle: '实录书写与切句',
      transcriptNormalize: '把数字、日期、时间写成平时写的样子',
      transcriptNormalizeHint: '例如「二零二六年十月十九号」→「2026年10月19日」、「百分之三十」→「30%」、「三点半」→「3点半」。这是本机规则、不联网；原文仍保留在实录里，可随时对照。',
      transcriptMinCue: '最短一段（秒）',
      transcriptMaxCue: '最长一段（秒）',
      transcriptMaxLine: '每行最多多少字',
      transcriptSilenceHold: '停顿多久算说完（秒）',
      transcriptSilenceRms: '静音判定阈值',
      transcriptCueHint: '录音在浏览器里切段：停顿超过「停顿多久算说完」就结束一段，最短一段之内的停顿不算切点。最长一段越小，文字上屏越快、请求越多；越大则相反。识别出的长句会按标点拆成「每行最多多少字」的行，语速快时特别有用。',
      transcriptRules: '启用的规整规则',
      transcriptSave: '保存实录设置',
      speakerThreshold: '聚类的严格程度',
      speakerFullRelabel: '结束录音时全量重判所有实录（推荐）',
      speakerSettingsHint: '人多时把阈值调高（更严格：宁可多分几个声音，也不把两个人合成一个）；人少、或同一个人语气变化大时调低。全量重判替换了旧的「只补最后 60 条」，长会议的标签不容易断裂。改了阈值需要重新准备一次语音识别（识别进程会自动重启）。',
      speakerRestarted: '已保存；识别进程已重启，新阈值在下次准备时生效',
      speakerSave: '保存发言人设置',
      voiceLibrary: '声纹库（只存向量，不存音频）',
      voiceLibraryEmpty: '声纹库还是空的：在「发言人姓名」里给某个声音填上真实姓名，它就会被记下来；之后同一场或别的会议再听到这个人，会给出建议。',
      voiceLibraryFile: '声纹库文件',
      voiceForget: '忘记',
      voiceClear: '清空声纹库',
      hubTabTerms: '会议术语',
      autoRecordStarted: '已收到开始记录请求：录音已开启',
      stopFinishing: '正在收尾：等待最后几段识别完成…',
      stopRemaining: '剩余',
      stopElapsed: '已等待',
      stopFinished: '收尾完成，会议已保存',
      hubLastTopic: '上次会议',
      hubTabSettings: '设置',
      hubTabPeople: '人员管理',
      panelTabTranscript: '会议实录',
      panelTabSpeakers: '发言人',
      secretKept: 'AppSecret（已保存，留空不变）',
      readDepartments: '读取部门',
      allOrganization: '全部组织',
      syncFromDingtalk: '从钉钉同步',
      peopleSynced: '同步完成',
      peopleAdded: '新增',
      hubWorking: '处理中…',
      editEntry: '修改',
      saveEntry: '保存',
      cancelEntry: '取消',
      taskTitlePh: '事项',
      dueUnset: '未定',
      dueToday: '今天 18:00',
      dueTomorrowMorning: '明天 09:00',
      dueTomorrow: '明天 18:00',
      dueFriday: '本周五 18:00',
      dueMonday: '下周一 09:00',
      dueMonthEnd: '本月底 18:00',
      dueCustom: '自定义…',
      pointTextPh: '要点内容',
      pointTextRequired: '要点内容不能为空',
      priorityHigh: '高',
      priorityNormal: '普通',
      priorityLow: '低',
      speakerNames: '发言人姓名',
      voiceSuggestions: '声纹库认出的名字（要你确认才写入）',
      voiceSoundsLike: '听起来像',
      voiceAccept: '采用这个名字',
      openNames: '填写姓名',
      speakerNameHint: '给识别到的发言人填上真实姓名；标签不变，会终重聚类后姓名会跟着声音走。留空则显示 S1、S2。',
      speakerNamePlaceholder: '姓名',
      speakerNamesEmpty: '本场还没有识别到发言人。说话停顿后会自动标上 S1、S2…；若整场都没标上，点「重新识别发言人」从录音里补。',
      speakerRelabel: '重新识别发言人',
      speakerRelabeling: '正在重新识别…',
      speakerRelabelDone: '发言人已重新识别',
      reviewSending: '已把实录发给对话，Agent 正在复盘',
      reviewNoSession: '复盘需要登录并打开一个对话',
      reviewPrompt: '以下是一场会议的完整实录（本机语音识别，可能含错字）。请以「{role}」的身份复盘这场会议，并输出一份可直接存档的 Markdown 文档。\n\n【角色关注点】{focus}\n\n【输出要求】\n1. 只依据实录内容，不要编造未出现的信息；\n2. 人名、术语若可能有识别错误，请保守处理并标注不确定；\n3. 结构：# 会议复盘（{role}视角）→ 会议概要 → 关键结论 → {section} → 待确认信息；\n4. 能执行的信息要具体到人和时间。\n5. 写完正文后，调用 meeting_save_document 把这份文档存进本场会议（kind=review，title=会议复盘（{role}视角），markdown=完整正文），这样用户可以随时在会议面板里打开。\n\n【会议实录】\n{transcript}',
      roleHostFocus: '会议目标是否达成；每个议题推进到哪一步；形成了哪些明确决议；谁承诺了什么、什么时候交付；哪些事项悬而未决、卡在谁那里；下次会议应先解决什么。',
      roleAttendeeFocus: '我需要为什么负责、什么时候交付；别人对我提出了什么要求；关键决议如何影响我的工作；我必须跟进或确认什么；我可能漏听或误解了什么。',
      roleObserverFocus: '会议的整体脉络与推进逻辑；达成了哪些关键结论；各方的主要立场与分歧；有哪些值得记录的信息。',
      roleHostSection: '决议与未决事项',
      roleAttendeeSection: '我的行动项',
      roleObserverSection: '关键信息',
      minutes: '生成纪要',
      minutesDocx: '导出 Word',
      minutesDocxDone: 'Word 已写入导出目录',
      revisePrompt: '本场会议已经结束。请先调用 meeting_read 读取这场会议的完整实录（每段都带 #编号），再以会议上下文为依据做一次统一订正：同一个人名/公司名/术语前后一致；明显听错的同音词改成正确写法；明显的错字修正。然后用 meeting_revise 提交订正，corrections 每一项写 {id, text}——id 用实录里的 #编号，text 给该段订正后的完整文本。只订正上下文能支撑的地方，不要编造内容，拿不准的保持原样。完成后用一段话说明改了哪些地方。',
      minutesDone: '纪要已写入导出目录',
      minutesEmpty: '这场会议还没有内容可以成文',
      tabTerms: '会议术语',
      notesToggle: '手写笔记',
      helpToggle: '使用说明',
      helpBody: '【开始与命名】\n· 点「开始记录」先弹出「这场会议叫什么？」：填会议名称、选我的角色（主持人／参会人／旁听三个按钮，或在右侧「其他角色」里自己写）、选会议类型（通用／晨会／复盘会／例会／总结会）。选类型会**自动把标题填成「类型 · 今天日期」**，也可以自己改；不想命名就点「留空并开始（稍后自动命名）」：标题可以留空，开始后头 5 分钟的内容会自动起一个标题，之后仍可在面板里改。\n· 一个会话对应一场会议；分支出来的会话各自独立，子代理与团队共享同一场会议。\n· 语音识别与声纹模型按需下载，面板会显示进度；点开始后若模型未就绪，会先准备再自动开录。\n\n【录制】\n· 「开始记录／停止」控制整场；「暂停／继续」用于中场休息，暂停期间不采集、时间轴保持连续，暂停超过 10 分钟会提醒一次（不会自动停止）。\n· 状态行显示已录时长与当前发言人；所有按钮都在面板最上面这一排。\n\n【会议实录】\n· 自动跟随最新发言；你往上滚就自动取消跟随，并出现「回到最新」可以一键跳回。\n· 勾选多条实录 → 「合并为任务」：几句话讲的一件事合成一个任务草稿。\n· 点某条实录跳到那句录音播放；每条右侧「转为任务」把这一句变成任务。\n· 「更多」里可复制 SRT、复制纯文本、复制给模型订正的请求。\n\n【会议纪要】\n· 「生成纪要」出 Markdown，「导出 Word」出 .docx；两者都会弹出浏览器的下载保存对话框，纪要同时留在会议里可随时打开。\n· 「更多 → 会议术语」：每行一条，写成「错词=正确词」可在转写里自动替换，只写词则作为热词；边打字边保存。\n\n【要点与任务】\n· 两个页签都能直接增、改、删；任务是草稿，勾选后才算确认；任务可填负责人、时限、优先级。负责人与发言人姓名都从「会议管理 → 人员」的名册（含从钉钉同步过来的人）里取候选。\n· 想让模型来写，就在对话里说一句，例如「读一下本场会议实录，把要点和任务写进会议」——Agent 会用 meeting_write 落库。\n· 工作安排页签的「一键同步到钉钉/企业微信」按「会议管理 → 设置」里选的推送方式（群机器人／工作通知／两者）把**已确认**的任务发出去；没有配置目标时会告诉你原因；每条工作安排右侧还有「发送这条」，可以只发其中一条。\n\n【发言人】\n· 每个声纹标签直接填姓名：可以自己输入，也可以从名册下拉里选（输入即过滤）。\n· 「重新识别发言人」会从录音重新判断，用于识别当时模型还没就绪、或长会议只补标了后段的情况；结束录音时的补标默认已覆盖整场实录（可在「会议管理 → 设置」里改回按上限补）。\n· 给某个声音填上真实姓名，它会被记进声纹库（只存向量、不存音频）；别的会议再听到这个人，会给出「听起来像 X」的建议，**要你点「采用」才会写入**。阈值（人多/默认/人少）与声纹库的忘记/清空也在「设置」页。\n\n【评分（月度总结会）】\n· 只有类型是「总结会」时才出现评分页签：可从本月统计预填完成率，再逐人打分（课时／完成率／工作质量／学习参与）、写亮点与待改进、附依据。\n· 可导出 CSV 与 Excel；分数在人工确认前是草稿。\n\n【手写笔记】\n· 手写板：笔／橡皮／撤销／清空；轻点自动发现的一个字即可选中，长按约 0.6 秒可直接开始圈选。\n· 「识别为文字」用本机模型离线识别（约 43 毫秒一行），识别后可「转为任务」；「保存为图片」把整页存进会议记录。\n· 不录音也能写笔记、识别与转任务，第一次写入会自动建好这场会议。\n\n【打开会议与历史会议】\n· 动作行的「打开会议」是一个带搜索的下拉：按名称／日期／类型／实录关键词即时过滤，滚动到底自动加载更多，点名称或整行即可打开。\n· 查看历史会议时内容只读（历史内容不会被改动），可「打开原会话」或「返回本会话」；其中工作安排的「已确认」勾选是允许的 —— 那是发送它的前提，且只会写入该场会议。\n· 切换前若当前会议有内容：3 秒倒计时后自动保存再打开，也可选「立即保存并打开」或「不保存并打开」。\n\n【保存为文件 · 导入 · 关于】\n· 「更多 → 保存为文件」把这场会议打成**一个 zip 工程包**：会议记录、录音、以及纪要/图片等产出都在里面；右下角会显示进度提示（打包中 → 百分比 → 已保存到文件）。\n· 「会议管理 → 记录 → 导入会议」选择这样的 zip，就能把它导入本机（导入为新会议，不覆盖已有记录、不挂在任何会话上，重名文件自动改名），因此可以把一场会议带到另一台 DSH 上打开。\n· 「更多 → 关于」显示本机实际安装的**版本号**、作者与邮箱；发现 bug 或想提改进意见，点「发邮件」直接写给我，附上版本号与操作步骤即可。\n\n【会议管理（左侧栏）】\n· 记录：一场会议一条，显示时间、名称、类型与各项条数、摘要；「刷新」重新读取，「导入会议」导入工程包；点名称可在下方回看实录与播放。\n· 设置：群机器人 Webhook、钉钉应用（appKey／appSecret／agentId）与推送方式 —— 工作安排的「一键同步」就按这里的选择发送。\n· 人员：共享名单（姓名／手机／用户 ID），可手工维护，也可从钉钉通讯录同步部门；这份名单同时是任务负责人与发言人姓名的候选来源。\n· 术语：与「更多 → 会议术语」同一份内容。\n· 模型：识别用哪个模型在这里选 —— 内置的声纹与手写模型、以及从本地文件导入的更强模型；装好并通过大小与 sha256 校验才能启用，启用后只影响之后的识别。\n\n【数据都在本机】\n· 录音、实录、要点、任务、纪要、评分与笔记都保存在本机（$DSH_HOME/meeting-room），不上传云端；空会议不会落盘；历史文件不会被自动删除。',
      inkNote: '笔记文字',
      documents: '会议文档',
      openDocument: '查看',
      setupTitle: '首次使用会联网下载模型',
      setupBody: '以下功能在第一次用到时需要联网下载本地模型（音频始终不出本机）：',
      setupTranscribe: '语音转写（SenseVoice，本机识别）',
      setupSpeaker: '发言人分离（3D-Speaker CAM++，约 28 MB）',
      setupHandwriting: '手写识别（DAMO 行识别，约 77 MB）',
      setupNote: '模型下载后校验大小与校验和；若下载源全部不可达，对应功能会明确报错，其余功能不受影响。',
      setupDismiss: '知道了',
      setupDetails: '查看详情',
      setupPrepare: '现在下载模型',
      setupPreparing: '正在下载模型…',
      setupPrepared: '模型已就绪',
      setupPrepareFailed: '下载失败，请重试',
      setupPrepareHint: '点「现在下载模型」可提前把发言人模型与手写模型下载到本机；转写模型由「语音输入」在首次转写时下载。',
      speechPrepareHint: '语音识别模型尚未下载。点击「开始下载模型」可提前下载；点击「开始记录」会自动下载，就绪后立即开始录音。',
      speechUnavailableHint: '语音输入功能尚未启用。点击「开始记录」会自动启用语音输入、按需下载语音识别模型，就绪后立即开始录音。',
      speechPrepareAction: '开始下载模型',
      speechDownloading: '正在下载语音模型…（可关闭此面板，后台继续）',
      speechPreparing: '正在准备语音识别…',
      speechAutoStart: '语音识别准备中就绪后自动开始录音——不用再点',
      speechRouteMissing: '宿主路由未注册：这份安装不完整（缺 host-*.js）。请更新到 0.1.0-preview.2 或更新的版本，然后重启 Harness',
      speechChecking: '正在检查语音识别…',
      setupPrepareStalled: '语音模型准备长时间没有进展',
      preparing: '准备中…',
      speechCancel: '取消',
      prepareInPanel: '下载本地模型',
      preparingInPanel: '正在准备…',
      preparedInPanel: '模型已就绪',
    }

    const en = {
      title: 'Meeting notes',
      guideTitle: 'Start a meeting',
      guideDescription: 'Record now and let the meeting agent organise',
      guideOpening: 'Opening the meeting…',
      open: 'Meeting notes',
      start: 'Start',
      stop: 'Stop',
      idle: 'Idle',
      starting: 'Starting the microphone…',
      transcribing: 'Transcribing…',
      elapsed: 'Recorded',
      empty: 'Nothing yet. Start, then speak into the microphone.',
      terms: 'Meeting terms (people, companies, projects, jargon)',
      termsHint: 'One per line, three forms: (1) wrong=right replaces literally, e.g. romi=Romie; (2) a bare word fixes same-sound mishearings, e.g. 陈一鸣 also corrects 沉一明; (3) a leading * also matches single characters by sound, e.g. *李 — use it only for a surname you are sure about, because one syllable can rewrite the wrong character. Corrections never overwrite the recognition; hover a line to see the original.',
      exportFile: 'Save as file',
      copySrt: 'Copy SRT',
      copy: 'Copy transcript',
      copyForFix: 'Copy correction request',
      copied: 'Copied',
      error: 'Error',
      hubTitle: 'Meeting management',
      hubIntro: 'Records stay on this machine; recording happens inside a session (the "Meeting notes" button in the session header opens the sidebar panel).',
      hubCurrent: 'Current session',
      hubNoSession: 'No session is open.',
      hubSessionOpen: 'The session is in the foreground — open the header button to start recording.',
      hubSessionBackground: 'The session is in the background — switch back to it to start recording.',
      hubHowTo: 'Recording runs in the session scope: the session identity is what lets the agent read this meeting through meeting_read.',
      hubRecords: 'Meetings (one row per meeting)',
      hubRefresh: 'Refresh',
        hubLoadMore: 'Load older meetings',
      hubEmpty: 'No meetings recorded yet — hold one and it appears here.',
        hubFilterEmpty: 'No meeting of this type yet.',
        hubAll: 'All',
        hubGroupBy: 'Group by',
        hubGroupDay: 'Day',
        hubGroupWeek: 'Week',
        hubGroupMonth: 'Month',
        hubTasksDone: 'done',
      hubSend: 'Send to new chat',
      hubSendHint: 'Open a new conversation with this meeting\'s transcript, ready to send',
      hubOpenSession: 'Open meeting',
      hubOpenMeetingHint: 'Switch to this meeting\'s conversation and open its record in the right panel',
      hubOpeningMeeting: 'Opening this meeting',
      pushNow: 'Send to DingTalk / WeCom',
      pushNowHint: 'Sends the confirmed assignments the way Meeting management → Settings chose (for a past meeting, that meeting\'s own assignments)',
      pushOne: 'Send this one',
      pushOneHint: 'Sends only this confirmed assignment',
      pushOneNeedsConfirm: 'Not confirmed yet: tick it before sending',
      pushed: 'Sent',
      packageSaving: 'Packaging this meeting',
      packageSaved: 'Saved to file',
      packageFailed: 'Packaging failed',
      hubImport: 'Import meeting',
      hubImportHint: 'Choose a meeting archive (.zip) exported earlier and bring it into this machine',
      hubImported: 'Imported meeting',
      about: 'About',
      aboutName: 'dsh-meeting-room · meeting notes for DeepSeek Harness',
      aboutVersion: 'Version',
      aboutAuthor: 'Author',
      aboutLab: 'Key Laboratory of Media Communication and Cognition, Bortala Media Centre',
      aboutLicense: 'Licence',
      aboutFeedback: 'This is a preview build, and it needs your opinion: if something breaks, feels awkward, or is missing, please write to me. Include the version, your DSH version, what you did and the exact error text — a screenshot helps — and I will follow it up.',
      aboutMail: 'Email',
      pushNothingConfigured: 'Nothing to send to — configure a group robot or a work notification in Meeting management → Settings',
      hubOpenPanelManual: 'Switched to that conversation, but the right panel did not open — use the meeting button in the session header',
      hubNoMeeting: 'This record has no meeting behind it',
      hubNoWorkspace: 'This shell cannot start a new conversation',
      hubClose: 'Close',
      speaker: 'Speaker',
      speakerEnable: 'Prepare speaker labels',
      speakerDownloading: 'Downloading the voice model…',
      speakerReady: 'Speaker labels are on',
      speakerFailed: 'Speaker labels are unavailable',
      speakerOff: 'Speaker labels are off (about 27 MB to prepare)',
      points: 'Key points',
      tasks: 'Work assignments',
      point_decision: 'Decision',
      point_point: 'Point',
      point_risk: 'Risk',
      point_question: 'Open question',
      taskDraft: 'Draft',
      taskConfirmed: 'Confirmed',
      noAnalysis: 'No points or assignments yet. Use "Extract locally" above for rule-based drafts, or ask the agent to refine them in the conversation.',
      pointsNoRecording: 'This meeting has no recording yet. Press Start above, or write a point below.',
      tasksNoRecording: 'This meeting has no recording yet. Press Start above, or write an assignment below.',
      tasksEmpty: 'No assignments yet. Add one directly, or ask the agent to write them from the transcript; the checkbox is the human confirmation that sending requires.',
      addEntry: 'Add',
      entryAdded: 'Added',
      taskTextRequired: 'Write the assignment first',
      originManual: 'written',
      kindGeneral: 'General',
        kindAdhoc: 'Ad-hoc meeting',
      kindBriefing: 'Morning briefing',
      kindReview: 'Daily review',
      kindWeekly: 'Weekly meeting',
      kindMonthly: 'Monthly review',
      meetingNameTitle: 'Name this meeting',
      kindLabel: 'Meeting type',
      roleOtherPlaceholder: 'Other role…',
      panelTabMinutes: 'Minutes',
      followNewest: 'Follow newest',
      jumpToNewest: 'Jump to newest',
      mergeHint: 'Tick several cues to merge them into one task',
      mergeSelected: 'selected',
      mergeToTask: 'Merge into task',
      clearSelection: 'Clear',
      selectCue: 'Select this cue',
      mergeStored: 'Merged into one draft task',
      minutesTabEmpty: 'No minutes yet — choose Minutes to have the agent write them from the transcript.',
      needTranscript: 'needs a transcript first',
      historyGuardDiscard: 'Open without saving',
      meetingNameHint: 'Pick a common name or type your own; it shows in the panel, the transcript header and the minutes.',
      meetingNamePlaceholder: 'Meeting name, e.g. "Briefing · Oct 18"',
        meetingTitleHint: 'Click elsewhere to save; the type decides the period and the one-click template',
        seriesPrev: 'Previous',
        seriesNext: 'Next',
        seriesNone: 'No earlier/later meeting of this type',
      meetingNameSkip: 'Start with no name (auto-name later)',
      meetingNameAutoHint: 'The title may stay empty: once recording starts, the first five minutes name the meeting automatically, and you can still rename it in the panel.',
      meetingNameNone: '(unnamed)',
      periodNone: '(no period)',
      panelTabScores: 'Scores',
      scoresPrefill: 'Pre-fill completion',
      scoresExportCsv: 'Export CSV',
      scoresExportXlsx: 'Export Excel',
      scoresHint: 'Completion can be pre-filled from this period\'s tasks; quality and learning are scored by a person (1–10). Checked = confirmed (evidence is required first). The total follows Meeting management → Settings → Score weights; the defaults are quality 40% + completion 40% + learning 20%.',
        scoreBasisPlaceholder: 'Evidence: a transcript quote or a task id (separate several with ;)',
        scoreBasisRequired: 'Add evidence (a transcript quote or a task id) before confirming',
        scoreBasisMissing: 'no evidence',
      scoresAddPerson: 'Add a person',
      scoreHours: 'Hours',
      scoreCompletion: 'Completion %',
      scoreQuality: 'Quality 1–10',
        scoreWeightTitle: 'Score weights',
        scoreWeightHint: 'A monthly review total weighs these three: quality (1–10 as a percentage), completion (percentage) and learning (1–10 as a percentage). They must add up to 100%; saving applies to existing rows too.',
        scoreWeightSum: 'Total',
        scoreWeightSave: 'Save weights',
        scoreWeightSaved: 'Weights saved; totals are recomputed with them from now on',
        templateTitle: 'One-click distillation templates',
        templateHint: 'The text each type\'s distillation sends to the agent; leave it empty to use the built-in wording. {meetingId}, {title} and {period} are placeholders.',
        templateSave: 'Save templates',
        templateSaved: 'Templates saved',
      scoreLearn: 'Learning 1–10',
      scoreTotal: 'Total',
        scorePerson: 'Name',
        scoreTotalAuto: 'Empty = computed from the weights',
        scoreTotalManual: 'Overridden; clear to compute again',
      scoreHighlight: 'Highlight',
      scoreImprove: 'To improve',
      scoreBasis: 'Evidence',
      scoresExported: 'Exported',
      needPerson: 'Write the person\'s name first',
      carryOverHint: 'Left open by yesterday\'s review:',
      carryOverAction: 'Assign these',
      carryOverOpen: 'Open the review',
      pauseRecording: 'Pause',
      resumeRecording: 'Resume',
      pausedStatus: 'Paused · recorded',
      pauseLongHint: 'Still paused (over 10 minutes)',
      carryOverPrompt: 'Yesterday\'s review left {count} item(s) unfinished or carried over:\n{list}\n\nCheck them against this briefing\'s transcript, decide who takes each one and by when, then write the result into this meeting\'s tasks with meeting_write (drafts a human confirms). Use only the transcript and the list above; do not invent anything.',
        distillBriefing: 'Distil the briefing',
        distillBriefingPrompt: 'Turn this briefing ({title}, {period}, meetingId={meetingId}) into a deployment plan: call meeting_read for the transcript, then meeting_write to store the points and assignments in this meeting (fill owner and due from the transcript). Use only the transcript; never invent. Finish with three sentences on who does what today.',
        distillReview: 'Distil the review',
        distillReviewPrompt: 'Review this meeting ({title}, {period}, meetingId={meetingId}): call meeting_read for the transcript, extract conclusions, risks, actions and open questions, then meeting_write to store them in this meeting (assignments need an owner and a time). Use only the transcript; finish with the three most important conclusions.',
        distillWeekly: 'Summarise the week',
        distillWeeklyPrompt: 'Summarise this weekly meeting ({title}, {period}, meetingId={meetingId}): call meeting_query for this week\'s briefings and reviews (period="this-week"), then combine them with this transcript and use meeting_write to store the week\'s progress, risks and next week\'s plan as points and tasks in meetingId={meetingId}. Use only the records; finish with three conclusions.',
        distillMonthly: 'Draft the scores',
        distillMonthlyPrompt: 'Draft scores for this monthly review ({title}, {period}, meetingId={meetingId}): call meeting_query for this month\'s meetings and task completion (period="this-month"), propose completion, quality and learning scores per person, each with evidence (a transcript quote or a task id), then meeting_write them into this meeting\'s scores (drafts a human confirms). Do not score without evidence; say what is missing.',
        extractNow: 'Extract locally',
        extractDone: 'Extracted',
      historyPlaceholder: 'Search meetings (name / date / type / transcript)',
      historyOpen: 'Open meeting',
      historyLoading: 'Loading…',
      historyEmpty: 'No meeting matches',
      historyBlank: 'empty',
      historyChoose: 'Open',
      historyViewing: 'Viewing a past meeting',
      historyOpenSession: 'Open its conversation',
      historyBack: 'Back to this session',
      historyViewOnly: 'A past meeting keeps its content read-only: ticking "confirmed" is allowed (it only changes the confirmation, which is what sending needs), anything else needs "Back to this session"',
      historyGuardTitle: 'This meeting has unsaved content',
      historyGuardBody: 'It is saved automatically in 3 seconds, then the chosen meeting opens; you can also save now or cancel.',
      historyGuardNow: 'Save and open now',
      historyAll: 'All shown',
      historyMore: 'Scroll for more…',
      extractEmpty: 'No obvious points or assignments were found. Ask the agent in the conversation to refine, e.g. "read this meeting and give me the key points and action items".',
      noMeeting: 'This session has no meeting yet. Start a recording first, then work on its points and assignments.',
      seekHint: 'Click to jump to this cue',
      agentDone: 'Updated',
      follow: 'Follow playback',
      hubNoText: 'This recording has no matching transcript.',
      segments: 'cues',
      remove: 'Delete',
      ownerPh: 'Owner',
      duePh: 'Due',
      originRule: 'Rule',
      originAgent: 'Agent',
      ink: 'Handwritten note',
      inkHint: 'Write below with the pen or the mouse; the Windows pen eraser end is read as an eraser.',
      inkPen: 'Pen',
      inkErase: 'Eraser',
      inkUndo: 'Undo',
      inkClear: 'Clear',
      inkSave: 'Save as note',
      inkSaved: 'Note saved',
      inkLocal: 'Recognize as text',
      inkLocalEmpty: 'Nothing was recognized; write larger and retry',
      inkLasso: 'Lasso',
      clearEntry: 'Clear',
      inkLassoHint: 'Tap a character to select it; long-press the pad to start a lasso',
      inkSelection: 'Recognize selection',
      inkToTask: 'To task',
      inkToTaskDone: 'Added as a draft task',
        taskMarkDone: 'Mark as done (checked off)',
        taskDoneAt: 'Done at',
      needSession: 'This needs a session: open the meeting panel from a conversation first',
      roleLabel: 'My role',
      speakingNow: 'speaking',
      roleHost: 'Host',
      roleAttendee: 'Attendee',
      roleObserver: 'Observer',
      roleHint: 'Reviews are organised around this role',
      review: 'Review the meeting',
      pushDone: 'Pushed to the group robot',
      robotSettings: 'Settings',
      settingsTabs: 'Settings groups',
      settingsTabPush: 'Push & robots',
      settingsTabCloud: 'Cloud recognition',
      settingsTabTranscript: 'Transcript & cues',
      settingsTabSpeaker: 'Speaker recognition',
      settingsTabWeights: 'Score weights',
      settingsTabTemplates: 'Distillation prompts',
      robotHint: 'Paste the DingTalk / WeCom robot webhook addresses; leave one empty to skip it. Only confirmed tasks are pushed, and the addresses stay on this machine.',
      robotSave: 'Save addresses',
      robotSaved: 'Saved',
      robotNone: 'not configured',
      robotAppHint: 'Both private delivery (work notification) and contact sync need a DingTalk internal app: AppKey, AppSecret and AgentId, with the matching permissions granted.',
      pushMode: 'Delivery',
      pushModeGroup: 'Group robot',
      pushModeWork: 'Work notice',
      pushModeBoth: 'Both',
      peopleTitle: 'People (name / mobile / DingTalk UserId)',
      peopleHint: 'The mobile is what a group robot mentions; the UserId is what a private work notification addresses. A task owner matches a person by name. The roster is shared by every meeting.',
      phonePh: 'Mobile',
      userIdPh: 'UserId',
      peopleUnit: 'people',
      hubTabRecords: 'Records',
      hubTabModels: 'Models',
      modelsHint: 'Which models recognition runs on. A model must be installed and verified (size and sha256) before it can be chosen. Nothing leaves this machine by default, and switching only affects later recognition — text already recorded is untouched.',
      modelInstall: 'Download and install',
      modelRetry: 'Download again',
      modelInstalled: 'Installed',
      modelImportFile: 'Import from a file',
      modelImportHint: 'Pick this model\'s file (an offline machine, a private mirror, or a model you trained). Anything that does not match the catalog is refused.',
      modelImported: 'Imported',
      modelActivate: 'Use this one',
      modelActivated: 'Switched',
      modelRemove: 'Remove',
      modelRemoved: 'Files removed',
      modelDownloading: 'Downloading',
      modelLicence: 'Licence',
      modelDirectory: 'Model directory',
      modelStateReady: 'Ready',
      modelStateMissing: 'Not installed',
      modelStateBad: 'Verification failed',
      modelByDsh: 'Provided by DSH',
      modelInUse: 'In use',
      cloudTitle: 'Cloud recognition (off by default)',
      cloudHint: 'With this on, audio is sent to the address below for recognition; with it off everything is recognised on this machine and the plugin makes no outgoing request at all. Only the current cue travels (never the whole recording), and the request declares that it may not be retained. The key lives in this machine\'s settings only: never displayed, never logged, never inside a meeting package.',
      cloudConsent: 'I agree to send audio to the address below for recognition',
      cloudProvider: 'Service type',
      cloudOff: 'Off',
      cloudOpenAi: 'OpenAI-compatible (/audio/transcriptions)',
      cloudCustom: 'Custom',
      cloudWhere: 'Audio would go to',
      cloudRetention: 'declared as not retained',
      cloudNowhere: 'No address configured yet',
      cloudSave: 'Save cloud settings',
      cloudSaved: 'Saved',
      cloudTest: 'Test connection',
      cloudOk: 'Reachable',
      cloudFailed: 'Not reachable',
      cloudFallback: 'Fell back to on-machine recognition',
      cloudUsed: 'This cue came from the cloud',
      speakerTitle: 'Speaker recognition',
      transcriptTitle: 'How the transcript reads, and where it is cut',
      transcriptNormalize: 'Write numbers, dates and times the way people write them',
      transcriptNormalizeHint: 'For example 二零二六年十月十九号 becomes 2026年10月19日, 百分之三十 becomes 30%, 三点半 becomes 3点半. These are local rules with no network involved, and the literal recognition stays in the transcript for comparison.',
      transcriptMinCue: 'Shortest cue (s)',
      transcriptMaxCue: 'Longest cue (s)',
      transcriptMaxLine: 'Most characters per line',
      transcriptSilenceHold: 'Pause that ends a cue (s)',
      transcriptSilenceRms: 'Silence threshold',
      transcriptCueHint: 'Cues are cut in the browser: a pause longer than the hold ends a cue, and no pause inside the shortest cue counts. A smaller maximum puts words on screen sooner at the cost of more requests; a larger one does the opposite.',
      transcriptRules: 'Normalisation rules enabled',
      transcriptSave: 'Save transcript settings',
      speakerThreshold: 'How strictly voices are separated',
      speakerFullRelabel: 'Re-judge every cue when the recording stops (recommended)',
      speakerSettingsHint: 'Raise the threshold for a crowded room (stricter: rather split one voice than merge two people); lower it for a small meeting, or a voice that varies a lot. The full pass replaces the old rule of backfilling only the last 60 cues, which is what used to break labels apart in a long meeting. Changing the threshold needs a fresh prepare — the recogniser restarts itself.',
      speakerRestarted: 'Saved; the recogniser restarted, so the new threshold applies on the next prepare',
      speakerSave: 'Save speaker settings',
      voiceLibrary: 'Voice library (vectors only, never audio)',
      voiceLibraryEmpty: 'The library is empty: give a voice a real name under Speaker names and it is remembered, so a later meeting suggests it when that person speaks again.',
      voiceLibraryFile: 'Voice library file',
      voiceForget: 'Forget',
      voiceClear: 'Clear the library',
      hubTabTerms: 'Terms',
      autoRecordStarted: 'Start request received — recording is on',
      stopFinishing: 'Finishing up: waiting for the last cues…',
      stopRemaining: 'left',
      stopElapsed: 'waited',
      stopFinished: 'Finished — the meeting is saved',
      hubLastTopic: 'Last meeting',
      hubTabSettings: 'Settings',
      hubTabPeople: 'People',
      panelTabTranscript: 'Transcript',
      panelTabSpeakers: 'Speakers',
      secretKept: 'AppSecret (saved; leave empty to keep)',
      readDepartments: 'Read departments',
      allOrganization: 'Whole organization',
      syncFromDingtalk: 'Sync from DingTalk',
      peopleSynced: 'Sync finished',
      peopleAdded: 'added',
      hubWorking: 'Working…',
      editEntry: 'Edit',
      saveEntry: 'Save',
      cancelEntry: 'Cancel',
      taskTitlePh: 'Assignment',
      dueUnset: 'Unset',
      dueToday: 'Today 18:00',
      dueTomorrowMorning: 'Tomorrow 09:00',
      dueTomorrow: 'Tomorrow 18:00',
      dueFriday: 'This Friday 18:00',
      dueMonday: 'Next Monday 09:00',
      dueMonthEnd: 'End of month 18:00',
      dueCustom: 'Custom…',
      pointTextPh: 'Key point',
      pointTextRequired: 'A key point needs text',
      priorityHigh: 'High',
      priorityNormal: 'Normal',
      priorityLow: 'Low',
      more: 'More',
      speakerNames: 'Speaker names',
      voiceSuggestions: 'Names the voice library recognises (yours to confirm)',
      voiceSoundsLike: 'sounds like',
      voiceAccept: 'Use this name',
      openNames: 'Name them',
      speakerNameHint: 'Give each recognized voice a real name. The label stays the same, and names follow the voice through the end-of-meeting re-clustering; empty shows S1, S2.',
      speakerNamePlaceholder: 'Name',
      speakerNamesEmpty: 'No voices recognized yet. Labels (S1, S2 …) appear after someone speaks and pauses; if the whole meeting stayed blank, re-identify it from the recording.',
      speakerRelabel: 'Re-identify speakers',
      speakerRelabeling: 'Re-identifying…',
      speakerRelabelDone: 'Speakers re-identified',
      reviewSending: 'Transcript sent to the conversation; the agent is reviewing it',
      reviewNoSession: 'Reviewing needs a signed-in conversation',
      reviewPrompt: 'Below is the full transcript of a meeting (recognized locally, so it may contain errors). Review this meeting as the 「{role}」 and produce a Markdown document ready to archive.\n\n[Role focus] {focus}\n\n[Requirements]\n1. Use only the transcript; never invent details that are not there.\n2. Treat names and terms that may be misrecognized conservatively and mark uncertainty.\n3. Structure: # Meeting review ({role} view) → summary → key conclusions → {section} → uncertain items.\n4. Make actionable points specific about who and when.\n5. After writing the document, call meeting_save_document to store it in this meeting (kind=review, title=Meeting review ({role} view), markdown=the full text), so the user can open it from the meeting panel later.\n\n[Transcript]\n{transcript}',
      roleHostFocus: 'whether the goals were met; how far each topic advanced; which decisions were made; who committed to what and by when; what is unresolved and with whom; what the next meeting should settle first.',
      roleAttendeeFocus: 'what I own and when it is due; what others asked of me; how the decisions affect my work; what I must follow up or confirm; what I may have misheard.',
      roleObserverFocus: 'the overall arc of the meeting; which conclusions were reached; the positions and disagreements of each side; what is worth recording.',
      roleHostSection: 'Decisions and open items',
      roleAttendeeSection: 'My action items',
      roleObserverSection: 'Key information',
      minutes: 'Generate minutes',
      minutesDocx: 'Export Word',
      minutesDocxDone: 'Word written to the export directory',
      revisePrompt: 'This meeting has finished. First call meeting_read to read the full transcript (each cue carries a #id), then make one consistent correction pass using the meeting context: the same person, company and terminology written the same way; words clearly misheard as homophones fixed; obvious misrecognitions repaired. Then submit the corrections with meeting_revise, where each entry is {id, text} — the id from the transcript and the full corrected text for that cue. Correct only what the context supports, never invent content, and leave anything uncertain as it is. Finish with a short note saying what you changed.',
      minutesDone: 'Minutes written to the export directory',
      minutesEmpty: 'This meeting has nothing to write up yet',
      tabTerms: 'Terms',
      notesToggle: 'Handwritten note',
      helpToggle: 'Help',
      helpBody: '[Starting and naming]\n· Start recording opens "Name this meeting": the name, your role (host / attendee / observer buttons, or your own words under Other role) and the type (general / briefing / review / weekly / monthly). Choosing a type fills the title as "type · today" and you can still edit it; "Start with no name" leaves the title empty on purpose: the first five minutes name the meeting automatically, and it can still be renamed in the panel.\n· One conversation owns one meeting; forks get their own, and subagents share the conversation\'s meeting.\n· Speech and speaker models download on demand with progress in the panel; a Start before they are ready prepares them and then records automatically.\n\n[Recording]\n· Start/Stop runs the meeting; Pause/Resume covers a break — nothing is captured while paused and the timeline stays continuous, with one reminder after 10 minutes (never an automatic stop).\n· The status line shows elapsed time and who is speaking. Every control lives in the top row of the panel.\n\n[Transcript]\n· It follows the newest cue; scrolling up turns following off and offers "Jump to newest".\n· Tick several cues and choose "Merge into task" to make one assignment out of them.\n· Clicking a cue plays from that sentence; "to task" on a row turns that one sentence into an assignment.\n· The More menu copies SRT, plain text, or a correction request for a model.\n\n[Minutes]\n· "Minutes" writes Markdown and "Export Word" writes .docx; both open the browser\'s save dialog, and the minutes also stay in the meeting for later.\n· More → Meeting terms: one per line, "wrong=right" is replaced in the transcript, a bare word becomes a hot word; edits save as you type.\n\n[Points and tasks]\n· Both tabs add, edit and delete directly. Tasks are drafts until ticked as confirmed, and carry an owner, a due time and a priority. Owners and speaker names are suggested from the roster on Meeting management → People, including the people synced from DingTalk.\n· To let the model write them, say so in the conversation ("read this meeting\'s transcript and write the points and tasks into the meeting") — the agent stores them with meeting_write.\n· "Send to DingTalk / WeCom" in the tasks tab sends the CONFIRMED assignments the way Meeting management → Settings chose (group robot, work notification, or both), and says why when nothing is configured. Each row also has "Send this one" for a single assignment.\n\n[Speakers]\n· Each voice label takes a name: type it, or pick from the roster dropdown (typing filters it).\n· "Identify speakers again" re-reads the recording — for a meeting whose model was not ready, or a long one the stop-time backfill only partly covered; the stop-time pass now covers every cue by default (changeable under Meeting management → Settings).\n· Naming a voice remembers it in the voice library (vectors only, never audio); another meeting suggests "sounds like X" for that person, and nothing is written until you press Use this name. The threshold presets and the library (forget / clear) live in Settings too.\n\n[Scores (monthly review)]\n· The score tab appears for a monthly meeting only: prefill completion from the month\'s tasks, then score each person (hours / completion / quality / learning), note what went well and what to improve, and record the evidence.\n· CSV and Excel export are available; rows stay drafts until a human confirms them.\n\n[Handwritten notes]\n· The pad has pen, eraser, undo and clear; tap a discovered character to select it, or long-press about 0.6 s to start a lasso.\n· "Recognise" runs the local offline model (about 43 ms a line) and can turn the text into a task; "Save as image" stores the page in the meeting.\n· Notes, recognition and tasks work without recording: the first write creates the meeting.\n\n[Opening meetings and history]\n· "Open meeting" in the action row is a searchable dropdown: filter by name, date, type or transcript words, scroll to load more, and click the name or the row to open it.\n· A past meeting opens read-only (history is never edited), with "Open its conversation" and "Back to this session"; ticking "confirmed" on an assignment is allowed there — it is the step sending needs, and it is written to that meeting.\n· If the current meeting has content, switching counts down three seconds and saves first; you may also save immediately or open without saving.\n\n[Save as file · Import · About]\n· More → Save as file packs this meeting into ONE zip project: the record, the recording, and the artifacts (minutes, images). A notice in the bottom-right corner tracks it (packaging → percentage → saved to file).\n· Meeting management → Records → Import meeting takes such a zip back in (as a NEW meeting: nothing is overwritten, it belongs to no conversation, and clashing file names are renamed), which is how a meeting travels to another DSH.\n· More → About shows the version actually installed here, the author and the address; use "Email" to report a problem or an idea, with the version and what you did.\n\n[Meeting management (left sidebar)]\n· Records: one row per meeting with its time, name, type, counts and a preview; "Refresh" re-reads the list and "Import meeting" brings in a package; click a name to review its transcript and recording below.\n· Settings: group-robot webhooks, the DingTalk application (appKey / appSecret / agentId) and how results are pushed — the tasks tab\'s one-click send follows this choice.\n· People: the shared roster (name / phone / user id), maintained by hand or synced from DingTalk departments; it is also where task owners and speaker names are suggested from.\n· Terms: the same list as More → Meeting terms.\n· Models: which model recognition runs on — the built-in speaker and handwriting models, plus any stronger model imported from a local file; a model must be installed and verified (size and sha256) before it can be chosen, and switching only affects later recognition.\n\n[Everything stays on this machine]\n· Recordings, transcripts, points, tasks, minutes, scores and notes live in $DSH_HOME/meeting-room and are never uploaded; an empty meeting is not written to disk, and history is never deleted automatically.',
      inkNote: 'Note text',
      documents: 'Meeting documents',
      openDocument: 'Open',
      setupTitle: 'Models download on first use',
      setupBody: 'These features download their local models the first time you use them (audio never leaves this machine):',
      setupTranscribe: 'Speech transcription (SenseVoice, on-device)',
      setupSpeaker: 'Speaker diarization (3D-Speaker CAM++, ~28 MB)',
      setupHandwriting: 'Handwriting recognition (DAMO line model, ~77 MB)',
      setupNote: 'Downloads are verified by size and checksum. If every download source is unreachable, that feature reports a clear error while the others keep working.',
      setupDismiss: 'Got it',
      setupDetails: 'View details',
      setupPrepare: 'Download models now',
      setupPreparing: 'Downloading models\u2026',
      setupPrepared: 'Models ready',
      setupPrepareFailed: 'Download failed, retry',
      setupPrepareHint: 'Download the speaker and handwriting models now; the transcription model downloads on first transcription via Voice input.',
      speechPrepareHint: 'The speech recognition model has not been downloaded. Click "Download model now" to prepare it in advance, or click "Start" to download it automatically and begin recording as soon as it is ready.',
      speechUnavailableHint: 'Voice input is not enabled yet. Clicking "Start" enables voice input, downloads the speech model if needed, and begins recording as soon as it is ready.',
      speechPrepareAction: 'Download model now',
      speechDownloading: 'Downloading the speech model\u2026 (safe to close this panel; it continues in the background)',
      speechPreparing: 'Preparing speech recognition\u2026',
      speechAutoStart: 'Preparing speech recognition — recording starts by itself, no need to click again',
      speechRouteMissing: 'The host routes are not registered: this installation is incomplete (host-*.js is missing). Update to 0.1.0-preview.2 or newer, then restart the Harness',
      speechChecking: 'Checking speech recognition…',
      setupPrepareStalled: 'Speech model preparation has made no progress for a long time',
      preparing: 'Preparing…',
      speechCancel: 'Cancel',
      prepareInPanel: 'Download local models',
      preparingInPanel: 'Preparing\u2026',
      preparedInPanel: 'Models ready',
    }

    const styles = {
      panel: {
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        // The panel owns the only scrollbar; the head inside it sticks, so everything pinned
        // there — buttons, player, the content tabs and the note pad — stays put.
        overflowY: 'auto',
        minHeight: 0,
        boxSizing: 'border-box',
      },
      /** Buttons, status, player and the content tabs: the part that never scrolls away. */
      panelHead: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        position: 'sticky',
        top: 0,
        zIndex: 7,
        // The right sidebar shell paints nothing of its own, so the application base colour is
        // exactly what sits behind the panel: an opaque head blends in and still hides the
        // rows scrolling underneath it.
        background: 'var(--dsw-alias-bg-base)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        padding: '4px 2px',
      },
      /** The trailing content: grouped so the panel's scroll and the head stay separate. */
      panelScroll: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        minHeight: 0,
      },
      subtitle: { margin: 0, fontSize: '12px', opacity: 0.7, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: { padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' },
      headerButton: { padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' },
      status: { fontSize: '12px', opacity: 0.8 },
      label: { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '2px' },
      /** A labelled field that stacks instead of sitting in one row (the summary block). */
      fieldBlock: { display: 'flex', flexDirection: 'column', gap: '4px' },
      hint: { display: 'block', fontSize: '11px', opacity: 0.6, marginBottom: '4px', lineHeight: 1.5 },
      taskEdit: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(64,132,255,0.45)',
        background: 'rgba(64,132,255,0.08)',
      },
      inlineWide: { flex: 1, minWidth: '120px', padding: '3px 6px', fontSize: '12px' },
      /** One assignment, always editable: a larger title and its inline controls. */
      taskRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      taskRowDraft: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px dashed var(--dsw-alias-border-l2)',
      },
      /** The panel's title row: the meeting's name, larger than the controls beside it. */
      templateArea: {
      width: '100%',
      minHeight: 64,
      padding: 6,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: 1.5,
      resize: 'vertical',
      boxSizing: 'border-box',
    },
    scoreHeadRow: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      alignItems: 'center',
      padding: '2px 6px',
    },
    scoreHead: {
      flex: 1,
      minWidth: 56,
      fontSize: 11,
      color: 'var(--dsh-text-secondary, #6b7280)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    titleStatic: {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: 600,
    },
    titleInput: {
        flex: '1 1 160px',
        minWidth: '120px',
        padding: '2px 4px',
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '15px',
        fontWeight: 600,
      },
      taskTitleInput: {
        flex: 1,
        minWidth: '160px',
        padding: '4px 6px',
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '15px',
        fontWeight: 600,
      },
      /** A box of cues that scrolls on its own, so following never moves the panel. */
      transcriptBox: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '48vh', overflowY: 'auto' },
      recognized: { flex: 1, minWidth: '80px', fontSize: '12px', opacity: 0.9 },
      help: {
        display: 'block',
        whiteSpace: 'pre-line',
        fontSize: '11.5px',
        lineHeight: 1.7,
        padding: '8px 10px',
        marginTop: '6px',
        border: '1px solid rgba(64,132,255,0.35)',
        borderRadius: '6px',
        background: 'rgba(64,132,255,0.08)',
        maxHeight: '260px',
        overflowY: 'auto',
      },
      textarea: { width: '100%', minHeight: '56px', padding: '6px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      segment: { display: 'flex', gap: '8px', fontSize: '13px', lineHeight: 1.6, padding: '0 4px', borderRadius: '4px', cursor: 'pointer' },
      segmentActive: { display: 'flex', gap: '8px', fontSize: '13px', lineHeight: 1.6, padding: '0 4px', borderRadius: '4px', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)', fontWeight: 600 },
      stamp: { opacity: 0.55, fontVariantNumeric: 'tabular-nums', minWidth: '38px' },
      chip: { padding: '0 6px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)', fontSize: '11px', alignSelf: 'center' },
      empty: { margin: 0, fontSize: '12px', opacity: 0.6 },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      note: { margin: 0, fontSize: '11px', opacity: 0.7, wordBreak: 'break-all' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      hub: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '860px', height: '100%', minHeight: 0, boxSizing: 'border-box' },
      /**
       * The scrolling part of the page: the heading, the status card and the tab row stay put,
       * and each tab's own content moves under them once it is taller than the frame.
       */
      hubBody: { display: 'flex', flexDirection: 'column', gap: '14px', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingRight: '4px',
        // Belt and braces: if the frame hands this page an indefinite height, the tab body
        // still gets a ceiling of its own instead of running off the bottom.
        maxHeight: 'calc(100vh - 200px)' },
      /** Floating notices: bottom-right, above panel chrome, below dialogs. */
      toasts: { position: 'fixed', right: '16px', bottom: '16px', zIndex: 4000, display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: 'min(420px, 80vw)' },
      toastCard: { padding: '8px 12px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' },
      hubTitle: { margin: 0, fontSize: '18px', fontWeight: 600 },
      /** A day/week/month heading above one group of records. */
      groupHead: { fontSize: '11px', fontWeight: 600, opacity: 0.7, padding: '6px 8px 2px', letterSpacing: '0.02em' },
      /** One meeting in the management page: fixed columns, so the rows line up. */
      hubRecord: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      hubRecordWhen: { flex: '0 0 128px', fontSize: '11px', opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
      hubRecordMain: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      hubRecordExcerpt: { fontSize: '11px', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      hubRecordActions: { flex: '0 0 auto', display: 'flex', gap: '4px', alignItems: 'center' },
      linkButton: { padding: 0, border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
      pre: { margin: 0, maxHeight: '320px', overflow: 'auto', fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      audio: { width: '100%' },
      player: { display: 'flex', flexDirection: 'column', gap: '8px' },
      playerList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '360px', overflowY: 'auto' },
      buttonActive: { padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', background: 'var(--dsw-alias-bg-layer-2)' },
      inlineInput: { padding: '2px 6px', borderRadius: '4px', fontSize: '12px', width: '72px', fontFamily: 'inherit', boxSizing: 'border-box' },
      smallButton: { padding: '1px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' },
      /** The overflow menu hangs under its button instead of widening the action row. */
      menuWrap: { position: 'relative', display: 'inline-block' },
      menu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        right: 0,
        // Above the panel's own chrome and pinned rows; dialogs stay above this.
        zIndex: 3000,
        minWidth: '168px',
        display: 'flex',
        flexDirection: 'column',
        padding: '4px',
        gap: '2px',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
        // A long menu scrolls instead of running off a short panel.
        maxHeight: '60vh',
        overflowY: 'auto',
      },
      menuItem: {
        padding: '6px 10px',
        border: 'none',
        background: 'none',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        fontFamily: 'inherit',
        textAlign: 'left',
        borderRadius: '6px',
        whiteSpace: 'nowrap',
      },
      /** One picker result: two lines, the whole card opens the meeting. */
      historyRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '6px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: '1px solid transparent',
      },
      historyHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      historyName: { fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: '2px' },
      historyExcerpt: { fontSize: '12px', opacity: 0.75, lineHeight: 1.5, wordBreak: 'break-word' },
      /** The picker: a field with results floating under it, scrollable and paged. */
      pickerWrap: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' },
      historyPanel: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        // Same layer as the overflow menu: a dropdown is never covered by panel content.
        zIndex: 3000,
        maxHeight: '320px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
      },
      taskDone: { display: 'flex', gap: '8px', fontSize: '13px', lineHeight: 1.6, padding: '0 4px', borderRadius: '4px', opacity: 0.55 },
      ink: { display: 'block', width: '100%', height: '320px', touchAction: 'none', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px', cursor: 'crosshair' },
      inkShot: { maxWidth: '100%', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
      tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '2px' },
      tab: { padding: '4px 10px', border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', borderRadius: '6px 6px 0 0', opacity: 0.7 },
      tabActive: { padding: '4px 10px', border: 'none', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', borderRadius: '6px 6px 0 0', fontWeight: 600 },
      tabBody: { minHeight: '384px', display: 'flex', flexDirection: 'column', gap: '8px' },
      hintLines: { display: 'block', fontSize: '11px', opacity: 0.65, lineHeight: 1.6, whiteSpace: 'pre-line' },
      termsArea: { width: '100%', flex: 1, minHeight: '320px', padding: '6px', borderRadius: '6px', fontFamily: 'inherit', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box' },
      setupOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 },
      setupCard: { position: 'relative', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', padding: '18px 20px', maxWidth: '460px', width: 'calc(100% - 40px)', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
      /** The same card for a dialog that has more to read (the tutorial). */
      setupCardWide: { position: 'relative', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', padding: '18px 22px', maxWidth: '820px', width: 'min(92vw, 820px)', maxHeight: '82vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
      setupTitle: { margin: 0, fontSize: '16px', fontWeight: 600 },
      setupFeature: { fontSize: '13px', lineHeight: 1.6 },
      setupFoot: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      setupClose: { position: 'absolute', top: '8px', right: '12px', border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '4px' },
    }

    /**
     * The plugin's one control stylesheet, in two parts.
     *
     * Platform path: when the host provides `@deepseek-ai/dsh-client-ui-primitives`, buttons
     * and fields ARE those components, so this sheet only places them (`.mr-ui*`, widths,
     * the tab underline, a full-width menu row). The look is the host's, which is what keeps
     * the plugin from drifting away from the UI it lives in.
     *
     * Fallback path: on a host without that module the same call sites render raw elements
     * and take the skin below, so the plugin stays coherent instead of unstyled. Colours are
     * theme tokens, which is also what makes light and dark both correct.
     */
    const CONTROL_CSS = `
.mr-btn { font: inherit; font-size: 12px; line-height: 1.5; padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); cursor: pointer;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.mr-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.mr-btn:active { background: var(--dsw-alias-bg-base); }
.mr-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mr-btn:disabled { opacity: .5; cursor: not-allowed; }
.mr-btn--active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.mr-btn--small { padding: 1px 8px; font-size: 11px; border-radius: 4px; }
.mr-btn--link { border-color: transparent; background: none; padding: 0 2px; text-decoration: underline;
  color: var(--dsw-alias-brand-primary); }
.mr-btn--menu { display: block; width: 100%; text-align: left; border-color: transparent; background: none;
  padding: 6px 10px; white-space: nowrap; }
.mr-btn--menu:hover { background: var(--dsw-alias-bg-layer-2); }
.mr-btn--tab { border-color: transparent; background: none; border-radius: 6px 6px 0 0; opacity: .68; }
.mr-btn--tab:hover { opacity: 1; background: none; }
.mr-btn--tab-active { border-color: transparent; background: none; border-radius: 6px 6px 0 0;
  box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); font-weight: 600; }
.mr-btn--header { border-color: transparent; background: none; }
.mr-btn--plain { border-color: transparent; background: none; }
.mr-field, .mr-picker { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 3px 6px; box-sizing: border-box; }
.mr-field::placeholder { color: var(--dsw-alias-label-secondary); }
.mr-field:hover, .mr-picker:hover { border-color: var(--dsw-alias-border-l2); }
.mr-field:focus, .mr-picker:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mr-field:disabled, .mr-picker:disabled { opacity: .55; cursor: not-allowed; }
.mr-field--wide { flex: 1 1 120px; min-width: 0; }
.mr-field--tight, .mr-picker--tight { width: 76px; }
.mr-field--area { min-height: 72px; resize: vertical; width: 100%; }
.mr-field--title { border-color: transparent; background: none; padding: 2px 4px; flex: 1 1 auto; min-width: 0; }
.mr-field--title:hover { border-color: var(--dsw-alias-border-l1); }
/* Platform path: no skin of our own, only what the host component cannot know. */
/* A chosen control keeps the host's primary fill: overriding it here is what made a
   selected chip look like the panel background once the pointer left it. Only the weight
   is added, so the host's own "this one is chosen" colour stays visible. */
.mr-ui.mr-layout-active { font-weight: 600; }
.mr-ui.mr-layout-link { text-decoration: underline; justify-content: flex-start; text-align: left; }
/* The fallback skin for the same variant, so a link is left-aligned on either path. */
.mr-btn--link { text-align: left; }
.mr-ui.mr-layout-menu { display: block; width: 100%; text-align: left; white-space: nowrap; }
.mr-ui.mr-layout-tab, .mr-ui.mr-layout-tab-active { border-radius: 6px 6px 0 0; }
.mr-ui.mr-layout-tab { opacity: .68; }
.mr-ui.mr-layout-tab:hover { opacity: 1; }
.mr-ui.mr-layout-tab-active { box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); font-weight: 600; }
.mr-ufield.mr-layout-wide { flex: 1 1 120px; min-width: 0; }
.mr-ufield.mr-layout-tight { width: 76px; }
/* Surfaces: one card, one list, one row — shared by the panel and the left-sidebar page. */
.mr-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.mr-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
.mr-row { display: flex; align-items: baseline; gap: 8px; padding: 3px 6px; border-radius: 6px;
  transition: background .12s ease; }
.mr-row:hover { background: var(--dsw-alias-bg-layer-2); }
.mr-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A choice is a Menu behind a Button: keep the trigger as narrow as the select was. */
.mr-choice { max-width: 168px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mr-choice.mr-choice--tight { max-width: 108px; }
/* Dialog bodies and chip rows lay themselves out, whatever container renders them. */
.mr-dialog-body { display: flex; flex-direction: column; gap: 12px; }
.mr-dialog-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.mr-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
/* A long read such as the tutorial gets a wider card than an ordinary prompt. */
.mr-dialog-wide { width: min(92vw, 820px) !important; max-width: min(92vw, 820px) !important; }
.mr-dialog-wide .mr-dialog-body { max-height: 70vh; overflow-y: auto; }
/* A one-line field, whatever height the host input would otherwise take. The rule reaches
   the host's own wrapper as well, because that wrapper — not the inner <input> — is what
   carries the tall box. */
.mr-input-compact,
.mr-input-compact > *,
.mr-input-compact input {
  height: 26px !important;
  min-height: 26px !important;
  max-height: 26px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  line-height: 1.4 !important;
}
.mr-input-compact > * { display: flex; align-items: center; }
.mr-ufield.mr-layout-title { flex: 1 1 auto; min-width: 0; }
.mr-hover { transition: background .12s ease; }
.mr-hover:hover { background: var(--dsw-alias-bg-layer-2); }
`
    if (typeof document !== 'undefined' && document.getElementById('mr-control-style') === null) {
      const sheet = document.createElement('style')
      sheet.id = 'mr-control-style'
      sheet.textContent = CONTROL_CSS
      document.head.appendChild(sheet)
    }

    /** Which shared variant each of the plugin's own style objects means. */
    const BTN_VARIANT = new Map([
      [styles.button, 'default'],
      [styles.buttonActive, 'active'],
      [styles.smallButton, 'small'],
      [styles.linkButton, 'link'],
      [styles.menuItem, 'menu'],
      [styles.tab, 'tab'],
      [styles.tabActive, 'tab-active'],
      [styles.headerButton, 'header'],
    ])
    const FIELD_VARIANT = new Map([
      [styles.inlineInput, 'tight'],
      [styles.inlineWide, 'wide'],
      [styles.textarea, 'area'],
      [styles.taskTitleInput, 'title'],
      [styles.termsArea, 'area'],
    ])

    /**
     * The host's own controls, when this host ships them. `null` means the plugin renders
     * its fallback markup instead — the same required/optional split the market plugin uses,
     * except that here every call site has a working fallback, so nothing is ever skipped.
     */
    const HostButton = typeof primitives.Button === 'function' || (typeof primitives.Button === 'object' && primitives.Button !== null)
      ? primitives.Button
      : null
    const HostInput = typeof primitives.Input === 'function' || (typeof primitives.Input === 'object' && primitives.Input !== null)
      ? primitives.Input
      : null
    const HostMenu = typeof primitives.Menu === 'function' || (typeof primitives.Menu === 'object' && primitives.Menu !== null)
      ? primitives.Menu
      : null
    const HostModal = typeof primitives.Modal === 'function' || (typeof primitives.Modal === 'object' && primitives.Modal !== null)
      ? primitives.Modal
      : null
    /** The host's own toast, for work that takes long enough to be worth watching. */
    const HostToast = typeof primitives.Toast === 'function' || (typeof primitives.Toast === 'object' && primitives.Toast !== null)
      ? primitives.Toast
      : null

    /**
     * ReactDOM, used only for portals. A dropdown has to be rendered outside the panel:
     * inside it, any z-index still belongs to the panel's stacking context, which is what
     * let other parts of the interface paint over the overflow menu.
     */
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    /** The host Button preset each of our variants means. */
    const BTN_PRESET = {
      default: { variant: 'outline', size: 'md' },
      // A chosen chip or a toggled-on button must read as chosen at a glance, and the host's
      // primary variant is exactly that statement.
      active: { variant: 'primary', size: 'md' },
      small: { variant: 'outline', size: 'sm' },
      link: { variant: 'ghost', size: 'sm' },
      menu: { variant: 'ghost', size: 'md' },
      tab: { variant: 'ghost', size: 'md' },
      'tab-active': { variant: 'ghost', size: 'md' },
      header: { variant: 'ghost', size: 'md' },
      plain: { variant: 'ghost', size: 'md' },
    }

    /**
     * Join the caller's className with ours; call sites rarely pass one, but a caller that
     * does must not lose it.
     * @param extra - the caller's className, if any.
     * @param ours - the class we render with.
     * @returns the combined className.
     */
    function classNames(extra, ours) {
      return typeof extra === 'string' && extra !== '' ? `${ours} ${extra}` : ours
    }

    /**
     * Render a floating element at the document root when portals are available, and in
     * place otherwise. Outside the panel it escapes both the panel's stacking context and
     * its scroll clipping, so a dropdown is never covered or cut off.
     * @param node - the element to float.
     * @returns the element, portalled when possible.
     */
    function float(node) {
      if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function' || typeof document === 'undefined') return node
      return ReactDOM.createPortal(node, document.body)
    }

    /**
     * Float a dropdown only when its place is known; without coordinates it stays in the
     * panel, where absolute positioning still puts it under its button.
     * @param measured - whether a placement was measured.
     * @param node - the dropdown element.
     * @returns the element, portalled when a placement exists.
     */
    function floatWhen(measured, node) {
      return measured === true ? float(node) : node
    }

    /**
     * Ask the browser to save a produced artifact. The host serves it with an attachment
     * disposition, so the person gets the usual download rather than a path to go and find.
     * @param name - file name inside the export directory.
     */
    function downloadArtifact(name) {
      if (typeof name !== 'string' || name === '' || typeof document === 'undefined') return
      downloadUrl(`${PREFIX}/download?name=${encodeURIComponent(name)}`, name)
    }

    /**
     * Ask the browser to save whatever a plugin route answers with. The route names the file,
     * so the person gets the save dialog and chooses where it goes.
     * @param path - same-origin path to fetch and save.
     * @param name - suggested file name, when the caller knows one.
     */
    function downloadUrl(path, name) {
      if (typeof document === 'undefined') return
      const link = document.createElement('a')
      link.href = path
      if (typeof name === 'string' && name !== '') link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }

    /**
     * Read the file name a route asked for out of its Content-Disposition header, preferring
     * the UTF-8 form so a Chinese meeting name survives.
     * @param header - the header value, possibly null.
     * @returns the file name, or null when the header names nothing.
     */
    function fileNameFrom(header) {
      if (typeof header !== 'string') return null
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)
      if (encoded !== null) {
        try { return decodeURIComponent(encoded[1].trim()) } catch { /* fall through */ }
      }
      const plain = /filename="([^"]+)"/iu.exec(header)
      return plain === null ? null : plain[1]
    }

    /**
     * Hand a blob to the browser as a download, which is what opens the save dialog.
     * @param blob - the bytes to save.
     * @param name - the file name offered.
     */
    function saveBlob(blob, name) {
      if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      // Revoked late: revoking while the browser is still writing the file cancels it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    /**
     * Where a dropdown belongs, measured from the element that opened it: directly under it,
     * right-aligned to the panel, and no wider than the panel. It measures the event's own
     * element — never a ref, because the host Button forwards none, and a ref-based
     * measurement silently yields nothing.
     * @param element - the clicked element.
     * @param maxWidth - the widest the dropdown may become.
     * @returns fixed-position coordinates, or null when the element cannot be measured.
     */
    function measureUnder(element, maxWidth, height = 0) {
      if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null
      const section = typeof element.closest === 'function' ? element.closest('section') : null
      const box = (section ?? element).getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      const width = Math.min(maxWidth, Math.max(180, box.width - 16))
      // Hung off the button's bottom-LEFT corner: the left edges line up, and the panel's
      // width only caps how wide it may get. Clamped so it cannot leave the window.
      const viewport = typeof window === 'undefined' ? box.width : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      const left = Math.min(Math.max(8, rect.left), Math.max(8, viewport - width - 8))
      // A tall dropdown opened near the bottom would run off the window; flip it above the
      // button instead of letting the last rows become unreachable.
      const below = rect.bottom + 6
      const top = height > 0 && viewportHeight > 0 && below + height > viewportHeight - 8
        ? Math.max(8, rect.top - height - 6)
        : below
      return { top, left, width }
    }

    /**
     * One button: the host's Button when this host has one, the plugin's own markup
     * otherwise. The caller's props and handlers pass straight through, and a style object
     * the map does not know (a width, a flex) is still honoured.
     * @param props - usual button props, plus `variant` to force one.
     * @returns the button element.
     */
    function Btn(props) {
      const { style, variant, className, ...rest } = props
      const resolved = variant ?? BTN_VARIANT.get(style) ?? 'default'
      const extra = style !== undefined && !BTN_VARIANT.has(style) ? style : undefined
      if (HostButton !== null) {
        const preset = BTN_PRESET[resolved] ?? BTN_PRESET.default
        return h(HostButton, {
          ...rest,
          variant: preset.variant,
          size: preset.size,
          className: classNames(className, `mr-ui mr-layout-${resolved}`),
          style: extra,
        })
      }
      return h('button', { ...rest, className: classNames(className, `mr-btn mr-btn--${resolved}`), style: extra })
    }

    /**
     * One text field: the host's Input when this host has one, the plugin's own markup
     * otherwise. A multi-line field stays a native textarea either way, because the host
     * Input is single-line.
     * @param props - usual input props, plus `variant` to force one.
     * @returns the field element.
     */
    function Field(props) {
      const { style, variant, className, ...rest } = props
      // A checkbox is a control but not a *field*: it keeps its own shape.
      if (rest.type === 'checkbox' || rest.type === 'radio' || rest.type === 'file' || rest.type === 'range') {
        return h('input', { ...rest, className, style })
      }
      const resolved = variant ?? FIELD_VARIANT.get(style) ?? 'wide'
      const extra = style !== undefined && !FIELD_VARIANT.has(style) ? style : undefined
      if (resolved === 'area') {
        return h('textarea', { ...rest, className: classNames(className, 'mr-field mr-field--area'), style: extra })
      }
      if (HostInput !== null) {
        return h(HostInput, { ...rest, className: classNames(className, `mr-ufield mr-layout-${resolved}`), style: extra })
      }
      return h('input', { ...rest, className: classNames(className, `mr-field mr-field--${resolved}`), style: extra })
    }

    /**
     * One choice out of a list. Call sites keep the native-select contract — `value`,
     * `onChange(event)` and `<option>` children — while the control underneath is the
     * host's Menu when this host has one, and a native select otherwise. Keeping the old
     * contract is what lets nine pickers change at once without touching nine call sites.
     * @param props - usual select props, including the option children.
     * @returns the control.
     */
    function Picker(props) {
      const { style, variant, className, children, value, onChange, disabled, title, ...rest } = props
      const resolved = variant ?? FIELD_VARIANT.get(style) ?? 'tight'
      const extra = style !== undefined && !FIELD_VARIANT.has(style) ? style : undefined
      const [open, setOpen] = React.useState(false)
      const options = React.Children.toArray(children).map((child) => ({
        value: String(child.props.value ?? ''),
        label: child.props.children,
      }))
      if (HostMenu === null || HostButton === null) {
        return h('select', {
          ...rest,
          className: classNames(className, `mr-picker mr-picker--${resolved}`),
          style: extra,
          value,
          disabled,
          title,
          onChange,
        }, children)
      }
      const selected = String(value ?? '')
      const current = options.find((option) => option.value === selected)
      return h(HostMenu, {
        open,
        anchor: h(HostButton, {
          variant: 'outline',
          size: 'sm',
          disabled,
          title,
          className: classNames(className, `mr-choice mr-choice--${resolved}`),
          onClick: () => setOpen((wasOpen) => !wasOpen),
        // A value the list does not contain (a hand-picked due time) shows itself rather
        // than leaving the trigger blank.
        }, current === undefined ? (selected === '' ? '' : selected) : current.label),
        items: options.map((option) => ({ id: option.value, label: option.label })),
        selectedId: selected,
        // The handler keeps seeing a change event, exactly as the select gave it one.
        onSelect: (id) => {
          setOpen(false)
          if (id !== selected) onChange({ target: { value: id } })
        },
        onClose: () => setOpen(false),
        align: 'start',
        portal: true,
      })
    }

    /**
     * One dialog: the host's Modal when this host has one, the plugin's own overlay
     * otherwise. Title, body and footer arrive as props/nodes, so a call site does not care
     * which of the two is rendering — and the host version brings its own focus handling.
     * @param props - title, optional description, onClose, children (body) and footer (buttons).
     * @returns the dialog.
     */
    function Dialog(props) {
      const { title, description, onClose, children, footer, wide } = props
      // The body and the footer bring their own layout, so the host's Modal and the plugin's
      // own card both end up with the same stacked body and right-aligned, wrapping buttons.
      const body = h('div', { className: 'mr-dialog-body' }, children)
      const foot = footer === undefined ? undefined : h('div', { className: 'mr-dialog-foot' }, footer)
      if (HostModal !== null) {
        return h(HostModal, {
          open: true,
          onClose,
          title,
          description,
          children: body,
          footer: foot,
          // The wider card: every dialog uses the same width, so none looks like another app.
          className: wide === true ? 'mr-dialog-wide' : undefined,
        })
      }
      return h('div', {
        style: styles.setupOverlay,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
      }, [
        h('div', { key: 'card', style: wide === true ? styles.setupCardWide : styles.setupCard }, [
          h('h2', { key: 'title', style: styles.setupTitle }, title),
          description === undefined ? null : h('p', { key: 'hint', style: styles.note }, description),
          body,
          foot,
        ]),
      ])
    }

    /**
     * Render seconds as m:ss.
     * @param seconds - Offset in seconds.
     * @returns the clock text.
     */
    function clock(seconds) {
      const total = Math.max(0, Math.round(seconds))
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * Encode bytes as base64 for the JSON carrier.
     * @param bytes - Source bytes.
     * @returns base64 text without a data URL prefix.
     */
    function base64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return btoa(text)
    }

    /**
     * Measure one captured block's loudness.
     * @param block - Float samples of one worklet message.
     * @returns the root-mean-square amplitude.
     */
    function blockRms(block) {
      let sum = 0
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
      return block.length === 0 ? 0 : Math.sqrt(sum / block.length)
    }

    /**
     * Decide whether the buffered audio has reached a cue boundary.
     * @param active - Capture session.
     * @returns whether the buffered audio should be sent now.
     */
    function shouldFlush(active) {
      const rate = active.audio.sampleRate
      if (active.frames >= rate * CUES.maxSeconds) return true
      return active.frames >= rate * CUES.minSeconds && active.silenceFrames >= rate * CUES.silenceHoldSeconds
    }

    /**
     * Box-filter down to the target rate and quantize to little-endian PCM16.
     * @param samples - Captured float samples.
     * @param sourceRate - Sample rate of the capture context.
     * @returns PCM16 bytes at TARGET_RATE.
     */
    function toPcm16(samples, sourceRate) {
      const ratio = sourceRate / TARGET_RATE
      const frames = Math.floor(samples.length / ratio)
      const bytes = new Uint8Array(frames * 2)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < frames; i++) {
        const start = Math.floor(i * ratio)
        const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
        let sum = 0
        for (let j = start; j < end; j++) sum += samples[j]
        const value = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0))
        view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /**
     * Render seconds as an SRT timecode.
     * @param seconds - Offset in seconds.
     * @returns HH:MM:SS,mmm.
     */
    function timecode(seconds) {
      const ms = Math.max(0, Math.round(seconds * 1000))
      const pad = (value, width) => String(value).padStart(width, '0')
      const hours = Math.floor(ms / 3600000)
      const minutes = Math.floor(ms / 60000) % 60
      const secs = Math.floor(ms / 1000) % 60
      return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms % 1000, 3)}`
    }


    /**
     * Render a local date and time for file names.
     * @param at - Epoch milliseconds.
     * @returns `YYYY-MM-DD_HH-MM-SS` in local time.
     */
    function stampOf(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
      return `${day}_${time}`
    }

    /**
     * Split the terminology text into plain terms and literal replacement rules.
     * @param text - One entry per line; `wrong=right` lines become rules.
     * @returns the term list and the replacement pairs.
     */
    function parseTerms(text) {
      const terms = []
      const rules = []
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        const parts = line.split(/=|=>|→/)
        if (parts.length >= 2) {
          const from = parts[0].trim()
          const to = parts.slice(1).join('=').trim()
          if (from !== '' && to !== '') rules.push([from, to])
          else if (from !== '') terms.push(from)
          continue
        }
        terms.push(line)
      }
      return { terms, rules }
    }

    /**
     * Apply the literal replacement rules to the transcript for display and export.
     * The stored transcript keeps the recognizer's own output; these are the user's edits.
     * @param segments - Timed transcript segments as recognized.
     * @param rules - Replacement pairs.
     * @returns the segments with replacements applied.
     */
    function applyRules(segments, rules) {
      if (rules.length === 0) return segments
      return segments.map((segment) => {
        let text = seenOf(segment)
        for (const [from, to] of rules) text = text.split(from).join(to)
        // The recognition stays in `text`; a replacement only ever fills `revised`.
        return text === segment.text ? segment : { ...segment, revised: text }
      })
    }

    /**
     * The text a reader sees for one cue: the correction when there is one, else the
     * recognition as it came back.
     * @param segment - Timed transcript segment.
     * @returns the text to display.
     */
    function seenOf(segment) {
      return typeof segment.revised === 'string' ? segment.revised : segment.text
    }

    /**
     * Render the transcript as SubRip subtitles — the meeting record's timeline format.
     * @param segments - Timed transcript segments.
     * @returns the SRT document.
     */
    function srtOf(segments) {
      return segments.map((segment, index) => [
        String(index + 1),
        `${timecode(segment.start)} --> ${timecode(segment.end)}`,
        `${speakerPrefixOf(segment)}${seenOf(segment)}`,
        '',
      ].join('\n')).join('\n')
    }

    /**
     * Render one cue's speaker as a text prefix.
     * @param segment - Timed transcript segment.
     * @returns `S1: ` when the cue carries a speaker, else an empty string.
     */
    function speakerPrefixOf(segment) {
      return typeof segment.speaker === 'string' && segment.speaker !== '' ? `${segment.speaker}: ` : ''
    }

    /**
     * Parse a SubRip document into timed cues. A `S1: ` prefix becomes the cue's speaker.
     * @param srtText - The SRT document exported earlier.
     * @returns segments in time order.
     */
    function parseSrt(srtText) {
      const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
      const segments = []
      const blocks = srtText.replace(/\r\n?/gu, '\n').split(/\n{2,}/u)
      for (const block of blocks) {
        const lines = block.split('\n').filter((line) => line.trim() !== '')
        let timing = -1
        for (let i = 0; i < lines.length; i++) if (lines[i].includes('-->')) { timing = i; break }
        if (timing < 0) continue
        const match = lines[timing].match(/(\d{1,2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/u)
        if (match === null) continue
        const text = lines.slice(timing + 1).join(' ')
        const speakerMatch = text.match(/^(S\d+):\s*/u)
        segments.push({
          id: `s${segments.length + 1}`,
          start: toSeconds(match[1], match[2], match[3], match[4]),
          end: toSeconds(match[5], match[6], match[7], match[8]),
          speaker: speakerMatch === null ? '' : speakerMatch[1],
          text: speakerMatch === null ? text : text.slice(speakerMatch[0].length),
        })
      }
      return segments
    }

    /**
     * Render a recording with its transcript kept in step, like a lyric sheet: the cue
     * under the playhead highlights and scrolls into view, and clicking a cue seeks there.
     * Pure presentation over the native audio element; no external library.
     * @param props - src, segments, t, and whether a recording is present.
     * @returns the synchronized player.
     */
    function SyncedTranscriptPlayer(props) {
      const t = props.t
      const [playhead, setPlayhead] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      const [follow, setFollow] = React.useState(true)
      const audio = React.useRef(null)
      const rows = React.useRef([])

      const activeIndex = React.useMemo(() => {
        let index = -1
        for (let i = 0; i < props.segments.length; i++) if (props.segments[i].start <= playhead) index = i
        return index
      }, [playhead, props.segments])

      React.useEffect(() => {
        if (!playing || !follow || activeIndex < 0) return
        const row = rows.current[activeIndex]
        if (row !== null && row !== undefined) row.scrollIntoView({ block: 'nearest' })
      }, [activeIndex, follow, playing])

      const seekTo = React.useCallback((seconds) => {
        const element = audio.current
        if (element === null) return
        element.currentTime = seconds
        setPlayhead(seconds)
      }, [])

      return h('div', { style: styles.player }, [
        props.src === ''
          ? null
          : h('audio', {
            key: 'audio',
            ref: audio,
            controls: true,
            preload: 'none',
            style: styles.audio,
            src: props.src,
            onTimeUpdate: (event) => setPlayhead(event.currentTarget.currentTime),
            onPlay: () => setPlaying(true),
            onPause: () => setPlaying(false),
            onEnded: () => setPlaying(false),
          }),
        h('div', { key: 'meta', style: styles.row }, [
          h(Btn, {
            key: 'follow',
            type: 'button',
            style: follow ? styles.buttonActive : styles.button,
            onClick: () => setFollow((value) => !value),
          }, t('follow')),
          h('span', { key: 'count', style: styles.status }, `${props.segments.length} ${t('segments')}`),
        ]),
        h('div', { key: 'list', style: styles.playerList }, props.segments.map((segment, index) => h('div', {
          key: segment.id,
          ref: (element) => { rows.current[index] = element },
          style: index === activeIndex ? styles.segmentActive : styles.segment,
          className: 'mr-hover',
          title: t('seekHint'),
          onClick: () => { if (props.src !== '') seekTo(segment.start) },
        }, [
          h('span', { key: 'time', style: styles.stamp }, clock(segment.start)),
          segment.speaker === '' ? null : h('span', { key: 'speaker', style: styles.chip }, segment.speaker),
          h('span', {
            key: 'text',
            // A corrected cue shows the recognition it replaced, so nothing is hidden.
            title: seenOf(segment) === segment.text ? undefined : segment.text,
          }, seenOf(segment)),
          // Only where there is a meeting to write to: the hub previews finished records and
          // passes no handler.
          props.onToTask === undefined ? null : h(Btn, {
            key: 'toTask',
            type: 'button',
            style: styles.smallButton,
            onClick: (event) => {
              // The row itself seeks the player; making an assignment must not also seek.
              event.stopPropagation()
              props.onToTask(seenOf(segment))
            },
          }, t('inkToTask')),
        ]))),
      ])
    }


    /**
     * Compose the end-of-meeting correction request: the term list plus the record,
     * ready to paste into a conversation with the agent.
     * @param srt - The SRT record.
     * @param terms - Meeting terminology.
     * @returns the prompt text.
     */
    function correctionPromptOf(srt, terms) {
      const list = terms.length === 0 ? '（未提供）' : terms.join('、')
      return [
        '以下是我用本地语音模型转写的会议实录（SRT 格式）。',
        '',
        `术语表（人名 / 公司 / 项目 / 专业词）：${list}`,
        '',
        '请按上下文订正错别字，尤其是人名与术语；保持 SRT 的时间轴与编号不变。输出两部分：',
        '1. 修订后的完整 SRT；',
        '2. 改动对照表（原文 → 改为 → 依据）。',
        '',
        '实录：',
        '```srt',
        srt.trimEnd(),
        '```',
      ].join('\n')
    }

    /**
     * Turn a failed plugin request into an error that carries its HTTP status.
     *
     * The status has to travel with the error: "this route is not registered" (404 — a broken or
     * half-installed plugin) and "the service is busy" (5xx) need completely different answers,
     * and the message text alone cannot tell them apart.
     * @param value - decoded body, if any.
     * @param response - the failed response.
     * @returns the error to throw.
     */
    function requestFailure(value, response) {
      const message = value !== null && typeof value === 'object' && typeof value.error === 'string' && value.error !== ''
        ? value.error
        : `请求失败 (${response.status})`
      const failure = new Error(message)
      failure.status = response.status
      return failure
    }

    /**
     * POST JSON to the host half and decode the JSON reply.
     * @param route - Route under the plugin prefix.
     * @param body - JSON-serializable body.
     * @returns the decoded reply.
     */
    async function post(route, body) {
      const response = await fetch(`/meeting-room${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try { value = JSON.parse(text) } catch { value = {} }
      }
      if (!response.ok) throw requestFailure(value, response)
      return value
    }

    /**
     * GET JSON from the host half and decode the JSON reply.
     * @param route - Route under the plugin prefix, query string included.
     * @returns the decoded reply.
     */
    async function get(route) {
      const response = await fetch(`/meeting-room${route}`)
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try { value = JSON.parse(text) } catch { value = {} }
      }
      if (!response.ok) throw requestFailure(value, response)
      return value
    }

    /** Priorities a task may carry, in the order the picker shows them. */
    const TASK_PRIORITY_VALUES = ['high', 'normal', 'low']

    /** Locale keys for the three review roles. */
    const ROLE_LABEL_KEYS = { host: 'roleHost', attendee: 'roleAttendee', observer: 'roleObserver' }

    /** Locale keys for task priorities. */
    const PRIORITY_KEYS = { high: 'priorityHigh', normal: 'priorityNormal', low: 'priorityLow' }

    /** Point kinds a reader can choose between when editing. */
    const POINT_KIND_VALUES = ['decision', 'point', 'risk', 'question']
    /** Meeting kinds the panel offers, and the copy each one uses. */
    const KIND_VALUES = ['', 'briefing', 'review', 'weekly', 'monthly']
    const KIND_LABEL_KEYS = { '': 'kindGeneral', briefing: 'kindBriefing', review: 'kindReview', weekly: 'kindWeekly', monthly: 'kindMonthly' }
    // The one-click distillation each type offers (§3.1–§3.4): a button label and the recipe
    // it hands the agent, the same words a person would type in the conversation.
    // §5.5 names the general type "临时会议" where §2.1 calls it 通用; the start dialog uses the
// §5.5 wording, the panel and filters keep the data model's name.
    const NAMING_LABEL_KEYS = { ...KIND_LABEL_KEYS, '': 'kindAdhoc' }
    const DISTILL_LABEL_KEYS = { briefing: 'distillBriefing', review: 'distillReview', weekly: 'distillWeekly', monthly: 'distillMonthly' }
    const DISTILL_PROMPT_KEYS = { briefing: 'distillBriefingPrompt', review: 'distillReviewPrompt', weekly: 'distillWeeklyPrompt', monthly: 'distillMonthlyPrompt' }

/**
 * The local calendar bucket a meeting falls into, for the management page's day / week /
 * month grouping (FEATURES §5.2). The weekly bucket is the ISO week (Monday-based), the
 * same definition the host derives `period` from, so a group heading matches the badge the
 * panel shows for that meeting.
 * @param startedAt - when the meeting started, in milliseconds.
 * @param unit - 'day', 'week' or 'month'.
 * @returns the bucket key, e.g. 2026-10-19, 2026-W43 or 2026-10.
 */
function periodBucketOf(startedAt, unit) {
  const date = new Date(startedAt)
  const pad = (value) => String(value).padStart(2, '0')
  if (unit === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  if (unit === 'week') {
    // ISO week: the Monday of this date's week, then the Thursday of that week decides the
    // ISO year (a week can straddle New Year, and the year must be the ISO one).
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const thursday = new Date(monday)
    thursday.setDate(monday.getDate() + 3)
    const firstThursday = new Date(thursday.getFullYear(), 0, 4)
    const week = 1 + Math.round((((thursday - firstThursday) / 86400000) - 3 + ((firstThursday.getDay() + 6) % 7)) / 7)
    return `${thursday.getFullYear()}-W${pad(week)}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

    /** Id of the datalist that offers this meeting's speaker names as owners. */
    const OWNER_LIST_ID = 'meeting-room-owners'

    /** Delivery choices for confirmed assignments, and their locale keys. */
    const PUSH_MODE_VALUES = ['group', 'work', 'both']
    const PUSH_MODE_KEYS = { group: 'pushModeGroup', work: 'pushModeWork', both: 'pushModeBoth' }

    /** Cloud providers the settings page offers, and their locale keys. */
    const CLOUD_PROVIDER_VALUES = ['off', 'openai-compatible', 'custom']
    const CLOUD_PROVIDER_KEYS = { off: 'cloudOff', 'openai-compatible': 'cloudOpenAi', custom: 'cloudCustom' }

    /** Settings groups, in the order a person configures them: what leaves the machine
     *  first (push, cloud), then how this installation scores and writes, then voices. */
    const SETTINGS_TABS = [
      ['push', 'settingsTabPush'],
      ['cloud', 'settingsTabCloud'],
      ['transcript', 'settingsTabTranscript'],
      ['speaker', 'settingsTabSpeaker'],
      ['weights', 'settingsTabWeights'],
      ['templates', 'settingsTabTemplates'],
    ]

    /** Hub sections, in the order a user meets them. */
    const HUB_TAB_VALUES = ['records', 'models', 'terms', 'settings', 'people']
    const HUB_TAB_KEYS = { records: 'hubTabRecords', models: 'hubTabModels', terms: 'hubTabTerms', settings: 'hubTabSettings', people: 'hubTabPeople' }

    /** Panel body sections: the record first, then what was read out of it. */
    const BODY_TAB_VALUES = ['transcript', 'minutes', 'points', 'tasks', 'names']
    const BODY_TAB_KEYS = { transcript: 'panelTabTranscript', minutes: 'panelTabMinutes', points: 'points', tasks: 'tasks', names: 'panelTabSpeakers' }

    /** The sentinel that switches the due field from a quick choice to a free picker. */
    const CUSTOM_DUE = '__custom__'

    /**
     * Quick due choices, computed against today so the list stays meaningful: choosing one
     * resolves its date immediately instead of asking for one.
     * @returns one entry per choice, unset first.
     */
    function duePresets() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      const at = (days, hour) => stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0))
      const weekday = now.getDay()
      // `|| 7` keeps "this Friday" pointing forward when today already is Friday.
      const friday = (5 - weekday + 7) % 7 || 7
      const monday = (8 - weekday) % 7 || 7
      return [
        { value: '', key: 'dueUnset' },
        { value: at(0, 18), key: 'dueToday' },
        { value: at(1, 9), key: 'dueTomorrowMorning' },
        { value: at(1, 18), key: 'dueTomorrow' },
        { value: at(friday, 18), key: 'dueFriday' },
        { value: at(monday, 9), key: 'dueMonday' },
        { value: stamp(new Date(now.getFullYear(), now.getMonth() + 1, 0, 18, 0)), key: 'dueMonthEnd' },
      ]
    }

    /**
     * Turn a stored due date into the value a datetime picker needs. Anything the picker
     * cannot represent — free text such as 周五 — falls back to today at 18:00, which is the
     * default the user sees already selected.
     * @param due - The stored due text.
     * @returns a `YYYY-MM-DDTHH:mm` value.
     */
    function dueDraftOf(due) {
      const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u.exec(String(due ?? '').trim())
      if (match !== null) return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T18:00`
    }

    /**
     * Names to offer as task owners or speaker names: everyone on the roster plus every voice
     * already named, so one person is not typed twice.
     * @param speakers - Voice label to name map.
     * @param people - Meeting roster.
     * @returns unique names, roster first.
     */
    function ownerSuggestions(speakers, people) {
      const names = []
      for (const person of people) {
        if (typeof person.name === 'string' && person.name !== '' && !names.includes(person.name)) names.push(person.name)
      }
      for (const name of Object.values(speakers)) {
        if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
      }
      return names
    }

    /**
     * Read the stored terminology list, tolerating storage being unavailable.
     * @returns the stored text, or an empty string.
     */
    function readTerms() {
      try {
        return localStorage.getItem(TERMS_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /**
     * Render the meeting controls, the terminology list, and the live transcript.
     * @param props - Session-scoped slot props plus this namespace's copy.
     * @returns the meeting panel.
     */
    /**
     * Recording state shared by every panel. The capture lives here rather than inside a
     * component, so switching the main panel, closing the dock, or a panel remount never
     * stops a meeting that is already running.
     */
    const recorder = {
      /** Capture session while recording, else null. */
      active: null,
      phase: 'idle',
      meetingId: '',
      audioName: '',
      startedAt: 0,
      seconds: 0,
      segments: [],
      /** True while this start came from the agent's /record request, not a person's click. */
      autoStart: false,
      listeners: new Set(),
      /** Notify every subscribed panel that recorder state moved. */
      emit() { for (const listener of this.listeners) listener() },
      /**
       * Subscribe one panel to recorder changes.
       * @param listener - Called after every change.
       * @returns the unsubscribe function.
       */
      subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    }

    /**
     * The start page's "开始会议" card hands the panel a begin request before the tab
     * mounts. A module-level flag plus a window event covers both orders: a panel already
     * open hears the event, a panel that mounts afterwards consumes the flag.
     */
    const guideBegin = { pending: false, opened: false, deadline: 0, target: '' }

    /**
     * Read the shared recorder inside a component, re-rendering on every change.
     * @returns the recorder object itself.
     */
    function useRecorder() {
      const [, force] = React.useState(0)
      React.useEffect(() => recorder.subscribe(() => force((value) => value + 1)), [])
      return recorder
    }

    function MeetingPanel(props) {
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const rec = useRecorder()
      const phase = rec.phase
      const segments = rec.segments
      const seconds = rec.seconds
      const meetingId = rec.meetingId
      const startedAt = rec.startedAt
      const audioName = rec.audioName
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [termsText, setTermsText] = React.useState(readTerms)
      const [speaker, setSpeaker] = React.useState({ phase: 'unprepared', message: '', completedBytes: 0, totalBytes: 0 })
      /**
       * Starts UNRESOLVED, never "ready". The probe below has not answered yet, and a click in
       * that window used to take the record-now path and fail on an unprepared model — the click
       * was spent and the person had to click again. Not-ready is the safe default: a click then
       * goes through the prepare chain, which ends in recording either way.
       */
      const [speech, setSpeech] = React.useState({ ready: false, phase: 'checking', requesting: false, completedBytes: 0, totalBytes: 0 })
      // A 'Start' click that an unprepared model blocked: once the enable/download chain
      // reports ready, recording begins automatically instead of asking for another click.
      const [pendingStart, setPendingStart] = React.useState(false)

      // Check transcription readiness on mount; follow any in-progress download.
      React.useEffect(() => {
        let live = true
        void (async () => {
          let s = await readSpeechState()
          if (!live) return
          setSpeech({ ready: s.ready, phase: s.phase, requesting: s.busy, completedBytes: s.completedBytes, totalBytes: s.totalBytes })
          while (live && s.busy) {
            await new Promise((r) => setTimeout(r, 1500))
            if (!live) return
            s = await readSpeechState()
            if (live) setSpeech({ ready: s.ready, phase: s.phase, requesting: s.busy, completedBytes: s.completedBytes, totalBytes: s.totalBytes })
          }
        })()
        return () => { live = false }
      }, [])

      const prepareSpeech = React.useCallback(async () => {
        setSpeech((c) => ({ ...c, requesting: true }))
        setError('')
        try {
          await post('/speech/prepare', {})
          const dl = Date.now() + 600000
          let lastPhase = ''
          let lastBytes = -1
          let lastProgress = Date.now()
          for (;;) {
            const s = await readSpeechState()
            // `requesting` mirrors what the service reports, never "not ready yet": claiming a
            // download that is not happening is what made a stall look like progress.
            setSpeech({ ready: s.ready, phase: s.phase, requesting: s.busy, completedBytes: s.completedBytes, totalBytes: s.totalBytes })
            if (s.ready) return
            // Terminal states end the wait at once, each with its own answer: a route that does
            // not exist will never become ready, and saying so beats waiting ten minutes.
            if (s.phase === 'missing' || s.phase === 'unavailable' || s.phase === 'failed') {
              setPendingStart(false)
              setSpeech({ ready: false, phase: s.phase, requesting: false, completedBytes: 0, totalBytes: 0 })
              setError(s.phase === 'missing'
                ? t('speechRouteMissing')
                : (s.message !== '' ? s.message : t('setupPrepareFailed')))
              return
            }
            // A phase that does not move and bytes that do not arrive is a stall: report it
            // instead of sitting on the full deadline while the person waits for a recording.
            if (s.phase !== lastPhase || s.completedBytes !== lastBytes) {
              lastPhase = s.phase
              lastBytes = s.completedBytes
              lastProgress = Date.now()
            }
            if (Date.now() - lastProgress > 90000) {
              setPendingStart(false)
              setSpeech({ ready: false, phase: 'failed', requesting: false, completedBytes: 0, totalBytes: 0 })
              setError(`${t('setupPrepareStalled')}（${s.phase}）`)
              return
            }
            if (Date.now() >= dl) {
              setPendingStart(false)
              setSpeech({ ready: false, phase: 'failed', requesting: false, completedBytes: 0, totalBytes: 0 })
              setError(t('setupPrepareFailed'))
              return
            }
            await new Promise((r) => setTimeout(r, 1500))
          }
        } catch (e) {
          setPendingStart(false)
          setSpeech((c) => ({ ...c, requesting: false }))
          setError(e?.status === 404 ? t('speechRouteMissing') : (e instanceof Error ? e.message : String(e)))
        }
      }, [t])

      const [points, setPoints] = React.useState([])
      const [tasks, setTasks] = React.useState([])
      const [notes, setNotes] = React.useState([])
      /** How the person using this panel took part; it steers the review prompt. */
      const [role, setRole] = React.useState('')
      /**
       * The shared roster, used only to suggest task owners here. The roster itself is edited
       * in the meeting hub, because it describes the organisation rather than one meeting.
       */
      const [people, setPeople] = React.useState([])
      /** Documents the agent stored in this meeting (reviews, summaries). */
      const [documents, setDocuments] = React.useState([])
      const [openDocument, setOpenDocument] = React.useState(null)
      /** Which kind of meeting content the panel is showing. */
      const [bodyTab, setBodyTab] = React.useState('transcript')
      /** Whether the occasional actions are unfolded. */
      const [moreOpen, setMoreOpen] = React.useState(false)
      /** Whether the speaker-naming fields are unfolded. */
      const [namesOpen, setNamesOpen] = React.useState(false)
      /** Whether a whole-meeting re-identification is running. */
      const [relabeling, setRelabeling] = React.useState(false)
      /** Per-type distillation wording saved in settings (§9 P4); empty = built-in. */
      const [templates, setTemplates] = React.useState({})
      React.useEffect(() => {
        let live = true
        void get('/webhooks').then(
          (value) => { if (live && value !== null && typeof value === 'object') setTemplates(value.templates ?? {}) },
          () => { /* settings unreadable: the built-in wording still works */ },
        )
        return () => { live = false }
      }, [])
      /** Tasks whose row is showing the free date-and-time picker rather than a quick choice. */
      const [customDueIds, setCustomDueIds] = React.useState([])
      /** Voice labels found in this meeting and the real names assigned to them. */
      const [labels, setLabels] = React.useState([])
      const [speakers, setSpeakers] = React.useState({})
      /** Names the voice library recognises but has NOT written: a person accepts them or not. */
      const [suggestions, setSuggestions] = React.useState([])
      /** The monthly review's score table (FEATURES.md §5.1). */
      const [scores, setScores] = React.useState([])
      /**
       * Unsaved text per score field, keyed `person:field`. The inputs are controlled by
       * these drafts so typing is never blocked by the round-trip, and a value the host
       * clamps is shown as stored once the field loses focus.
       */
      const [scoreDrafts, setScoreDrafts] = React.useState({})
      /** The person being added to that table by hand. */
      const [newScorePerson, setNewScorePerson] = React.useState('')
      const [draftNames, setDraftNames] = React.useState({})
      const [playhead, setPlayhead] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      /** The meeting's name, type and derived period (FEATURES.md §2.1). */
      const [meta, setMeta] = React.useState({ kind: '', period: '', title: '', summary: '' })
      /** The start-of-recording name dialog; null when it is closed (§5.5). */
      const [namePrompt, setNamePrompt] = React.useState(null)
      /** The same kind's previous and next meeting, for the title row's series navigation (§5.1). */
      const [series, setSeries] = React.useState({ prev: null, next: null })
      /** What the previous day's review left open, shown while a briefing is prepared (§3.1). */
      const [carry, setCarry] = React.useState({ review: null, items: [] })
      /** Whether capture is paused, and since when (FEATURES.md §5.6). */
      // Seeded from the shared recorder: the capture outlives a panel remount, so a
// remounted panel must show "继续" when the meeting is still paused (§5.6).
      const [paused, setPaused] = React.useState(recorder.active !== null && recorder.active.paused === true)
      const pausedAt = React.useRef(0)
      const pauseWarned = React.useRef(false)
      /** The meeting picker: open flag, query and the slices loaded so far (FEATURES.md §5.4). */
      const [picker, setPicker] = React.useState({ open: false, query: '', rows: [], total: 0, loading: false, loadingMore: false })
      /** The same state for callbacks, so paging always sees the live list. */
      const pickerRef = React.useRef(null)
      pickerRef.current = picker
      /** True while an IME is composing: the text in the field is not a search yet. */
      const composingRef = React.useRef(false)
      /** The short pause between a keystroke and the search it triggers. */
      const searchTimer = React.useRef(0)
      /** The historical meeting the panel is viewing; null means this session's own. */
      const [viewed, setViewed] = React.useState(null)
      /**
       * The same fact for callbacks that must not be re-created on every switch: the guard
       * has to see the CURRENT mode even when the callback was built earlier (§5.4).
       */
      const viewedRef = React.useRef(null)
      viewedRef.current = viewed
      /** Whether the transcript keeps the newest cue in view (§5.7). */
      const [follow, setFollow] = React.useState(true)
      /**
       * Toasts: short-lived notices for work that takes long enough to be worth watching —
       * packaging a meeting, for instance. The host's own Toast renders them when this host
       * has one; otherwise a plain card does.
       */
      const [toasts, setToasts] = React.useState([])
      const toastSeq = React.useRef(0)
      const toast = React.useCallback((text, options = {}) => {
        toastSeq.current += 1
        const id = toastSeq.current
        setToasts((current) => [...current, { id, text, sticky: options.sticky === true }])
        // The host Toast calls onDone when it fades; this covers the fallback and a host that
        // never does. A sticky toast has no timer: work whose end is unknown (stopping a long
        // recording) must keep saying what it is doing, not vanish after eight seconds.
        if (options.sticky !== true) {
          setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 8000)
        }
        return id
      }, [])
      const updateToast = React.useCallback((id, text) => {
        setToasts((current) => current.map((item) => (item.id === id ? { ...item, text } : item)))
      }, [])
      const dismissToast = React.useCallback((id) => {
        setToasts((current) => current.filter((item) => item.id !== id))
      }, [])
      const followRef = React.useRef(true)
      /** Cues ticked for merging into one assignment, and the box that holds them. */
      const [selectedCueIds, setSelectedCueIds] = React.useState(() => new Set())
      const listRef = React.useRef(null)
      /** Where the meeting dropdown sits: measured from the panel, so it spans its width. */
      const [pickerRect, setPickerRect] = React.useState(null)
      /** Where the overflow menu sits, measured from the button that opened it. */
      const [moreRect, setMoreRect] = React.useState(null)
      /** The button that opened it, kept as a plain node so it can be measured again. */
      const moreAnchor = React.useRef(null)
      /** The switch guard: the row to open once the countdown saved the current meeting. */
      const [switchPrompt, setSwitchPrompt] = React.useState(null)
      const audio = React.useRef(null)
      const rows = React.useRef([])
      const noteSeq = React.useRef(0)
      /** Whether the terminology dialog is open (it used to be a tab in the note pad). */
      const [termsOpen, setTermsOpen] = React.useState(false)
      /** The About dialog, and what this installation reports about itself. */
      const [aboutOpen, setAboutOpen] = React.useState(false)
      const [about, setAbout] = React.useState({ version: '', name: '', author: '' })

      // The About dialog asks the host what is installed, so it can never claim a version
      // this build is not.
      React.useEffect(() => {
        if (aboutOpen !== true) return undefined
        let live = true
        void (async () => {
          try {
            const value = await get('/version')
            if (!live) return
            setAbout({
              version: typeof value.version === 'string' ? value.version : '',
              name: typeof value.name === 'string' ? value.name : 'dsh-meeting-room',
              author: typeof value.author === 'string' ? value.author : '',
            })
          } catch {
            // Keep whatever is known: the dialog still shows the author and the address.
          }
        })()
        return () => { live = false }
      }, [aboutOpen])
      const [notesOpen, setNotesOpen] = React.useState(false)
      const [helpOpen, setHelpOpen] = React.useState(false)

      // These write through to the shared recorder: the capture callback keeps updating
      // them after this panel unmounts, so returning to the panel shows the whole meeting.
      const setPhase = React.useCallback((value) => { recorder.phase = value; recorder.emit() }, [])
      const setSegments = React.useCallback((value) => { recorder.segments = value; recorder.emit() }, [])
      const setSeconds = React.useCallback((value) => { recorder.seconds = value; recorder.emit() }, [])
      const setMeetingId = React.useCallback((value) => { recorder.meetingId = value; recorder.emit() }, [])
      const setStartedAt = React.useCallback((value) => { recorder.startedAt = value; recorder.emit() }, [])
      const setAudioName = React.useCallback((value) => { recorder.audioName = value; recorder.emit() }, [])

      /**
       * Adopt this session's meeting from the host. The panel keeps no durable state, so
       * after a reload this is the only way it learns which meeting it is looking at.
       * @returns whether a meeting was found.
       */
      const adopt = React.useCallback(async () => {
        if (sessionId === '') return null
        try {
          const value = await get(`/current?sessionId=${encodeURIComponent(sessionId)}`)
          if (value.meeting === null) return null
          setMeetingId(value.meeting.meetingId)
          setStartedAt(value.meeting.startedAt)
          setSeconds(value.meeting.seconds)
          setSegments(value.meeting.segments)
          setAudioName(value.meeting.audioName ?? '')
          setPoints(value.meeting.points)
          setTasks(value.meeting.tasks)
          if (Array.isArray(value.meeting.scores)) setScores(value.meeting.scores)
          // A reload or a session switch is exactly when this payload is the ONLY source of
          // what the panel shows. Leaving these out is what made a reopened meeting claim it
          // had never identified a speaker: the labels were in the answer, unread.
          if (Array.isArray(value.meeting.notes)) setNotes(value.meeting.notes)
          if (Array.isArray(value.meeting.labels)) setLabels(value.meeting.labels)
          setSuggestions(Array.isArray(value.meeting.suggestions) ? value.meeting.suggestions : [])
          if (value.meeting.speakers !== null && typeof value.meeting.speakers === 'object') setSpeakers(value.meeting.speakers)
          if (typeof value.meeting.role === 'string') setRole(value.meeting.role)
          if (Array.isArray(value.meeting.documents)) setDocuments(value.meeting.documents)
          if (typeof value.meeting.terms === 'string' && value.meeting.terms !== '') setTermsText(value.meeting.terms)
          setMeta({
            kind: typeof value.meeting.kind === 'string' ? value.meeting.kind : '',
            period: typeof value.meeting.period === 'string' ? value.meeting.period : '',
            title: typeof value.meeting.title === 'string' ? value.meeting.title : '',
            summary: typeof value.meeting.summary === 'string' ? value.meeting.summary : '',
          })
          return value.meeting
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        }
      }, [sessionId])

      React.useEffect(() => { void adopt() }, [adopt])

      // The carry-over reminder follows the meeting's identity and type, so it reloads
      // whenever either changes (FEATURES.md §3.1).
      React.useEffect(() => {
        if (meetingId === '') {
          setCarry({ review: null, items: [] })
          return undefined
        }
        let live = true
        void (async () => {
          if (meta.kind !== 'briefing') {
            if (live) setCarry({ review: null, items: [] })
            return
          }
          try {
            const value = await get(`/carryover?meetingId=${encodeURIComponent(meetingId)}`)
            if (live) setCarry({ review: value.review ?? null, items: Array.isArray(value.items) ? value.items : [] })
          } catch {
            // The reminder is optional: a failure simply leaves it hidden.
          }
        })()
        return () => { live = false }
      }, [meetingId, meta.kind])

      // Series navigation: the same kind's previous and next meeting (§5.1). It is part of
      // the title row, so a briefing can step back through the week without searching — and
      // it is reloaded whenever either the meeting or its type changes.
      React.useEffect(() => {
        if (meetingId === '' || meta.kind === '') {
          setSeries({ prev: null, next: null })
          return undefined
        }
        let live = true
        void (async () => {
          try {
            const value = await get(`/series?meetingId=${encodeURIComponent(meetingId)}`)
            if (live) setSeries({ prev: value.prev ?? null, next: value.next ?? null })
          } catch {
            // Optional navigation: a failure simply leaves the arrows hidden.
          }
        })()
        return () => { live = false }
      }, [meetingId, meta.kind])

      /**
       * Pull the stored cues, points, and tasks — including ones the agent wrote.
       * @returns the stored points and tasks, or undefined when no meeting is reachable.
       */
      const refreshAnalysis = React.useCallback(async () => {
        setError('')
        let id = meetingId
        if (id === '') {
          // Nothing recorded in this panel yet; the meeting may belong to an earlier page.
          const adopted = await adopt()
          if (adopted === null) {
            setNote(t('noMeeting'))
            return undefined
          }
          id = adopted.meetingId
        }
        try {
          const value = await get(`/state?meetingId=${encodeURIComponent(id)}`)
          setSegments(value.segments)
          setSeconds(value.seconds)
          if (Array.isArray(value.points)) setPoints(value.points)
          if (Array.isArray(value.tasks)) setTasks(value.tasks)
          if (Array.isArray(value.notes)) setNotes(value.notes)
          if (typeof value.audioName === 'string') setAudioName(value.audioName)
          if (typeof value.role === 'string') setRole(value.role)
          if (value.speakers !== null && typeof value.speakers === 'object') setSpeakers(value.speakers)
          if (Array.isArray(value.labels)) setLabels(value.labels)
          if (Array.isArray(value.documents)) setDocuments(value.documents)
          setMeta({
            kind: typeof value.kind === 'string' ? value.kind : '',
            period: typeof value.period === 'string' ? value.period : '',
            title: typeof value.title === 'string' ? value.title : '',
            // The summary is read back here too, so a model-polished one shows up on refresh.
            summary: typeof value.summary === 'string' ? value.summary : '',
          })
          if (Array.isArray(value.scores)) setScores(value.scores)
          return {
            points: Array.isArray(value.points) ? value.points : [],
            tasks: Array.isArray(value.tasks) ? value.tasks : [],
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return undefined
        }
      }, [adopt, meetingId, t])

      /**
       * Make sure this session has a meeting to store notes and tasks in. A session that
       * never recorded still gets a container, so writing a note before pressing start works
       * and a later recording joins the same record.
       * @returns the meeting id, or an empty string when the panel has no session.
       */
      const ensureMeeting = React.useCallback(async () => {
        if (meetingId !== '') return meetingId
        const adopted = await adopt()
        if (adopted !== null) return adopted.meetingId
        if (sessionId === '') return ''
        try {
          const reply = await post('/ensure', { sessionId, terms: termsText })
          if (typeof reply.meetingId === 'string' && reply.meetingId !== '') {
            setMeetingId(reply.meetingId)
            return reply.meetingId
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        return ''
      }, [adopt, meetingId, sessionId, termsText])

      /**
       * Re-identify the whole meeting from its recording, then take the settled labels
       * and names back into the panel. This is the repair path for cues the online pass
       * missed (the voice model was still downloading, or its worker died mid-meeting).
       */
      const relabelRecording = React.useCallback(async () => {
        if (relabeling) return
        setError('')
        // A past meeting can be re-labelled too (§5.1): address the meeting on screen, so
        // the repair never lands on the session's own record (§5.4).
        const viewing = viewedRef.current
        const id = viewing !== null ? viewing.meetingId : await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        setRelabeling(true)
        setNote(t('speakerRelabeling'))
        try {
          const reply = await post('/relabel', { meetingId: id })
          if (Array.isArray(reply.segments)) setSegments(reply.segments)
          if (reply.speakers !== null && typeof reply.speakers === 'object') setSpeakers(reply.speakers)
          if (Array.isArray(reply.labels)) setLabels(reply.labels)
          setNote(`${t('speakerRelabelDone')}${typeof reply.judged === 'number' ? ` · ${reply.judged}` : ''}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setRelabeling(false)
        }
      }, [ensureMeeting, relabeling, t])

      /**
       * Store the meeting's type and/or name. The host derives the period from the type,
       * so the panel never asks the user for it (FEATURES.md §2.1).
       * @param patch - `kind` and/or `title` to store.
       * @returns whether the write landed.
       */
      const saveMeta = React.useCallback(async (patch) => {
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return false
        }
        try {
          const reply = await post('/kind', { meetingId: id, ...patch })
          setMeta((current) => ({
            kind: typeof reply.kind === 'string' ? reply.kind : '',
            period: typeof reply.period === 'string' ? reply.period : '',
            title: typeof reply.title === 'string' ? reply.title : '',
            // The kind route does not carry the summary; keeping it avoids a visible blank.
            summary: current.summary,
          }))
          return true
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return false
        }
      }, [ensureMeeting, t])


      /**
       * Remember how this person took part, so the review prompt matches their seat.
       * @param next - One of host, attendee, observer.
       */
      const chooseRole = React.useCallback(async (next) => {
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        setRole(next)
        try {
          await post('/role', { meetingId: id, role: next })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /**
       * Send the whole transcript to the conversation and ask for a review written from the
       * chosen role, which the agent returns as an archiveable document.
       */
      const review = React.useCallback(async () => {
        setError('')
        setNote('')
        if (sessionId === '') {
          setError(t('reviewNoSession'))
          return
        }
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        const seat = role === '' ? 'attendee' : role
        try {
          const reply = await get(`/transcript?meetingId=${encodeURIComponent(id)}&limit=4000`)
          const transcript = typeof reply.text === 'string' ? reply.text : ''
          if (transcript.trim() === '') {
            setNote(t('minutesEmpty'))
            return
          }
          const focusKey = seat === 'host' ? 'roleHostFocus' : seat === 'observer' ? 'roleObserverFocus' : 'roleAttendeeFocus'
          const sectionKey = seat === 'host' ? 'roleHostSection' : seat === 'observer' ? 'roleObserverSection' : 'roleAttendeeSection'
          const prompt = t('reviewPrompt')
            .replaceAll('{role}', ROLE_LABEL_KEYS[seat] === undefined ? seat : t(ROLE_LABEL_KEYS[seat]))
            .replaceAll('{focus}', t(focusKey))
            .replaceAll('{section}', t(sectionKey))
            .replaceAll('{transcript}', transcript)
          const asked = await props.askText(sessionId, prompt)
          if (!asked.ok) {
            setError(`${t('reviewNoSession')}: ${asked.error}`)
            return
          }
          setNote(t('reviewSending'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, props, role, sessionId, t])


      /**
       * Attach a real name to a voice label. The label itself never changes, so assigned
       * names survive the end-of-meeting re-clustering and stay attached to the voice.
       * @param label - Voice label such as S1.
       * @param name - The person's name; empty clears the assignment.
       */
      const nameSpeaker = React.useCallback(async (label, name) => {
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/speaker/name', { meetingId: id, label, name })
          if (reply.speakers !== null && typeof reply.speakers === 'object') setSpeakers(reply.speakers)
          if (Array.isArray(reply.segments)) setSegments(reply.segments)
          // An accepted name retires its own suggestion; the host has learned the voice by now.
          setSuggestions((current) => current.filter((item) => !(item.label === label && item.name === name)))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])


      /** Load the shared roster once, to suggest owners in task editing. */
      const reloadPeople = React.useCallback(async () => {
        try {
          const reply = await get('/people')
          if (Array.isArray(reply.people)) setPeople(reply.people)
        } catch {
          // The roster is a convenience: an unreadable one simply leaves the suggestions out.
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const reply = await get('/people')
            if (!cancelled && Array.isArray(reply.people)) setPeople(reply.people)
          } catch {
            // Owner suggestions are optional; an unreadable roster just leaves them empty.
          }
        })()
        return () => { cancelled = true }
      }, [])

      // The roster is edited (and synced from DingTalk) on the management page, so re-read it
      // whenever a tab that offers names is shown: otherwise a person added there would not
      // appear here until the page was reloaded.
      React.useEffect(() => {
        if (bodyTab === 'tasks' || bodyTab === 'names') void reloadPeople()
      }, [bodyTab, reloadPeople])

      /**
       * Add or update one person on the meeting's roster. The mobile number is what a group
       * robot mentions; the DingTalk user id is what a private work notification addresses.
       * @param draft - The person to store.
       * @param action - 'save' adds or updates, 'remove' deletes by name.
       */
      /** Save this whole meeting as one archive another DSH can open. */
      const savePackage = React.useCallback(async () => {
        setError('')
        setNote('')
        // Addressing follows what the panel shows: exporting while a past meeting is open
        // must export THAT meeting, not the session's own (§5.4).
        const id = viewedRef.current !== null ? viewedRef.current.meetingId : await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        const toastId = toast(`${t('packageSaving')} …`)
        try {
          // Fetched rather than navigated to: the archive can take a while to build and to
          // travel, and this way the panel can say when it is done — or that it failed.
          const response = await fetch(`${PREFIX}/package?meetingId=${encodeURIComponent(id)}`)
          if (!response.ok) throw new Error(`${response.status}`)
          const total = Number(response.headers.get('Content-Length') ?? 0)
          const reader = response.body?.getReader?.()
          let blob
          if (reader === undefined) {
            blob = await response.blob()
          } else {
            const chunks = []
            let received = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done === true) break
              chunks.push(value)
              received += value.length
              if (total > 0) updateToast(toastId, `${t('packageSaving')} ${Math.min(99, Math.floor(received * 100 / total))}%`)
            }
            blob = new Blob(chunks, { type: 'application/zip' })
          }
          const name = fileNameFrom(response.headers.get('Content-Disposition')) ?? `${meta.title === '' ? id : meta.title}.zip`
          saveBlob(blob, name)
          updateToast(toastId, `${t('packageSaved')}: ${name}`)
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setError(message)
          updateToast(toastId, `${t('packageFailed')}: ${message}`)
        }
      }, [ensureMeeting, meta.title, t, toast, updateToast])

      /**
       * Send confirmed assignments out. The host reads the management page's robot settings
       * and picks the route itself: group robot, work notification, or both.
       * @param taskId - one assignment to send, or '' for every confirmed one.
       */
      const pushTasksNow = React.useCallback(async (taskId = '') => {
        setError('')
        setNote('')
        // While a past meeting is open, THAT meeting is what the person is looking at — and
        // what its own send buttons must act on.
        const id = viewed !== null ? viewed.meetingId : await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/push', { meetingId: id, taskId })
          if (typeof reply.error === 'string' && reply.error !== '') {
            setError(reply.error)
            return
          }
          const mode = t(PUSH_MODE_KEYS[reply.mode] ?? 'pushModeBoth')
          const results = Array.isArray(reply.results) ? reply.results : []
          const sent = results.filter((entry) => entry?.ok === true).length
          // The host answers one entry per target; a target that could not be reached says why.
          // Counting successes (not entries) is what keeps this from reporting a false success.
          if (sent === 0) {
            const first = results.find((entry) => entry?.ok !== true && typeof entry?.message === 'string' && entry.message !== '')
            setError(`${t('pushNothingConfigured')}${first === undefined ? '' : ` · ${first.message}`}`)
            return
          }
          const count = typeof reply.tasks === 'number' ? reply.tasks : sent
          setNote(`${t('pushed')} · ${mode} · ${count}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t, viewed])

      /** Write the meeting up as a minutes document the user can keep or send on. */
      const writeMinutes = React.useCallback(async (format = 'md') => {
        setError('')
        setNote('')
        // Same rule as packaging: a document written while viewing history belongs to the
        // meeting on screen (§5.4).
        const id = viewedRef.current !== null ? viewedRef.current.meetingId : await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/minutes', { meetingId: id, format })
          setNote(`${format === 'docx' ? t('minutesDocxDone') : t('minutesDone')}: ${reply.name}`)
          // The host writes the file and answers with its name; the browser is then handed
          // the save dialog, which is what "导出" has to mean for the person clicking it.
          downloadArtifact(reply.name)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])


      /**
       * One-click local extraction (§3, §5.7): the same rules the agent gets, without a model
       * round-trip. It only ever writes drafts, which is why it is safe to offer in the panel.
       */
      const extractNow = React.useCallback(async () => {
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/extract', { meetingId: id })
          const foundPoints = Array.isArray(reply.points) ? reply.points : []
          const foundTasks = Array.isArray(reply.tasks) ? reply.tasks : []
          setPoints(foundPoints)
          setTasks(foundTasks)
          setNote(foundPoints.length + foundTasks.length === 0
            ? t('extractEmpty')
            : `${t('extractDone')}：${t('points')} ${foundPoints.length} · ${t('tasks')} ${foundTasks.length}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, post, t])

      /**
       * The type's one-click distillation (§3.1–§3.4, §5.1): it hands the agent the meeting
       * id and the type's recipe, so the button does exactly what asking in the conversation
       * would do. It writes through the agent's tools, never through a shortcut.
       */
      const distillNow = React.useCallback(async () => {
        const viewing = viewedRef.current
        if (viewing !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        const promptKey = DISTILL_PROMPT_KEYS[meta.kind] ?? ''
        if (promptKey === '') return
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        const custom = typeof templates[meta.kind] === 'string' ? templates[meta.kind].trim() : ''
        const prompt = (custom === '' ? t(promptKey) : custom)
          .replace('{meetingId}', id)
          .replace('{title}', meta.title === '' ? t('meetingNameNone') : meta.title)
          .replace('{period}', meta.period === '' ? '-' : meta.period)
        const asked = await props.askText(sessionId, prompt)
        if (asked.ok !== true) setError(`${t('reviewNoSession')}: ${asked.error}`)
      }, [ensureMeeting, meta.kind, meta.period, meta.title, props, sessionId, t, templates])

      /**
       * Confirm, edit, or remove one stored entry. Only a human reaches this path, which
       * is what keeps an unconfirmed draft from becoming somebody else's todo.
       * @param kind - 'point' or 'task'.
       * @param id - Entry id from the stored list.
       * @param patch - Fields to change; empty when removing.
       * @param op - 'remove' deletes the entry.
       */
      const editEntry = React.useCallback(async (kind, id, patch = {}, op = 'update') => {
        const viewing = viewedRef.current
        // A past meeting stays read-only for its CONTENT, but confirming an assignment is not
        // content: it is the human step that lets that assignment be sent, and opening a past
        // meeting to check off what is done and send it on is exactly the point.
        // Only an assignment's confirmation is allowed in a past meeting: it is the human step
// that lets it be sent, not a content edit. A point's confirmation stays out (§5.4).
        const confirming = kind === 'task' && op === 'update' && Object.keys(patch).length === 1 && typeof patch.status === 'string'
        if (viewing !== null && !confirming) {
          setNote(t('historyViewOnly'))
          return
        }
        setError('')
        // Confirm, edit or delete before recording even started: the meeting is created on
        // demand, so an edit is never silently dropped for a missing id. A confirmation in a
        // past meeting belongs to THAT meeting, never to the session's own.
        const target = viewing !== null ? viewing.meetingId : await ensureMeeting()
        if (target === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/analysis', { meetingId: target, kind, id, op, patch })
          setPoints(reply.points)
          setTasks(reply.tasks)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /** Text from the most recent recognition, kept so it can be turned into a task. */
      const [lastNote, setLastNote] = React.useState('')
      /** Which cloud model last answered, so the same line is not repeated for every cue. */
      const cloudNote = React.useRef('')

      /**
       * Turn arbitrary text into a draft assignment; shared by the recognized-text row and
       * the note list, so both paths behave the same.
       * @param text - The assignment text.
       * @returns whether the task was created.
       */
      const makeTaskFrom = React.useCallback(async (text) => {
        // A viewed history is read-only: the assignment would land in the session's own
        // meeting, which is not what the click means (§5.4).
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return false
        }
        const title = text.replace(/\s+/gu, ' ').trim()
        if (title === '') return false
        const target = await ensureMeeting()
        if (target === '') {
          setError(t('needSession'))
          return false
        }
        try {
          await post('/analysis', { meetingId: target, kind: 'task', op: 'add', text: title })
          await refreshAnalysis()
          return true
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return false
        }
      }, [ensureMeeting, refreshAnalysis, t])

      /**
       * Turn one recognized line into a draft assignment and report it. The recognized lines
       * stay on screen so the remaining lines can still be sent.
       * @param line - The recognized text of one line.
       */
      const noteToTask = React.useCallback(async (line) => {
        if (await makeTaskFrom(line)) setNote(`${t('inkToTaskDone')}: ${line.replace(/\s+/gu, ' ')}`)
      }, [makeTaskFrom, t])

      /** Key points keep a two-state row: their text is a sentence, not a field to keep live. */
      const [editingPoint, setEditingPoint] = React.useState('')
      const [pointDraft, setPointDraft] = React.useState({ text: '', kind: 'point' })
      /** The hand-written entry drafts; the tabs are never a dead end without a recording. */
      const [newPoint, setNewPoint] = React.useState({ text: '', kind: 'point' })
      const [newTask, setNewTask] = React.useState('')

      /**
       * Open one key point for editing with its current values.
       * @param point - The stored point.
       */
      const beginPointEdit = React.useCallback((point) => {
        setEditingPoint(point.id)
        setPointDraft({
          text: point.text,
          kind: POINT_KIND_VALUES.includes(point.kind) ? point.kind : 'point',
        })
      }, [])

      /** Store the edited key point and close the row. */
      const savePointEdit = React.useCallback(async () => {
        if (pointDraft.text.trim() === '') {
          setError(t('pointTextRequired'))
          return
        }
        await editEntry('point', editingPoint, pointDraft)
        setEditingPoint('')
      }, [editEntry, editingPoint, pointDraft, t])

      /** Write one key point by hand — a meeting that was never recorded still gets notes. */
      const addPoint = React.useCallback(async () => {
        // A viewed history is read-only: this would write to the session's own meeting,
        // which is not what the panel is showing (§5.4).
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        const text = newPoint.text.trim()
        if (text === '') {
          setError(t('pointTextRequired'))
          return
        }
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/analysis', {
            meetingId: id,
            kind: 'point',
            op: 'add',
            text,
            pointKind: newPoint.kind,
            origin: 'manual',
          })
          if (Array.isArray(reply.points)) setPoints(reply.points)
          if (Array.isArray(reply.tasks)) setTasks(reply.tasks)
          setNewPoint({ text: '', kind: newPoint.kind })
          setNote(t('entryAdded'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, newPoint, t])

      /** Write one work assignment by hand; it stays a draft until a human confirms it. */
      const addTask = React.useCallback(async () => {
        // Same rule as the points tab: viewing a past meeting never writes elsewhere (§5.4).
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        const text = newTask.trim()
        if (text === '') {
          setError(t('taskTextRequired'))
          return
        }
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/analysis', { meetingId: id, kind: 'task', op: 'add', text, origin: 'manual' })
          if (Array.isArray(reply.points)) setPoints(reply.points)
          if (Array.isArray(reply.tasks)) setTasks(reply.tasks)
          setNewTask('')
          setNote(t('entryAdded'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, newTask, t])

      /**
       * Send one score-table request and take the settled table back. Every edit round-trips
       * through the host, so totals and clamping stay in one place (FEATURES.md §2.4).
       * @param body - request body without the meeting id.
       */
      const postScores = React.useCallback(async (body) => {
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/scores', { meetingId: id, ...body })
          if (Array.isArray(reply.scores)) setScores(reply.scores)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /** Patch one person's row. */
      const editScore = React.useCallback((person, patch) => postScores({ person, patch }), [postScores])

      /** What a score input shows: the unsaved draft, else the stored value. */
      const scoreValueOf = (person, field, stored) => {
        const key = `${person}:${field}`
        return Object.prototype.hasOwnProperty.call(scoreDrafts, key) ? scoreDrafts[key] : stored
      }
      /** Keep a keystroke local until the field is left. */
      const setScoreDraft = (person, field, value) => {
        const key = `${person}:${field}`
        setScoreDrafts((drafts) => ({ ...drafts, [key]: value }))
      }
      /** Send the field on blur, then drop the draft so the stored value takes over. */
      const commitScore = (person, field, patch) => {
        const key = `${person}:${field}`
        void editScore(person, patch).finally(() => {
          setScoreDrafts((drafts) => {
            const next = { ...drafts }
            delete next[key]
            return next
          })
        })
      }
      /** Drop one person's row. */
      const removeScore = React.useCallback((person) => postScores({ person, op: 'remove' }), [postScores])
      /** Fill completion rates from the period's tasks (a confirmed row is never touched). */
      const prefillScores = React.useCallback(() => postScores({ op: 'prefill' }), [postScores])

      /** Add one person by hand; a meeting with no agent draft still gets a table. */
      const addScore = React.useCallback(async () => {
        const person = newScorePerson.trim()
        if (person === '') {
          setError(t('needPerson'))
          return
        }
        setNewScorePerson('')
        await postScores({ person, op: 'add' })
      }, [newScorePerson, postScores, t])

      /** Export the table: Excel is rendered by the host, CSV is written beside it. */
      const exportScores = React.useCallback(async (format) => {
        setError('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/scores/export', { meetingId: id, format })
          setNote(`${t('scoresExported')}: ${reply.name}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /** Open the conversation a meeting belongs to, from the viewer or the carry-over reminder. */
      const openSeries = React.useCallback((ref) => {
        if (ref === null || ref.sessionId === '') {
          setError(t('needSession'))
          return
        }
        if (typeof props.openConversation !== 'function') {
          setError(t('hubNoWorkspace'))
          return
        }
        if (props.openConversation(ref.sessionId) === false) setError(t('hubNoWorkspace'))
      }, [props, t])

      /** Hand the carry-over list to the agent so it can assign it in this briefing. */
      const handleCarryOver = React.useCallback(async () => {
        setError('')
        if (sessionId === '') {
          setError(t('needSession'))
          return
        }
        const list = carry.items
          .map((item) => `- ${item.title}${item.owner === '' ? '' : `（${item.owner}）`}${item.done === true ? '［已办，待确认］' : ''}`)
          .join('\n')
        const prompt = t('carryOverPrompt')
          .replace('{count}', String(carry.items.length))
          .replace('{list}', list)
        const asked = await props.askText(sessionId, prompt)
        if (asked.ok !== true) setError(`${t('reviewNoSession')}: ${asked.error}`)
      }, [carry.items, props, sessionId, t])

      /**
       * Pause or resume capture without ending the meeting (FEATURES.md §5.6). The phase
       * stays "recording" — a pause is a property of the capture, not a different state —
       * so Stop keeps working and the session never silently ends.
       */
      const togglePause = React.useCallback(() => {
        const active = recorder.active
        if (active === null) return
        const next = active.paused !== true
        active.paused = next
        // Pause means "stop capturing", not "keep capturing and throw it away": turning the
        // track off releases the microphone indicator too, which is what makes pausing safe
        // for a private aside (§5.6).
        try {
          for (const track of active.stream?.getAudioTracks?.() ?? []) track.enabled = !next
        } catch { /* a closed stream has nothing to switch off */ }
        // A pause boundary is a boundary: buffered audio is dropped, never split later.
        if (next) active.pending.length = 0
        setPaused(next)
        pausedAt.current = next ? Date.now() : 0
        pauseWarned.current = false
      }, [])

      // A long pause gets one reminder, so a forgotten pause is noticed without nagging.
      React.useEffect(() => {
        if (!paused) return undefined
        const timer = setInterval(() => {
          if (pauseWarned.current) return
          if (Date.now() - pausedAt.current > 10 * 60 * 1000) {
            pauseWarned.current = true
            setNote(t('pauseLongHint'))
          }
        }, 30 * 1000)
        return () => clearInterval(timer)
      }, [paused, t])

      // The overflow is a dropdown, so it closes on the next click anywhere or on Escape,
      // like a native menu. The zero-delay listener keeps the opening click from closing it.
      // A resize, a minimise or a switch away also closes it: the panel's own geometry just
      // changed, and coordinates measured before that would be wrong.
      React.useEffect(() => {
        if (!moreOpen) return undefined
        const close = () => setMoreOpen(false)
        const onKey = (event) => { if (event.key === 'Escape') setMoreOpen(false) }
        const onViewportChange = () => setMoreOpen(false)
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
          window.addEventListener('resize', onViewportChange)
          document.addEventListener('visibilitychange', onViewportChange)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onViewportChange)
          document.removeEventListener('visibilitychange', onViewportChange)
        }
      }, [moreOpen])

      // Measure again once the open render has happened: the button is in its active style
      // by then, so the menu lands under the button as it actually looks.
      React.useLayoutEffect(() => {
        if (!moreOpen) {
          setMoreRect(null)
          return
        }
        const placed = measureUnder(moreAnchor.current, 300)
        if (placed !== null) setMoreRect(placed)
      }, [moreOpen])

      /** Load one slice of the picker's rows; scrolling to the bottom asks for the next one. */
      const loadHistory = React.useCallback(async (query, append = false) => {
        setPicker((value) => (append
          ? { ...value, loadingMore: true, open: true }
          : { ...value, loading: true, open: true, rows: [] }))
        try {
          const offset = append ? (pickerRef.current?.rows.length ?? 0) : 0
          const reply = await get(`/history?query=${encodeURIComponent(query)}&limit=30&offset=${offset}`)
          const incoming = Array.isArray(reply.meetings) ? reply.meetings : []
          setPicker((value) => ({
            ...value,
            rows: append ? [...value.rows, ...incoming] : incoming,
            total: typeof reply.total === 'number' ? reply.total : incoming.length,
            loading: false,
            loadingMore: false,
          }))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPicker((value) => ({ ...value, loading: false, loadingMore: false }))
        }
      }, [])

      /**
       * Take one keystroke into the field and search after a short pause. While an IME is
       * composing, the text is kept but nothing is searched or re-rendered around it — a
       * fetch in the middle of composition is what swallows Chinese characters.
       */
      const onQueryChange = React.useCallback((value) => {
        setPicker((current) => ({ ...current, query: value, open: true }))
        // A pending search from before the composition started must be cancelled even while
        // composing, or it fires with the previous text and rebuilds the list mid-typing.
        window.clearTimeout(searchTimer.current)
        if (composingRef.current) return
        searchTimer.current = window.setTimeout(() => { void loadHistory(value) }, 150)
      }, [loadHistory])

      /** Search the moment the composition commits, so the list follows the real text. */
      const onQueryComposed = React.useCallback((event) => {
        composingRef.current = false
        window.clearTimeout(searchTimer.current)
        void loadHistory(event.target.value)
      }, [loadHistory])

      /** Load more when the dropdown is scrolled near its bottom (lazy loading). */
      const onPickerScroll = React.useCallback((event) => {
        const box = event.currentTarget
        if (box.scrollTop + box.clientHeight < box.scrollHeight - 24) return
        const state = pickerRef.current
        if (state === null || state.loading === true || state.loadingMore === true) return
        if (state.rows.length >= state.total) return
        void loadHistory(state.query, true)
      }, [loadHistory])

      // The picker is a dropdown as well: an outside click or Escape closes it, and so does a
      // resize or a minimise — its placement was measured from the panel's geometry.
      React.useEffect(() => {
        if (picker.open !== true) return undefined
        const close = () => setPicker((value) => ({ ...value, open: false }))
        const onKey = (event) => { if (event.key === 'Escape') setPicker((value) => ({ ...value, open: false })) }
        const onViewportChange = () => setPicker((value) => ({ ...value, open: false }))
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
          window.addEventListener('resize', onViewportChange)
          document.addEventListener('visibilitychange', onViewportChange)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onViewportChange)
          document.removeEventListener('visibilitychange', onViewportChange)
        }
      }, [picker.open])

      /**
       * Show one historical meeting in this panel. Only the view changes: the session keeps
       * its own meeting, so the agent's tools still write where they always wrote.
       */
      const openHistorical = React.useCallback(async (row) => {
        setError('')
        setPicker({ open: false, query: '', rows: [], loading: false })
        try {
          const value = await get(`/state?meetingId=${encodeURIComponent(row.meetingId)}`)
          setViewed({ meetingId: row.meetingId, sessionId: row.sessionId, title: typeof value.title === 'string' ? value.title : row.title })
          setSegments(Array.isArray(value.segments) ? value.segments : [])
          setSeconds(typeof value.seconds === 'number' ? value.seconds : 0)
          setAudioName(typeof value.audioName === 'string' ? value.audioName : '')
          setPoints(Array.isArray(value.points) ? value.points : [])
          setTasks(Array.isArray(value.tasks) ? value.tasks : [])
          setNotes(Array.isArray(value.notes) ? value.notes : [])
          setDocuments(Array.isArray(value.documents) ? value.documents : [])
          setScores(Array.isArray(value.scores) ? value.scores : [])
          setLabels(Array.isArray(value.labels) ? value.labels : [])
          setSuggestions(Array.isArray(value.suggestions) ? value.suggestions : [])
          setSpeakers(value.speakers !== null && typeof value.speakers === 'object' ? value.speakers : {})
          setMeta({
            kind: typeof value.kind === 'string' ? value.kind : '',
            period: typeof value.period === 'string' ? value.period : '',
            title: typeof value.title === 'string' ? value.title : row.title,
            summary: typeof value.summary === 'string' ? value.summary : '',
          })
          setPlayhead(0)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      // The management page can hand over a meeting to open: switch the panel to it once.
      // This sits after `openHistorical` is defined, because the effect's dependency list is
      // built during render and a later const would not exist yet.
      React.useEffect(() => {
        const pending = pendingMeeting.current
        if (pending === null || pending.sessionId !== sessionId) return
        pendingMeeting.current = null
        console.info('meeting-room: panel picked up the meeting to show', pending.meetingId)
        // Bring this panel's tab forward: the panel is mounted in the session that owns the
        // meeting, so this is the first moment the request can be served for sure.
        if (typeof props.focusMeetingPanel === 'function') props.focusMeetingPanel()
        void (async () => {
          const adopted = await adopt()
          // Its own meeting is already the one on screen; nothing to switch to.
          if (adopted !== null && adopted.meetingId === pending.meetingId) return
          await openHistorical({ meetingId: pending.meetingId, sessionId: pending.sessionId, title: '' })
          setBodyTab('transcript')
        })()
      }, [adopt, openHistorical, props, sessionId])

      /** Write the current meeting now, so switching away cannot lose it. */
      const saveNow = React.useCallback(async () => {
        if (meetingId === '') return
        try {
          await post('/flush', { meetingId })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [meetingId])

      /** Pick a row: an untouched session switches at once, one with content counts down. */
      const chooseHistorical = React.useCallback(async (row) => {
        const content = segments.length > 0 || points.length > 0 || tasks.length > 0 || notes.length > 0
        if (viewed !== null || content !== true) {
          await openHistorical(row)
          return
        }
        setPicker((value) => ({ ...value, open: false }))
        setSwitchPrompt({ row, seconds: 3 })
      }, [notes.length, openHistorical, points.length, segments.length, tasks.length, viewed])

      /** Leave the viewer and show this session's own meeting again. */
      const closeViewed = React.useCallback(async () => {
        setViewed(null)
        setPlayhead(0)
        setMeetingId('')
        const adopted = await adopt()
        if (adopted === null) setNote(t('noMeeting'))
        else await refreshAnalysis()
      }, [adopt, refreshAnalysis, setMeetingId, t])

      // The guard counts down, then saves and switches; Cancel stops it (FEATURES.md §5.4).
      React.useEffect(() => {
        if (switchPrompt === null) return undefined
        if (switchPrompt.seconds > 0) {
          const timer = setTimeout(() => {
            setSwitchPrompt((value) => (value === null ? null : { ...value, seconds: value.seconds - 1 }))
          }, 1000)
          return () => clearTimeout(timer)
        }
        const row = switchPrompt.row
        setSwitchPrompt(null)
        void (async () => {
          await saveNow()
          await openHistorical(row)
        })()
        return undefined
      }, [switchPrompt, saveNow, openHistorical])

      /** Open one stored document inline, without leaving the panel. */
      const openStoredDocument = React.useCallback(async (entry) => {
        setError('')
        try {
          const reply = await get(`/file?name=${encodeURIComponent(entry.name)}`)
          setOpenDocument(typeof reply.content === 'string' ? reply.content : '')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /**
       * Save a drawn note into this meeting's record. The sequence keeps two notes drawn
       * in the same second from overwriting each other.
       * @param pngBase64 - The canvas rendered as PNG bytes.
       */
      const saveNote = React.useCallback(async (pngBase64) => {
        if (pngBase64 === '') return
        setError('')
        noteSeq.current += 1
        const stamp = stampOf(startedAt === 0 ? Date.now() : startedAt)
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          await post('/note', { name: `${stamp}-note${noteSeq.current}.png`, pngBase64, meetingId: id })
          setNote(t('inkSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, startedAt, t])

      /**
       * Recognize a drawing locally and keep the text on this meeting. No agent, no
       * network: the host runs the model in a child process that stays warm.
       * @param pixelsBase64 - Packed grayscale pixels from the pad.
       */
      const recognizeNote = React.useCallback(async (payloads, asTask) => {
        setError('')
        setNote(t('inkRecognizing'))
        try {
          const texts = []
          for (const pixelsBase64 of payloads) {
            const reply = await post('/handwriting', { chunks: 3, pixelsBase64 })
            const line = typeof reply.text === 'string' ? reply.text.trim() : ''
            if (line !== '') texts.push(line)
          }
          const text = texts.join('\n')
          if (text === '') {
            setNote(t('inkLocalEmpty'))
            return
          }
          const id = await ensureMeeting()
          if (id === '') {
            setNote(`${t('inkLocal')}: ${text}`)
            setError(t('needSession'))
            return
          }
          const stored = await post('/note', { text, meetingId: id, source: 'handwriting' })
          if (Array.isArray(stored.notes)) setNotes(stored.notes)
          // Turning a written note into an assignment still lands as a draft, so the human
          // confirmation gate stays the only path to a confirmed task.
          if (asTask === true) await post('/analysis', { meetingId: id, kind: 'task', op: 'add', text })
          await refreshAnalysis()
          // Keep the text on hand so a plain recognition can also become an assignment.
          setLastNote(asTask === true ? '' : text)
          setNote(asTask === true ? `${t('inkToTaskDone')}: ${text}` : `${t('inkLocal')}: ${text}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, refreshAnalysis, t])

      /**
       * Move the recording to a cue's start and play from there, which is what clicking a
       * transcript line asks for: hear this sentence again.
       * @param seconds - Offset into the recording.
       */
      const seekTo = React.useCallback((seconds) => {
        const element = audio.current
        if (element === null) return
        element.currentTime = seconds
        setPlayhead(seconds)
        // Autoplay can be refused before any user gesture in the page; the seek still lands,
        // so a refusal only costs the playing state.
        const started = element.play()
        if (started !== undefined && typeof started.catch === 'function') {
          started.catch(() => { setPlaying(false) })
        }
      }, [])

      // Speaker labels are on by default. The host downloads the model once and caches it,
      // so this normally settles immediately; the poll keeps the status line honest while
      // a first-ever download runs, and a failure leaves the retry button in place.
      React.useEffect(() => {
        let live = true
        const settle = async () => {
          try {
            const value = await get('/speaker')
            if (!live) return
            setSpeaker({ phase: value.phase, message: value.message ?? '', completedBytes: value.completedBytes ?? 0, totalBytes: value.totalBytes ?? 0 })
            if (value.phase === 'unprepared') {
              await post('/speaker/prepare', {}).catch(() => undefined)
              return
            }
            if (value.phase === 'downloading') {
              await new Promise((resolve) => setTimeout(resolve, 2000))
              if (live) await settle()
            }
          } catch {
            // The status line keeps its previous value; recording is unaffected.
          }
        }
        void settle()
        return () => { live = false }
      }, [])

      /** Ask the host to prepare speaker support, then follow its state until it settles. */
      const prepareSpeakers = React.useCallback(async () => {
        setError('')
        try {
          await post('/speaker/prepare', {})
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return
        }
        for (let attempt = 0; attempt < 300; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          try {
            const value = await get('/speaker')
            setSpeaker({ phase: value.phase, message: value.message ?? '', completedBytes: value.completedBytes ?? 0, totalBytes: value.totalBytes ?? 0 })
            if (value.phase === 'ready' || value.phase === 'failed') return
          } catch {
            return
          }
        }
      }, [])

      React.useEffect(() => {
        try {
          localStorage.setItem(TERMS_KEY, termsText)
        } catch {
          // Storage refused (private mode): the list still applies to this meeting.
        }
      }, [termsText])

      // The host mirrors the list so `meeting_read` can hand it to the model.
      React.useEffect(() => {
        if (meetingId === '') return
        void post('/terms', { meetingId, terms: termsText }).catch(() => undefined)
      }, [meetingId, termsText])

      const { terms, rules } = React.useMemo(() => parseTerms(termsText), [termsText])
      const visible = React.useMemo(() => applyRules(segments, rules), [segments, rules])

      /** The cue the recording is inside, held until the next one starts — the lyric line. */
      const activeIndex = React.useMemo(() => {
        let index = -1
        for (let i = 0; i < visible.length; i++) if (visible[i].start <= playhead) index = i
        return index
      }, [playhead, visible])

      React.useEffect(() => {
        if (!playing || activeIndex < 0) return
        const row = rows.current[activeIndex]
        if (row !== null && row !== undefined) row.scrollIntoView({ block: 'nearest' })
      }, [activeIndex, playing])

      /** Tick or untick one cue for merging. */
      const toggleCue = React.useCallback((id) => {
        setSelectedCueIds((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      /**
       * Turn the ticked cues into ONE assignment: several cues often describe a single piece
       * of work, and the task should read as that one thing rather than as three (§5.7).
       */
      const mergeSelectedCues = React.useCallback(async () => {
        const picked = visible.filter((segment) => selectedCueIds.has(segment.id))
        if (picked.length === 0) return
        const text = picked
          .map((segment) => seenOf(segment).trim())
          .filter((line) => line !== '')
          .join('；')
        if (text === '') return
        const stored = await makeTaskFrom(text)
        if (stored) {
          setSelectedCueIds(new Set())
          setNote(`${t('mergeStored')} · ${picked.length}`)
        }
      }, [makeTaskFrom, selectedCueIds, t, visible])

      /** Keep following the newest cue; scrolling away hands control back to the reader. */
      const onTranscriptScroll = React.useCallback((event) => {
        const box = event.currentTarget
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48
        followRef.current = atBottom
        setFollow(atBottom)
      }, [])

      // Every new cue scrolls into view while following is on.
      React.useEffect(() => {
        if (followRef.current !== true) return
        const box = listRef.current
        if (box === null) return
        box.scrollTop = box.scrollHeight
      }, [segments.length])

      /** Release capture resources held by the current meeting. */
      const release = React.useCallback(async () => {
        const active = recorder.active
        if (active === null) return
        recorder.active = null
        try {
          clearInterval(active.ticker)
          active.node.port.onmessage = null
          active.node.disconnect()
          active.sink.disconnect()
          active.source.disconnect()
          active.stream.getTracks().forEach((track) => track.stop())
          if (active.url !== '') URL.revokeObjectURL(active.url)
          await active.audio.close()
        } catch (failure) {
          console.warn('meeting-room: release failed', failure)
        }
      }, [])

      // Deliberately no release-on-unmount: the capture belongs to the recorder, not to
      // this panel, so navigating away or closing the dock keeps the meeting running.
      // Stop is the only path that releases the microphone.

      /**
       * Send the buffered audio as one cue and fold the reply into panel state.
       * One request runs at a time; audio keeps accumulating while a request is in flight.
       * @param active - Capture session.
       */
      const flush = React.useCallback(async (active) => {
        if (active.inflight || active.pending.length === 0) return
        active.inflight = true
        const samples = active.pending
        active.pending = []
        active.frames = 0
        active.silenceFrames = 0
        const merged = new Float32Array(samples.reduce((total, part) => total + part.length, 0))
        let offset = 0
        for (const part of samples) {
          merged.set(part, offset)
          offset += part.length
        }
        const pcm = toPcm16(merged, active.audio.sampleRate)
        setPhase('transcribing')
        try {
          const reply = await post('/chunk', { meetingId: active.meetingId, pcm: base64(pcm) })
          setSegments(reply.segments)
          setSeconds(reply.seconds)
          if (typeof reply.audioName === 'string') setAudioName(reply.audioName)
          if (Array.isArray(reply.points)) setPoints(reply.points)
          if (Array.isArray(reply.tasks)) setTasks(reply.tasks)
          // A voice can appear mid-meeting, so the naming row follows the cue stream.
          if (reply.speakers !== null && typeof reply.speakers === 'object') setSpeakers(reply.speakers)
          if (Array.isArray(reply.labels)) setLabels(reply.labels)
          if (reply.speaker !== undefined) setSpeaker({ phase: reply.speaker.phase, message: reply.speaker.message ?? '', completedBytes: reply.speaker.completedBytes ?? 0, totalBytes: reply.speaker.totalBytes ?? 0 })
          // Cloud recognition reports itself: which model answered, or why it fell back to the
          // on-machine recogniser. A silent fallback is exactly what erodes trust in a switch.
          if (reply.cloud !== undefined && reply.cloud !== null) {
            if (reply.cloud.used === true) {
              const model = typeof reply.cloud.model === 'string' ? reply.cloud.model : ''
              if (cloudNote.current !== model) {
                cloudNote.current = model
                setNote(`${t('cloudUsed')}${model === '' ? '' : `: ${model}`}`)
              }
            } else if (reply.cloud.fallback === true) {
              setError(`${t('cloudFallback')}: ${reply.cloud.message ?? ''}`)
            }
          }
        } catch (failure) { const msg = failure instanceof Error ? failure.message : String(failure); setError(msg); if (msg.indexOf('\u8bed\u97f3\u6a21\u578b\u5c1a\u672a\u4e0b\u8f7d') !== -1) setSpeech((c) => ({ ...c, ready: false }))
        } finally {
          active.inflight = false
          if (recorder.active === active) setPhase(active.stopping ? 'transcribing' : 'recording')
          if (!active.stopping && shouldFlush(active)) void flush(active)
        }
      }, [])

      /** Start a meeting and begin capture. */
      const start = React.useCallback(async () => {
        setError('')
        setNote('')
        if (speech.ready !== true) {
          // One click covers the whole chain: enable the voice-input bundle if it is off,
          // download the model if it is missing, then start recording once it is ready.
          setPendingStart(true)
          void prepareSpeech()
          return
        }
        setPhase('starting')
        try {
          // Read here, not at the top: a start that first waits for the model keeps the flag for
      // the run that actually reaches the host. `auto` stops the host from prompting the
      // agent again when the agent is the one that asked for this start.
      const auto = recorder.autoStart === true
      recorder.autoStart = false
      const created = await post('/start', { sessionId, terms: termsText, auto })
          let audio
          try {
            audio = new AudioContext({ sampleRate: TARGET_RATE })
          } catch {
            // Chromium rejects an unsupported rate; the box filter in toPcm16 handles any rate.
            audio = new AudioContext()
          }
          await audio.resume()
          let stream
          try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) } catch (micErr) { const nm = micErr && typeof micErr.name === 'string' ? micErr.name : ''; if (nm === 'NotAllowedError' || nm === 'PermissionDeniedError') throw new Error('\u65e0\u6cd5\u8bbf\u95ee\u9ea6\u514b\u98ce\uff1a\u8bf7\u5728\u7cfb\u7edf\u8bbe\u7f6e\u91cc\u5141\u8bb8 DeepSeek Harness \u4f7f\u7528\u9ea6\u514b\u98ce'); if (nm === 'NotFoundError') throw new Error('\u6ca1\u6709\u68c0\u6d4b\u5230\u9ea6\u514b\u98ce\u8bbe\u5907'); throw new Error('\u65e0\u6cd5\u542f\u52a8\u9ea6\u514b\u98ce: ' + (micErr instanceof Error ? micErr.message : String(micErr))) }
          const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
          await audio.audioWorklet.addModule(url)
          const source = audio.createMediaStreamSource(stream)
          const node = new AudioWorkletNode(audio, 'meeting-capture')
          const sink = audio.createGain()
          sink.gain.value = 0
          source.connect(node)
          node.connect(sink)
          sink.connect(audio.destination)

          const active = {
            meetingId: created.meetingId,
            audio, stream, source, node, sink, url,
            pending: [],
            frames: 0,
            // Audio captured so far in this meeting, in samples. It drives the live elapsed
            // clock; the host's own count stays authoritative once a cue is transcribed.
            captured: 0,
            ticker: 0,
            silenceFrames: 0,
            inflight: false,
            stopping: false,
            // A paused capture drops what a pause would otherwise record (§5.6).
            paused: false,
          }
          recorder.active = active
          node.port.onmessage = (event) => {
            // While paused nothing is buffered, so the exported recording carries no hole.
            if (active.paused === true) return
            const block = event.data
            active.pending.push(block)
            active.frames += block.length
            active.captured += block.length
            // Endpoint at a pause instead of a fixed clock: a cue then holds what a
            // speaker actually said, rather than being cut mid-sentence. The cap keeps
            // a long monologue from growing without bound.
            if (blockRms(block) < CUES.silenceRms) active.silenceFrames += block.length
            else active.silenceFrames = 0
            if (!active.inflight && shouldFlush(active)) void flush(active)
          }
          // The elapsed clock ticks on captured audio, not on wall time: a pause stops the
          // count without leaving a gap in the recording (§5.6).
          active.ticker = setInterval(() => {
            if (active.paused === true) return
            setSeconds(Math.round(active.captured / active.audio.sampleRate))
          }, 1000)
          setPaused(false)
          pausedAt.current = 0
          pauseWarned.current = false
          setSegments([])
          setSeconds(0)
          setMeetingId(created.meetingId)
          setStartedAt(created.startedAt ?? Date.now())
          setAudioName(typeof created.audioName === 'string' ? created.audioName : '')
          setPhase('recording')
          // Recording has begun: make sure the person is looking at the meeting record,
          // not at whatever tab was in front when the microphone opened.
          try {
            if (typeof props.focusMeetingPanel === 'function') props.focusMeetingPanel()
          } catch (failure) {
            console.warn('meeting-room: could not bring the meeting tab forward', failure)
          }
        } catch (failure) {
          await release()
          setPhase('idle')
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [flush, release, sessionId, termsText, speech.ready, prepareSpeech])

      // A pending start fires the moment the model reports ready — no second click, and
      // no dialog asking again. Cancelling the intent (below) clears the flag first.
      React.useEffect(() => {
        if (pendingStart && speech.ready === true && phase === 'idle') {
          setPendingStart(false)
          void start()
        }
      }, [pendingStart, speech.ready, phase, start])

      // The agent can ask the panel to start recording (meeting-scribe: "开始记录" with no
      // naming step). The microphone belongs to the browser, so the panel carries it out
      // here with the same start() the button uses — permission prompt, model preparation
      // and every error message stay in one place. The request is cleared before starting,
      // so a reload cannot start a second meeting from a stale flag.
      React.useEffect(() => {
        if (viewed !== null) return undefined
        const timer = setInterval(() => {
          void (async () => {
            if (phase !== 'idle' || recorder.active !== null) return
            try {
              const value = await get(`/record?sessionId=${encodeURIComponent(sessionId)}`)
              const request = typeof value.request === 'number' ? value.request : 0
              if (request <= 0) return
              await post('/record', { sessionId })
              // An old request (a panel that was closed for a while) must not start a
              // meeting after the fact: it expires quietly.
              if (Date.now() - request > 120_000) return
              recorder.autoStart = true
              await start()
              if (recorder.active !== null) setNote(t('autoRecordStarted'))
            } catch {
              // No meeting yet, or the host is restarting: the next tick tries again.
            }
          })()
        }, 3000)
        return () => clearInterval(timer)
      }, [phase, sessionId, start, t, viewed])

      // The start page's "开始会议" card: consume its request here (the same start() the
      // buttons use, so the microphone prompt and the host hand-off stay in one place).
      React.useEffect(() => {
        const begin = () => {
          if (guideBegin.pending !== true) return
          if (Date.now() > guideBegin.deadline) { guideBegin.pending = false; guideBegin.target = ''; return }
          // Only the conversation the card asked for may start the meeting: the column can
          // briefly still hold the previous session's panel, which must not grab the request.
          if (guideBegin.target !== '' && sessionId !== guideBegin.target) return
          // Without a session the panel has nothing to attach a meeting to; the pending
          // request survives until a panel with a real session mounts.
          if (sessionId === '') return
          if (phase !== 'idle' || recorder.active !== null || viewed !== null) return
          guideBegin.pending = false
          guideBegin.opened = false
          guideBegin.target = ''
          void start()
        }
        begin()
        window.addEventListener('meeting-room:begin', begin)
        return () => window.removeEventListener('meeting-room:begin', begin)
      }, [phase, sessionId, start, viewed])

      /** Stop capture, drain the remaining audio, then finalize the meeting. */
      const stop = React.useCallback(async () => {
        const active = recorder.active
        if (active === null) return
        active.stopping = true
        // Stop always leaves the panel unpaused, even when the meeting was paused: a
        // finished meeting cannot be "resumed" (§5.6).
        setPaused(false)
        pausedAt.current = 0
        setPhase('transcribing')
        // Draining the last cues and re-labelling the whole recording takes a while on a
        // long meeting — minutes on a two-hour one. The notice is sticky (no auto-fade)
        // and counts elapsed time, so it lasts exactly as long as the work does.
        const startedAt = Date.now()
        const waited = () => `${Math.round((Date.now() - startedAt) / 1000)}s`
        const waiting = toast(t('stopFinishing'), { sticky: true })
        // A ticking clock proves the page is alive even while `/stop` re-labels the whole
        // recording and sends no progress back.
        const ticker = setInterval(() => {
          updateToast(waiting, `${t('stopFinishing')} ${t('stopElapsed')} ${waited()}`)
        }, 1000)
        try {
          for (let attempt = 0; attempt < 120 && (active.inflight || active.pending.length > 0); attempt++) {
            if (active.inflight) {
              updateToast(waiting, `${t('stopFinishing')} ${t('stopRemaining')} ${active.pending.length + 1} · ${waited()}`)
              await new Promise((resolve) => setTimeout(resolve, 200))
            } else {
              updateToast(waiting, `${t('stopFinishing')} ${t('stopRemaining')} ${active.pending.length} · ${waited()}`)
              await flush(active)
            }
          }
          await release()
          const reply = await post('/stop', { meetingId: active.meetingId })
          clearInterval(ticker)
          setSegments(reply.segments)
          setSeconds(reply.seconds)
          if (typeof reply.audioName === 'string') setAudioName(reply.audioName)
          updateToast(waiting, `${t('stopFinished')} ${waited()}`)
          setTimeout(() => dismissToast(waiting), 2500)
        } catch (failure) {
          clearInterval(ticker)
          dismissToast(waiting)
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setPhase('idle')
      }, [dismissToast, flush, release, t, toast, updateToast])

      /** Write the SRT record and its Markdown companion into the host's meetings directory. */

      /** Copy the SRT record to the clipboard. */
      const copySrt = React.useCallback(async () => {
        try {
          await navigator.clipboard.writeText(srtOf(visible))
          setNote(t('copied'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [t, visible])

      /** Copy the human-readable transcript to the clipboard. */
      const copyText = React.useCallback(async () => {
        const text = visible.map((segment) => `${clock(segment.start)}  ${seenOf(segment)}`).join('\n')
        try {
          await navigator.clipboard.writeText(text)
          setNote(t('copied'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [t, visible])

      /** Copy the correction request that hands the record to the agent. */
      const copyForFix = React.useCallback(async () => {
        try {
          await navigator.clipboard.writeText(correctionPromptOf(srtOf(visible), terms))
          setNote(t('copied'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [t, terms, visible])

      const recording = phase === 'recording' || phase === 'transcribing'
      // A meeting counts as having content from notes, tasks or documents alone: recording is
      // not a precondition for writing minutes, pushing work or exporting Word.
      const hasContent = segments.length > 0 || points.length > 0 || tasks.length > 0
        || notes.length > 0 || documents.length > 0
      // The newest cue's voice is who is speaking now, so the status line names them.
      const currentSpeaker = segments.length === 0 ? '' : segments[segments.length - 1].speaker
      const status = paused
        ? `${t('pausedStatus')} ${clock(seconds)}`
        : phase === 'recording'
          ? `${t('elapsed')} ${clock(seconds)}${currentSpeaker === '' ? '' : ` · ${t('speakingNow')} ${currentSpeaker}`}`
          : phase === 'transcribing' ? t('transcribing') : phase === 'starting' ? t('starting') : pendingStart ? (speech.requesting ? t('speechPreparing') : t('speechAutoStart')) : t('idle')
      const speakerProgress = speaker.phase === 'downloading' && typeof speaker.totalBytes === 'number' && speaker.totalBytes > 0
        ? `（${((speaker.completedBytes ?? 0) / 1048576).toFixed(1)} / ${(speaker.totalBytes / 1048576).toFixed(1)} MB${speaker.completedBytes > 0 ? ` · ${Math.floor(speaker.completedBytes * 100 / speaker.totalBytes)}%` : ''}）`
        : ''
      const speakerText = speaker.phase === 'ready' ? t('speakerReady')
        : speaker.phase === 'downloading' ? `${t('speakerDownloading')}${speakerProgress}`
          : speaker.phase === 'failed' ? `${t('speakerFailed')}${speaker.message === '' ? '' : `: ${speaker.message}`}`
            : t('speakerOff')
      // Real download progress when the provider reports byte counts, indeterminate otherwise.
      const speechDetail = speech.requesting
        ? (speech.totalBytes > 0
          ? `${t('speechDownloading')}（${(speech.completedBytes / 1048576).toFixed(1)} / ${(speech.totalBytes / 1048576).toFixed(1)} MB）`
          : t('speechPreparing'))
        : ''

      return h(Boundary, null, h('section', { style: styles.panel }, [
        // The pinned console carries the buttons, the status, the note pad, the recording
        // player and the content tabs; only what follows it scrolls, so a long transcript
        // cannot push those controls out of reach.
        h('div', { key: 'head', style: styles.panelHead }, [
          // The title row: the meeting's own name and type, the derived period, and the
          // same kind's previous/next meeting (§5.1). The name and type are readable and
          // changeable here at any time, including mid-recording: a meeting first thought
          // to be a discussion can turn out to be a briefing.
          h('div', { key: 'titlerow', style: styles.row }, [
            // A past meeting still shows its own name and type, just not as editable
            // fields: the name belongs to the meeting, editing belongs to the session that
            // owns it (§5.4).
            viewed !== null ? h('span', { key: 'titleview', style: styles.titleStatic }, meta.title === '' ? t('meetingNameNone') : meta.title) : h(Field, {
              // Uncontrolled on purpose: the name is written when the field loses focus, so
              // typing does not POST on every keystroke. The key remounts it per meeting, so
              // switching conversations shows that meeting's own name.
              key: `title-${meetingId}`,
              type: 'text',
              style: styles.titleInput,
              defaultValue: meta.title,
              placeholder: t('meetingNamePlaceholder'),
              title: t('meetingTitleHint'),
              'aria-label': t('meetingNamePlaceholder'),
              spellCheck: false,
              onBlur: (event) => {
                const next = event.target.value.trim()
                // Only a real change writes: focusing the field and leaving it must not
                // create a meeting as a side effect.
                if (next !== meta.title) void saveMeta({ title: next })
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
            }),
            viewed !== null
              ? h('span', { key: 'kindview', style: styles.chip }, t(KIND_LABEL_KEYS[meta.kind] ?? 'kindGeneral'))
              : h(Picker, {
                key: 'kind',
                style: styles.inlineInput,
                value: meta.kind,
                title: t('kindLabel'),
                'aria-label': t('kindLabel'),
                onChange: (event) => { void saveMeta({ kind: event.target.value }) },
              }, KIND_VALUES.map((value) => h('option', {
                key: value === '' ? 'general' : value,
                value,
              }, t(KIND_LABEL_KEYS[value])))),
            meta.period === '' ? null : h('span', { key: 'period', style: styles.chip }, meta.period),
            series.prev === null && series.next === null ? null : h('div', { key: 'series', style: styles.row }, [
              h(Btn, {
                key: 'prev',
                type: 'button',
                style: styles.smallButton,
                disabled: series.prev === null,
                title: series.prev === null ? t('seriesNone') : `${t('seriesPrev')}: ${series.prev.title === '' ? t('meetingNameNone') : series.prev.title}`,
                onClick: () => openSeries(series.prev),
              }, `‹ ${t('seriesPrev')}`),
              h(Btn, {
                key: 'next',
                type: 'button',
                style: styles.smallButton,
                disabled: series.next === null,
                title: series.next === null ? t('seriesNone') : `${t('seriesNext')}: ${series.next.title === '' ? t('meetingNameNone') : series.next.title}`,
                onClick: () => openSeries(series.next),
              }, `${t('seriesNext')} ›`),
            ]),
          ]),
          viewed !== null ? null : h('div', { key: 'notebar', style: styles.row }, [
          h(Btn, {
            key: 'toggle',
            type: 'button',
            style: recording ? styles.buttonActive : styles.button,
            disabled: phase === 'starting' || pendingStart,
            onClick: () => {
              if (recording) { void stop(); return }
              // Name the meeting once before the first recording (§5.5). The dialog also
              // carries the role, so the seat is chosen where the meeting starts.
              if (meta.title !== '') { void start(); return }
              setNamePrompt({ text: '', kind: meta.kind, role: role === '' ? 'attendee' : role, roleOther: '', start: true })
            },
          }, recording ? t('stop') : pendingStart ? t('preparing') : t('start')),
          // Pause sits beside Stop: a pause keeps the meeting open, Stop ends it (§5.6). The
          // button stays put for the whole recording — it used to vanish for the moment a
          // chunk was being written, which reads as a fault — and is only disabled then.
          recording ? h(Btn, {
            key: 'pause',
            type: 'button',
            style: paused ? styles.buttonActive : styles.button,
            // Pausing is local and must work immediately; only a capture that has not
            // started yet has nothing to pause (§5.6).
            disabled: phase === 'starting',
            onClick: () => togglePause(),
          }, paused ? t('resumeRecording') : t('pauseRecording')) : null,
          h(Btn, {
            key: 'notes',
            type: 'button',
            style: notesOpen ? styles.buttonActive : styles.button,
            onClick: () => setNotesOpen((value) => !value),
          }, t('notesToggle')),
          h(Btn, {
            key: 'review',
            type: 'button',
            style: styles.button,
            onClick: () => { void review() },
          }, t('review')),
          // The type's own one-click distillation (§3.1–§3.4): only a typed meeting has a
          // recipe, and the button is hidden while a past meeting is open because the
          // distillation belongs to the session's own meeting (§5.4).
          viewed !== null || meta.kind === '' ? null : h(Btn, {
            key: 'distill',
            type: 'button',
            style: styles.buttonActive,
            onClick: () => { void distillNow() },
          }, t(DISTILL_LABEL_KEYS[meta.kind] ?? 'review')),
          h(Btn, {
            key: 'minutes',
            type: 'button',
            style: styles.button,
            onClick: () => { void writeMinutes() },
          }, t('minutes')),
          // The picker is one button in the row like every other action, and its dropdown
          // carries the search field: the panel is a console, not a search page (§5.4).
          h('div', {
            key: 'pickerwrap',
            style: styles.menuWrap,
            // Clicks inside the dropdown must not reach the document listener that closes it.
            onClick: (event) => event.stopPropagation(),
          }, [
            h(Btn, {
              key: 'open',
              type: 'button',
              style: picker.open === true ? styles.buttonActive : styles.button,
              'aria-expanded': picker.open === true,
              onClick: (event) => {
                const open = picker.open !== true
                if (open) {
                  // The dropdown is as wide as the panel it lives in, measured rather than
                  // guessed, and fixed so the panel's own scrolling cannot clip it.
                  // Measured, clamped to the viewport on both axes; the list is at most 320px tall.
                  setPickerRect(measureUnder(event.currentTarget, 640, 340))
                }
                setPicker((value) => ({ ...value, open }))
                if (open) void loadHistory(picker.query)
              },
            }, t('historyOpen')),
            picker.open !== true ? null : float(h('div', {
              key: 'pickerlist',
              // Portalled out of the wrapper, so the panel itself has to swallow clicks:
              // otherwise typing in its search field would reach the document and close it.
              onClick: (event) => event.stopPropagation(),
              // Fixed and measured: the list spans the panel's width instead of hugging the
              // button it was opened from (§5.4).
              style: pickerRect === null ? styles.historyPanel : {
                ...styles.historyPanel,
                position: 'fixed',
                left: `${pickerRect.left}px`,
                top: `${pickerRect.top}px`,
                width: `${pickerRect.width}px`,
                right: 'auto',
              },
              onScroll: onPickerScroll,
            }, [
              // The platform's Input: the same field the built-in model picker searches with,
              // so an IME behaves; a plain input is the fallback when primitives are absent.
              h(Field, {
                key: 'query',
                type: 'text',
                style: styles.inlineWide,
                className: 'mr-input-compact',
                value: picker.query,
                placeholder: t('historyPlaceholder'),
                spellCheck: false,
                role: 'searchbox',
                'aria-label': t('historyPlaceholder'),
                onFocus: () => { void loadHistory(picker.query) },
                onChange: (event) => onQueryChange(event.target.value),
                onCompositionStart: () => { composingRef.current = true },
                onCompositionEnd: onQueryComposed,
                onKeyDown: (event) => { if (event.key === 'Escape') setPicker((value) => ({ ...value, open: false })) },
              }),
              picker.rows.length === 0
                ? h('p', { key: 'none', style: styles.empty }, picker.loading === true ? t('historyLoading') : t('historyEmpty'))
                : null,
              ...picker.rows.map((row) => h('div', {
                key: row.meetingId,
                style: styles.historyRow,
                className: 'mr-hover',
                role: 'button',
                tabIndex: 0,
                title: t('historyChoose'),
                onClick: () => { void chooseHistorical(row) },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void chooseHistorical(row)
                  }
                },
              }, [
                h('div', { key: 'head', style: styles.historyHead }, [
                  h('span', { key: 'when', style: styles.stamp }, new Date(row.startedAt).toLocaleDateString()),
                  h('span', { key: 'name', style: styles.historyName }, row.title === '' ? t('meetingNameNone') : row.title),
                  row.kind === '' ? null : h('span', { key: 'kind', style: styles.chip }, t(KIND_LABEL_KEYS[row.kind] ?? 'kindGeneral')),
                  row.period === '' ? null : h('span', { key: 'period', style: styles.hint }, row.period),
                  row.hasContent === true ? null : h('span', { key: 'blank', style: styles.chip }, t('historyBlank')),
                ]),
                row.excerpt === '' ? null : h('div', { key: 'excerpt', style: styles.historyExcerpt }, row.excerpt.length > 120 ? `${row.excerpt.slice(0, 120)}…` : row.excerpt),
              ])),
              picker.rows.length === 0 ? null : h('div', { key: 'more', style: styles.hint }, picker.rows.length >= picker.total
                ? t('historyAll')
                : (picker.loadingMore === true ? t('historyLoading') : t('historyMore'))),
            ])),
          ]),
          // The overflow is a dropdown under its own button: the action row keeps one line,
          // and the occasional actions (save as file, copy, terms, about) sit inside it
          // instead of shouting in the bar. The button itself is always there — an action
          // that comes and goes reads as a bug — so only the items depend on content.
          h('div', { key: 'morewrap', style: styles.menuWrap }, [
            h(Btn, {
              key: 'more',
              type: 'button',
              style: moreOpen ? styles.buttonActive : styles.button,
              'aria-expanded': moreOpen,
              // Measured from the click's own element, exactly like the meeting picker. The
              // host Button forwards no ref, so measuring through one never ran — the menu
              // then fell back to coordinates relative to the whole page.
              onClick: (event) => {
                const open = moreOpen !== true
                if (open) {
                  // The element is kept for one re-measurement after the open render, when
                  // the button already carries its active style and the row has settled.
                  moreAnchor.current = event.currentTarget
                  setMoreRect(measureUnder(event.currentTarget, 300))
                }
                setMoreOpen(open)
              },
            }, t('more')),
            // Rendered at the document root, so nothing in the panel can cover it; if the
            // button could not be measured the menu stays in the panel instead of floating
            // to a place nobody asked for.
            moreOpen ? floatWhen(moreRect !== null, h('div', {
              key: 'moremenu',
              style: moreRect === null ? styles.menu : {
                ...styles.menu,
                position: 'fixed',
                top: `${moreRect.top}px`,
                left: `${moreRect.left}px`,
                width: `${moreRect.width}px`,
                right: 'auto',
              },
              role: 'menu',
            }, [
              // Only what acts on the record itself stays: exporting it, copying it, handing
              // it to a model for correction.
              h(Btn, {
                key: 'files', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void savePackage() },
              }, t('exportFile')),
              h(Btn, {
                disabled: segments.length === 0, title: segments.length === 0 ? t('needTranscript') : undefined,
                key: 'srt', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copySrt() },
              }, t('copySrt')),
              h(Btn, {
                disabled: segments.length === 0, title: segments.length === 0 ? t('needTranscript') : undefined,
                key: 'copy', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copyText() },
              }, t('copy')),
              h(Btn, {
                disabled: segments.length === 0, title: segments.length === 0 ? t('needTranscript') : undefined,
                key: 'fix', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copyForFix() },
              }, t('copyForFix')),
              h(Btn, {
                key: 'minutesdocx', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void writeMinutes('docx') },
              }, t('minutesDocx')),
              // The terminology list is an occasional setting, so it opens from here rather
              // than occupying a tab in the note pad.
              h(Btn, {
                key: 'terms', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); setTermsOpen(true) },
              }, t('tabTerms')),
              // Version, author and where to write about a problem or an idea.
              h(Btn, {
                key: 'about', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); setAboutOpen(true) },
              }, t('about')),
            ])) : null,
          ]),
          h(Btn, {
            key: 'help',
            type: 'button',
            title: t('helpToggle'),
            'aria-label': t('helpToggle'),
            'aria-expanded': helpOpen,
            style: helpOpen ? styles.buttonActive : styles.button,
            onClick: () => setHelpOpen((value) => !value),
          }, '?'),
        ]),
          viewed === null ? null : h('div', { key: 'viewer', style: styles.row }, [
            h('span', { key: 'label', style: styles.status }, `${t('historyViewing')}: ${meta.title === '' ? t('meetingNameNone') : meta.title}${meta.period === '' ? '' : ` · ${meta.period}`}`),
            typeof props.openConversation !== 'function' || viewed.sessionId === '' ? null : h(Btn, {
              key: 'session',
              type: 'button',
              style: styles.smallButton,
              onClick: () => openSeries({ sessionId: viewed.sessionId }),
            }, t('historyOpenSession')),
            h(Btn, {
              key: 'back',
              type: 'button',
              style: styles.button,
              onClick: () => { void closeViewed() },
            }, t('historyBack')),
          ]),
          // A briefing starts by accounting for what yesterday's review left open (§3.1).
          carry.items.length === 0 || viewed !== null ? null : h('div', { key: 'carry', style: styles.row }, [
            h('span', { key: 'hint', style: styles.hint }, `${t('carryOverHint')} ${carry.items.length}`),
            h(Btn, { key: 'handle', type: 'button', style: styles.smallButton, onClick: () => { void handleCarryOver() } }, t('carryOverAction')),
            carry.review === null ? null : h(Btn, { key: 'open', type: 'button', style: styles.smallButton, onClick: () => openSeries(carry.review) }, t('carryOverOpen')),
          ]),
          // Recording and the meeting's own actions belong to the session's meeting, so they
          // step aside while a historical meeting is being read (§5.4).
        // Pause/resume and the switch guard are state changes a screen reader must hear.
        h('span', { key: 'status', style: styles.status, role: 'status', 'aria-live': 'polite' }, status),
        // The note pad is the handwriting pad and nothing else: one tool, one body, no tabs to
        // switch between. The terminology list lives with the other occasional settings, in
        // the More menu.
        notesOpen ? h('div', { key: 'tabbody', style: styles.tabBody }, [
          h(InkPad, {
            key: 'ink',
            t,
            onSave: saveNote,
            onRecognizeLocal: recognizeNote,
            recognizedText: lastNote,
            onRecognizedToTask: (text) => { void noteToTask(text) },
            onDismissRecognized: () => setLastNote(''),
          }),
        ]) : null,
        audioName === '' ? null : h('audio', {
          key: 'audio',
          ref: audio,
          controls: true,
          preload: 'none',
          style: styles.audio,
          src: `${PREFIX}/audio?name=${encodeURIComponent(audioName)}`,
          onTimeUpdate: (event) => setPlayhead(event.currentTarget.currentTime),
          onPlay: () => setPlaying(true),
          onPause: () => setPlaying(false),
          onEnded: () => setPlaying(false),
        }),
        // The roster and this meeting's speaker names feed the datalist that every name field
        // points at (task owners, speaker names). It used to be referenced but never rendered,
        // so those fields had no suggestions at all.
        h('datalist', {
          key: 'names',
          id: OWNER_LIST_ID,
        }, ownerSuggestions(speakers, people).map((name) => h('option', { key: name, value: name }))),
        // One tab per kind of meeting content, so the panel shows one thing at a time instead
        // of the transcript, the points, the assignments and the voices stacked together.
        h('div', { key: 'bodytabs', style: styles.tabs }, [
          ...BODY_TAB_VALUES.map((value) => h(Btn, {
            key: value,
            type: 'button',
            style: bodyTab === value ? styles.tabActive : styles.tab,
            onClick: () => setBodyTab(value),
          }, t(BODY_TAB_KEYS[value]))),
          // The score table belongs to the monthly review, so it appears with that type.
          meta.kind !== 'monthly' ? null : h(Btn, {
            key: 'scores',
            type: 'button',
            style: bodyTab === 'scores' ? styles.tabActive : styles.tab,
            onClick: () => setBodyTab('scores'),
          }, t('panelTabScores')),
        ]),
        ]),
        h('div', { key: 'scroll', style: styles.panelScroll }, [
        h('span', { key: 'rolehint', style: styles.hint }, t('roleHint')),
        h('div', { key: 'speaker', style: styles.row }, [
          h('span', { key: 'state', style: styles.status }, speakerText),
          speaker.phase === 'ready' ? null : h(Btn, {
            key: 'prepare',
            type: 'button',
            style: styles.button,
            disabled: speaker.phase === 'downloading',
            onClick: () => { void prepareSpeakers() },
          }, t('speakerEnable')),
        ]),
        bodyTab !== 'transcript' ? null : segments.length === 0
          ? h('p', { key: 'empty', style: styles.empty }, t('empty'))
          : h('div', { key: 'transcript', style: styles.list }, [
            // Two jobs in one bar: keep the newest voice in view, and let several cues become
            // one assignment (§5.7).
            h('div', { key: 'tools', style: styles.row }, [
              h(Btn, {
                key: 'follow',
                type: 'button',
                style: follow ? styles.buttonActive : styles.button,
                'aria-pressed': follow,
                onClick: () => {
                  const next = follow !== true
                  followRef.current = next
                  setFollow(next)
                  if (next) {
                    const box = listRef.current
                    if (box !== null) box.scrollTop = box.scrollHeight
                  }
                },
              }, t('followNewest')),
              selectedCueIds.size === 0
                ? h('span', { key: 'hint', style: styles.hint }, t('mergeHint'))
                : h('span', { key: 'count', style: styles.status }, `${t('mergeSelected')} ${selectedCueIds.size}`),
              selectedCueIds.size < 2 ? null : h(Btn, {
                key: 'merge',
                type: 'button',
                style: styles.button,
                onClick: () => { void mergeSelectedCues() },
              }, t('mergeToTask')),
              selectedCueIds.size === 0 ? null : h(Btn, {
                key: 'clear',
                type: 'button',
                style: styles.smallButton,
                onClick: () => setSelectedCueIds(new Set()),
              }, t('clearSelection')),
              follow ? null : h(Btn, {
                key: 'jump',
                type: 'button',
                style: styles.smallButton,
                onClick: () => {
                  followRef.current = true
                  setFollow(true)
                  const box = listRef.current
                  if (box !== null) box.scrollTop = box.scrollHeight
                },
              }, t('jumpToNewest')),
            ]),
            h('div', {
              key: 'list',
              ref: listRef,
              style: styles.transcriptBox,
              onScroll: onTranscriptScroll,
            }, visible.map((segment, index) => h('div', {
              key: segment.id,
              ref: (element) => { rows.current[index] = element },
              style: index === activeIndex ? styles.segmentActive : styles.segment,
              className: 'mr-hover',
              title: t('seekHint'),
              onClick: () => seekTo(segment.start),
            }, [
              // Ticking is how a group of cues becomes one task; it must not also seek.
              h(Field, {
                key: 'pick',
                type: 'checkbox',
                title: t('selectCue'),
                checked: selectedCueIds.has(segment.id),
                onClick: (event) => event.stopPropagation(),
                onChange: () => toggleCue(segment.id),
              }),
              h('span', { key: 'time', style: styles.stamp }, clock(segment.start)),
              typeof segment.speaker === 'string' && segment.speaker !== ''
                ? h('span', { key: 'speaker', style: styles.chip }, segment.speaker)
                : null,
              h('span', {
                key: 'text',
                title: seenOf(segment) === segment.text ? undefined : segment.text,
              }, seenOf(segment)),
              // Every cue is its own candidate assignment.
              h(Btn, {
                key: 'toTask',
                type: 'button',
                style: styles.smallButton,
                onClick: (event) => {
                  // The row seeks the recording; making an assignment must not also seek.
                  event.stopPropagation()
                  void makeTaskFrom(seenOf(segment))
                },
              }, t('inkToTask')),
            ]))),
          ]),
        bodyTab !== 'names' ? null : h('div', { key: 'names', style: styles.list }, [
          // The form is the page: naming voices is a straightforward task, and a button that
          // only revealed the fields was a step in the way.
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'title', style: styles.label }, t('speakerNames')),
            h(Btn, {
              key: 'relabel',
              type: 'button',
              style: styles.button,
              disabled: relabeling,
              onClick: () => { void relabelRecording() },
            }, relabeling ? t('speakerRelabeling') : t('speakerRelabel')),
          ]),
          labels.length === 0
            // An empty tab must explain itself: labels appear once someone speaks and pauses,
            // and the relabel button is the repair path when the online pass left it blank.
            ? h('span', { key: 'empty', style: styles.hint }, t('speakerNamesEmpty'))
            : h('div', { key: 'body', style: styles.list }, [
              // The voice library offers names it recognises; nothing is written until a person
              // accepts one. A wrong guess that applied itself would cost a correction each time.
              suggestions.length === 0 ? null : h('div', { key: 'suggestions', style: styles.list }, [
                h('span', { key: 'label', style: styles.label }, t('voiceSuggestions')),
                ...suggestions.map((item) => h('div', { key: `${item.label}-${item.name}`, style: styles.row }, [
                  h('span', { key: 'text', style: styles.status }, `${item.label} ${t('voiceSoundsLike')} ${item.name}（${item.score}）`),
                  h(Btn, {
                    key: 'accept',
                    type: 'button',
                    style: styles.smallButton,
                    disabled: viewed !== null,
                    onClick: () => { void nameSpeaker(item.label, item.name) },
                  }, t('voiceAccept')),
                ])),
              ]),
            h('span', { key: 'hint', style: styles.hint }, t('speakerNameHint')),
            ...labels.map((label) => h('div', { key: label, style: styles.row }, [
            h('span', { key: 'label', style: styles.chip }, label),
            h(Field, {
              key: 'name',
              style: styles.inlineWide,
              className: 'mr-input-compact',
              value: draftNames[label] ?? speakers[label] ?? '',
              placeholder: t('speakerNamePlaceholder'),
              spellCheck: false,
              list: OWNER_LIST_ID,
              onChange: (event) => setDraftNames((value) => ({ ...value, [label]: event.target.value })),
            }),
            h(Btn, {
              key: 'save',
              type: 'button',
              style: styles.button,
              onClick: () => { void nameSpeaker(label, draftNames[label] ?? speakers[label] ?? '') },
            }, t('robotSave')),
            ])),
          ]),
        ]),
        // Minutes are their own tab, beside the transcript they are written from (§5.7):
        // the list of documents, the button that writes one, and the one being read.
        bodyTab !== 'minutes' ? null : h('div', { key: 'minutes', style: styles.list }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'title', style: styles.label }, `${t('panelTabMinutes')} (${documents.length})`),
            viewed !== null ? null : h(Btn, {
              key: 'write',
              type: 'button',
              style: styles.button,
              onClick: () => { void writeMinutes() },
            }, t('minutes')),
            viewed !== null || documents.length === 0 ? null : h(Btn, {
              key: 'docx',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void writeMinutes('docx') },
            }, t('minutesDocx')),
          ]),
          documents.length === 0
            ? h('span', { key: 'empty', style: styles.hint }, t('minutesEmpty'))
            : h('div', { key: 'docs', style: styles.list }, documents.map((entry) => h('div', { key: entry.id, style: styles.row }, [
              h('span', { key: 'title', style: { flex: 1 } }, entry.title),
              h('span', { key: 'name', style: styles.chip }, entry.name),
              h(Btn, {
                key: 'open',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { void openStoredDocument(entry) },
              }, t('openDocument')),
            ]))),
          openDocument === null ? null : h('div', { key: 'docview', style: styles.help }, openDocument),
        ]),
        bodyTab !== 'points' ? null : h('div', { key: 'points', style: styles.list }, [
          h('div', { key: 'title', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, `${t('points')} (${points.length})`),
            // The empty state used to point at a button that did not exist; this is it (§5.7).
            viewed !== null ? null : h(Btn, {
              key: 'extract',
              type: 'button',
              style: styles.smallButton,
              disabled: segments.length === 0,
              onClick: () => { void extractNow() },
            }, t('extractNow')),
          ]),
          points.length === 0
            // An empty tab must explain itself and stay usable: no recording yet, nothing
            // extracted yet, or the person simply wants to type an entry in.
            ? h('p', { key: 'hint', style: styles.empty }, segments.length === 0 ? t('pointsNoRecording') : t('noAnalysis'))
            : null,
          ...points.map((point) => (editingPoint === point.id ? h('div', {
            key: point.id,
            style: styles.taskEdit,
          }, [
            h(Field, {
              key: 'text',
              type: 'text',
              style: styles.inlineWide,
              value: pointDraft.text,
              placeholder: t('pointTextPh'),
              spellCheck: false,
              onChange: (event) => setPointDraft((value) => ({ ...value, text: event.target.value })),
            }),
            h(Picker, {
              key: 'kind',
              style: styles.inlineInput,
              value: pointDraft.kind,
              onChange: (event) => setPointDraft((value) => ({ ...value, kind: event.target.value })),
            }, POINT_KIND_VALUES.map((value) => h('option', { key: value, value }, t(`point_${value}`)))),
            h(Btn, {
              key: 'save',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void savePointEdit() },
            }, t('saveEntry')),
            h(Btn, {
              key: 'cancel',
              type: 'button',
              style: styles.smallButton,
              onClick: () => setEditingPoint(''),
            }, t('cancelEntry')),
          ]) : h('div', {
            key: point.id,
            style: point.status === 'confirmed' ? styles.segment : styles.taskDone,
          }, [
            h(Field, {
              key: 'done',
              type: 'checkbox',
              checked: point.status === 'confirmed',
              title: t('confirm'),
              onChange: (event) => { void editEntry('point', point.id, { status: event.target.checked ? 'confirmed' : 'draft' }) },
            }),
            h('span', { key: 'kind', style: styles.chip }, t(`point_${point.kind}`)),
            h('span', { key: 'text', style: { flex: 1 } }, point.text),
            h('span', { key: 'origin', style: styles.chip }, point.origin === 'agent' ? t('originAgent') : point.origin === 'manual' ? t('originManual') : t('originRule')),
            h(Btn, {
              key: 'edit',
              type: 'button',
              style: styles.smallButton,
              onClick: () => beginPointEdit(point),
            }, t('editEntry')),
            h(Btn, {
              key: 'del',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void editEntry('point', point.id, {}, 'remove') },
            }, t('remove')),
          ]))),
          // Hand-writing an entry is always possible: no recording, or nothing extracted yet.
          // The exception is a viewed history, which is read-only (§5.4).
          viewed !== null ? null : h('div', { key: 'add', style: styles.row }, [
            h(Field, {
              key: 'text',
              type: 'text',
              style: styles.inlineWide,
              value: newPoint.text,
              placeholder: t('pointTextPh'),
              spellCheck: false,
              onChange: (event) => setNewPoint((value) => ({ ...value, text: event.target.value })),
              onKeyDown: (event) => { if (event.key === 'Enter') void addPoint() },
            }),
            h(Picker, {
              key: 'kind',
              style: styles.inlineInput,
              value: newPoint.kind,
              onChange: (event) => setNewPoint((value) => ({ ...value, kind: event.target.value })),
            }, POINT_KIND_VALUES.map((value) => h('option', { key: value, value }, t(`point_${value}`)))),
            h(Btn, {
              key: 'save',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void addPoint() },
            }, t('addEntry')),
          ]),
        ]),
        bodyTab !== 'tasks' ? null : h('div', { key: 'tasks', style: styles.list }, [
          h('div', { key: 'title', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, `${t('tasks')} (${tasks.filter((task) => task.status === 'confirmed').length}/${tasks.length})`),
            viewed !== null ? null : h(Btn, {
              key: 'extract',
              type: 'button',
              style: styles.smallButton,
              disabled: segments.length === 0,
              onClick: () => { void extractNow() },
            }, t('extractNow')),
            // One click sends EVERY confirmed assignment out, in the way the management page's robot
            // settings chose — including while a past meeting is open, which sends that past
            // meeting's own assignments.
            h(Btn, {
              key: 'push',
              type: 'button',
              style: styles.button,
              disabled: tasks.every((task) => task.status !== 'confirmed'),
              title: t('pushNowHint'),
              onClick: () => { void pushTasksNow() },
            }, t('pushNow')),
          ]),
          tasks.length === 0
            ? h('p', { key: 'hint', style: styles.empty }, segments.length === 0 ? t('tasksNoRecording') : t('tasksEmpty'))
            : null,
          // No edit mode and no save button: every field is a live control that writes on
          // change, and the title writes on blur so typing does not round-trip per keystroke.
          ...tasks.map((task) => {
            const owners = ownerSuggestions(speakers, people)
            if (task.owner !== '' && !owners.includes(task.owner)) owners.push(task.owner)
            const presets = duePresets()
            // A stored value outside the quick list — a free-text 周五 or an exact minute —
            // keeps its own entry, so the select never shows a value the row does not hold.
            const customDue = task.due !== '' && !presets.some((entry) => entry.value === task.due)
            // Asking for a custom time keeps the picker open even when the value it starts from
            // happens to coincide with a preset.
            const showDuePicker = customDueIds.includes(task.id) || customDue
            return h('div', {
              key: task.id,
              style: task.status === 'confirmed' ? styles.taskRow : styles.taskRowDraft,
            }, [
              h(Field, {
                key: 'confirmed',
                type: 'checkbox',
                checked: task.status === 'confirmed',
                title: t('confirm'),
                onChange: (event) => { void editEntry('task', task.id, { status: event.target.checked ? 'confirmed' : 'draft' }) },
              }),
              // Checked off is a separate fact from confirmed (§2.3): a review meeting ticks
              // what got done without touching the status it was accepted with.
              h(Field, {
                key: 'done',
                type: 'checkbox',
                checked: task.done === true,
                disabled: viewed !== null,
                title: task.done === true
                  ? `${t('taskDoneAt')}${typeof task.doneAt === 'number' ? ` ${new Date(task.doneAt).toLocaleString()}` : ''}`
                  : t('taskMarkDone'),
                onChange: (event) => { void editEntry('task', task.id, { done: event.target.checked }) },
              }),
              h(Field, {
                key: 'title',
                type: 'text',
                style: styles.taskTitleInput,
                defaultValue: task.title,
                readOnly: viewed !== null,
                placeholder: t('taskTitlePh'),
                spellCheck: false,
                title: task.status === 'draft' ? t('taskDraft') : t('taskConfirmed'),
                onBlur: (event) => {
                  const next = event.target.value.trim()
                  if (next !== '' && next !== task.title) void editEntry('task', task.id, { title: next })
                  else event.target.value = task.title
                },
              }),
              // Where the assignment came from (§5.7): a rule, the agent, or a person.
              h('span', { key: 'origin', style: styles.chip }, t(task.origin === 'agent' ? 'originAgent' : task.origin === 'rule' ? 'originRule' : 'originManual')),
              h(Picker, {
                key: 'owner',
                style: styles.inlineInput,
                value: task.owner,
                title: t('ownerPh'),
                onChange: (event) => { void editEntry('task', task.id, { owner: event.target.value }) },
              }, [
                h('option', { key: '', value: '' }, t('ownerPh')),
                ...owners.map((name) => h('option', { key: name, value: name }, name)),
              ]),
              // Time is a quick choice; the exact date and time picker appears only when the
              // user asks for it, or when the stored value is already something specific.
              h(Picker, {
                key: 'due',
                style: styles.inlineInput,
                value: showDuePicker ? CUSTOM_DUE : task.due,
                title: t('duePh'),
                onChange: (event) => {
                  const next = event.target.value
                  if (next !== CUSTOM_DUE) {
                    setCustomDueIds((ids) => ids.filter((id) => id !== task.id))
                    void editEntry('task', task.id, { due: next })
                    return
                  }
                  setCustomDueIds((ids) => (ids.includes(task.id) ? ids : [...ids, task.id]))
                  // The sentinel opens the picker on a real value, keeping the
                  // default-selected behaviour rather than leaving the field blank.
                  void editEntry('task', task.id, { due: dueDraftOf(task.due).replace('T', ' ') })
                },
              }, [
                ...presets.map((entry) => h('option', { key: entry.key, value: entry.value }, t(entry.key))),
                h('option', { key: 'custom', value: CUSTOM_DUE }, t('dueCustom')),
              ]),
              showDuePicker ? h(Field, {
                key: 'duepicker',
                type: 'datetime-local',
                style: styles.inlineInput,
                value: dueDraftOf(task.due),
                spellCheck: false,
                onChange: (event) => { void editEntry('task', task.id, { due: event.target.value.replace('T', ' ') }) },
              }) : null,
              h(Picker, {
                key: 'priority',
                style: styles.inlineInput,
                value: TASK_PRIORITY_VALUES.includes(task.priority) ? task.priority : 'normal',
                title: t('priority'),
                onChange: (event) => { void editEntry('task', task.id, { priority: event.target.value }) },
              }, TASK_PRIORITY_VALUES.map((value) => h('option', { key: value, value }, t(PRIORITY_KEYS[value])))),
              h(Btn, {
                key: 'pushone',
                type: 'button',
                style: styles.smallButton,
                // Only confirmed work is ever sent, so an unconfirmed row says why instead of
                // offering a button that would be refused.
                disabled: task.status !== 'confirmed',
                title: task.status === 'confirmed' ? t('pushOneHint') : t('pushOneNeedsConfirm'),
                onClick: () => { void pushTasksNow(task.id) },
              }, t('pushOne')),
              h(Btn, {
                key: 'del',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { void editEntry('task', task.id, {}, 'remove') },
              }, t('remove')),
            ])
          }),
          // The same promise as the points tab: this tab is never a dead end. A viewed
          // history is the one exception — adding there would write to another meeting (§5.4).
          viewed !== null ? null : h('div', { key: 'add', style: styles.row }, [
            h(Field, {
              key: 'text',
              type: 'text',
              style: styles.inlineWide,
              value: newTask,
              placeholder: t('taskTitlePh'),
              spellCheck: false,
              onChange: (event) => setNewTask(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void addTask() },
            }),
            h(Btn, {
              key: 'save',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void addTask() },
            }, t('addEntry')),
          ]),
        ]),
        bodyTab !== 'scores' ? null : h('div', { key: 'scores', style: styles.list, role: 'table', 'aria-label': t('panelTabScores') }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'title', style: styles.label }, `${t('panelTabScores')} (${scores.length})`),
            viewed !== null ? null : h(Btn, { key: 'prefill', type: 'button', style: styles.button, onClick: () => { void prefillScores() } }, t('scoresPrefill')),
            viewed !== null ? null : h(Btn, { key: 'csv', type: 'button', style: styles.smallButton, onClick: () => { void exportScores('csv') } }, t('scoresExportCsv')),
            viewed !== null ? null : h(Btn, { key: 'xlsx', type: 'button', style: styles.smallButton, onClick: () => { void exportScores('xlsx') } }, t('scoresExportXlsx')),
          ]),
          h('span', { key: 'hint', style: styles.hint }, t('scoresHint')),
          // Column headers, so the table reads as a table rather than a row of unnamed
          // number boxes (§5.1).
          scores.length === 0 ? null : h('div', { key: 'headers', style: styles.scoreHeadRow, role: 'row' }, [
            h('span', { key: 'pad', style: styles.scoreHead, role: 'presentation', 'aria-hidden': 'true' }, ''),
            h('span', { key: 'person', style: styles.scoreHead, role: 'columnheader', id: 'score-col-person' }, t('scorePerson')),
            h('span', { key: 'hours', style: styles.scoreHead, role: 'columnheader', id: 'score-col-hours' }, t('scoreHours')),
            h('span', { key: 'completion', style: styles.scoreHead, role: 'columnheader', id: 'score-col-completion' }, t('scoreCompletion')),
            h('span', { key: 'quality', style: styles.scoreHead, role: 'columnheader', id: 'score-col-quality' }, t('scoreQuality')),
            h('span', { key: 'learn', style: styles.scoreHead, role: 'columnheader', id: 'score-col-learn' }, t('scoreLearn')),
            h('span', { key: 'total', style: styles.scoreHead, role: 'columnheader', id: 'score-col-total' }, t('scoreTotal')),
            h('span', { key: 'highlight', style: styles.scoreHead, role: 'columnheader', id: 'score-col-highlight' }, t('scoreHighlight')),
            h('span', { key: 'improve', style: styles.scoreHead, role: 'columnheader', id: 'score-col-improve' }, t('scoreImprove')),
            h('span', { key: 'basis', style: styles.scoreHead, role: 'columnheader', id: 'score-col-basis' }, t('scoreBasis')),
          ]),
          scores.length === 0 ? null : h('div', { key: 'rows', style: styles.list, role: 'rowgroup' }, scores.map((row) => h('div', {
            key: row.person,
            role: 'row',
            style: row.status === 'confirmed' ? styles.segment : styles.taskDone,
          }, [
            h(Field, {
              key: 'confirmed',
              type: 'checkbox',
              checked: row.status === 'confirmed',
              // Evidence is required to confirm a row (§2.4): without it the box says why
              // instead of sending a request the host would refuse.
              disabled: row.status !== 'confirmed' && (row.basis ?? []).length === 0,
              title: row.status !== 'confirmed' && (row.basis ?? []).length === 0 ? t('scoreBasisRequired') : t('confirm'),
              'aria-label': `${t('confirm')}：${row.person}`,
              onChange: (event) => { void editScore(row.person, { status: event.target.checked ? 'confirmed' : 'draft' }) },
            }),
            h('span', { key: 'person', style: styles.chip, role: 'rowheader' }, row.person),
            // Each control names its column and person for screen readers; the column headers
            // above are visual only, because a div grid cannot associate them by itself.
            h(Field, { key: 'hours', type: 'number', style: styles.inlineInput, value: scoreValueOf(row.person, 'hours', String(row.hours ?? 0)), title: t('scoreHours'), 'aria-label': `${t('scoreHours')}：${row.person}`, onChange: (event) => setScoreDraft(row.person, 'hours', event.target.value), onBlur: (event) => commitScore(row.person, 'hours', { hours: Number(event.target.value) }) }),
            h(Field, { key: 'completion', type: 'number', style: styles.inlineInput, value: scoreValueOf(row.person, 'completion', String(row.completion ?? 0)), title: t('scoreCompletion'), 'aria-label': `${t('scoreCompletion')}：${row.person}`, onChange: (event) => setScoreDraft(row.person, 'completion', event.target.value), onBlur: (event) => commitScore(row.person, 'completion', { completion: Number(event.target.value) }) }),
            h(Field, { key: 'quality', type: 'number', style: styles.inlineInput, value: scoreValueOf(row.person, 'quality', String(row.quality ?? 0)), title: t('scoreQuality'), 'aria-label': `${t('scoreQuality')}：${row.person}`, onChange: (event) => setScoreDraft(row.person, 'quality', event.target.value), onBlur: (event) => commitScore(row.person, 'quality', { quality: Number(event.target.value) }) }),
            h(Field, { key: 'learn', type: 'number', style: styles.inlineInput, value: scoreValueOf(row.person, 'learn', String(row.learn ?? 0)), title: t('scoreLearn'), 'aria-label': `${t('scoreLearn')}：${row.person}`, onChange: (event) => setScoreDraft(row.person, 'learn', event.target.value), onBlur: (event) => commitScore(row.person, 'learn', { learn: Number(event.target.value) }) }),
            // The weighted total is a default: a person may override it, and clearing the
            // box goes back to the computed value (§2.4).
            h(Field, {
              key: 'total',
              type: 'number',
              style: styles.inlineInput,
              // Empty means "computed"; the computed value shows as the placeholder.
              value: scoreValueOf(row.person, 'total', row.totalOverride === true ? String(row.total ?? '') : ''),
              placeholder: String(row.total ?? 0),
              title: row.totalOverride === true ? t('scoreTotalManual') : t('scoreTotalAuto'),
              'aria-label': `${t('scoreTotal')}：${row.person}`,
              onChange: (event) => setScoreDraft(row.person, 'total', event.target.value),
              onBlur: (event) => {
                const text = event.target.value.trim()
                commitScore(row.person, 'total', { total: text === '' ? null : Number(text) })
              },
            }),
            h(Field, { key: 'highlight', type: 'text', style: styles.inlineWide, value: scoreValueOf(row.person, 'highlight', row.highlight ?? ''), placeholder: t('scoreHighlight'), 'aria-label': `${t('scoreHighlight')}：${row.person}`, spellCheck: false, onChange: (event) => setScoreDraft(row.person, 'highlight', event.target.value), onBlur: (event) => commitScore(row.person, 'highlight', { highlight: event.target.value }) }),
            h(Field, { key: 'improve', type: 'text', style: styles.inlineWide, value: scoreValueOf(row.person, 'improve', row.improve ?? ''), placeholder: t('scoreImprove'), 'aria-label': `${t('scoreImprove')}：${row.person}`, spellCheck: false, onChange: (event) => setScoreDraft(row.person, 'improve', event.target.value), onBlur: (event) => commitScore(row.person, 'improve', { improve: event.target.value }) }),
            // The evidence is editable here because it is what makes the score traceable:
            // several entries are separated by a semicolon or a new line (§2.4).
            h(Field, {
              key: 'basis',
              type: 'text',
              style: styles.inlineWide,
              value: scoreValueOf(row.person, 'basis', (row.basis ?? []).join('；')),
              placeholder: t('scoreBasisPlaceholder'),
              title: `${t('scoreBasis')}: ${(row.basis ?? []).join('\n')}`,
              'aria-label': `${t('scoreBasis')}：${row.person}`,
              spellCheck: false,
              onChange: (event) => setScoreDraft(row.person, 'basis', event.target.value),
              onBlur: (event) => {
                const basis = event.target.value.split(/[；;\n]/u).map((entry) => entry.trim()).filter((entry) => entry !== '')
                commitScore(row.person, 'basis', { basis })
              },
            }),
            (row.basis ?? []).length === 0
              ? h('span', { key: 'basisbad', style: styles.error }, t('scoreBasisMissing'))
              : h('span', { key: 'basis', style: styles.chip, title: (row.basis ?? []).join('\n') }, `${t('scoreBasis')} ${(row.basis ?? []).length}`),
            h(Btn, { key: 'del', type: 'button', style: styles.smallButton, onClick: () => { void removeScore(row.person) } }, t('remove')),
          ]))),
          viewed === null ? h('div', { key: 'add', style: styles.row }, [
            h(Field, {
              key: 'person',
              type: 'text',
              style: styles.inlineWide,
              value: newScorePerson,
              placeholder: t('scoresAddPerson'),
              spellCheck: false,
              onChange: (event) => setNewScorePerson(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void addScore() },
            }),
            h(Btn, { key: 'add', type: 'button', style: styles.smallButton, onClick: () => { void addScore() } }, t('addEntry')),
          ]) : null,
        ]),
        notes.length === 0 ? null : h('div', { key: 'notes', style: styles.list }, [
          h('div', { key: 'label', style: styles.label }, `${t('inkNote')} (${notes.length})`),
          ...notes.map((entry) => h('div', { key: entry.id, style: styles.segment }, [
            h('span', { key: 'text', style: { flex: 1 } }, entry.text),
            h(Btn, {
              key: 'toTask',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void makeTaskFrom(entry.text) },
            }, t('inkToTask')),
          ])),
        ]),
        note === '' ? null : h('p', { key: 'note', style: styles.note }, note),
        speech.ready === false ? h('div', { key: 'sp', style: styles.help }, [
          h('p', { style: styles.subtitle }, speech.requesting
            ? (speechDetail !== '' ? speechDetail : t('speechPreparing'))
            // Each unresolved state says what it actually is: still checking, the route is
            // missing (a broken install, and the person can fix it), or the service is out.
            : speech.phase === 'checking' ? t('speechChecking')
              : speech.phase === 'missing' ? t('speechRouteMissing')
                : speech.phase === 'unavailable' ? t('speechUnavailableHint')
                  : t('speechPrepareHint')),
          pendingStart ? h('p', { style: styles.status }, t('speechAutoStart')) : null,
          h('div', { style: styles.row }, [
            h(Btn, { key: 'dl', type: 'button', style: styles.button, disabled: speech.requesting, onClick: () => { void prepareSpeech() } }, speech.requesting ? t('preparingInPanel') : t('speechPrepareAction')),
            pendingStart ? h(Btn, { key: 'cn', type: 'button', style: styles.button, onClick: () => setPendingStart(false) }, t('speechCancel')) : null,
            typeof props.openVoiceInputBundle === 'function' && !speech.requesting && !pendingStart ? h(Btn, { key: 'dt', type: 'button', style: styles.linkButton, onClick: () => props.openVoiceInputBundle() }, t('setupDetails')) : null,
          ]),
        ]) : error === '' ? null : h('p', { key: 'error', style: styles.error }, `${t('error')}: ${error}`),
        // The terminology list: a dialog now, opened from the More menu. Edits land in the
        // meeting as they are typed, so closing it is the whole save story.
        termsOpen ? h(Dialog, {
          key: 'termsdialog',
          title: t('tabTerms'),
          wide: true,
          onClose: () => setTermsOpen(false),
          children: [
            h('span', { key: 'hint', style: styles.hint }, t('termsHint')),
            h(Field, {
              key: 'input',
              style: styles.termsArea,
              value: termsText,
              spellCheck: false,
              onChange: (event) => setTermsText(event.target.value),
            }),
          ],
          footer: [h(Btn, {
            key: 'ok',
            type: 'button',
            style: styles.button,
            onClick: () => setTermsOpen(false),
          }, t('hubClose'))],
        }) : null,
        // Notices float at the document root so nothing in the panel can cover them, and sit
        // below dialogs in the layering (4000 against 5000). A sticky notice uses this
        // plugin's own card, because the host Toast fades on its own schedule — the one
        // thing a stop-in-progress notice must not do.
        toasts.length === 0 ? null : float(h('div', { key: 'toasts', style: styles.toasts, role: 'status', 'aria-live': 'polite' }, toasts.map((item) => (
          HostToast === null || item.sticky === true
            ? h('div', {
              key: item.id,
              className: 'mr-card',
              style: styles.toastCard,
              onClick: () => dismissToast(item.id),
            }, item.text)
            : h(HostToast, { key: item.id, text: item.text, onDone: () => dismissToast(item.id) })
        )))),
        // The About dialog: what is installed, who made it, and how to reach them. A preview
        // build lives on feedback, so the address is a button rather than small print.
        aboutOpen ? h(Dialog, {
          key: 'aboutdialog',
          title: t('about'),
          wide: true,
          onClose: () => setAboutOpen(false),
          children: [
            h('div', { key: 'lines', style: styles.list }, [
              h('span', { key: 'name', style: styles.label }, t('aboutName')),
              h('span', { key: 'version', style: styles.fieldBlock }, `${t('aboutVersion')}：${about.version === '' ? '—' : about.version}`),
              h('span', { key: 'author', style: styles.fieldBlock }, `${t('aboutAuthor')}：${ABOUT_AUTHOR}（${t('aboutLab')}）`),
              h('span', { key: 'license', style: styles.fieldBlock }, `${t('aboutLicense')}：MIT`),
              // The address in the body too, so it can be read and copied without the button.
              h('span', { key: 'email', style: styles.fieldBlock }, `${t('aboutMail')}：${ABOUT_EMAIL}`),
            ]),
            h('p', { key: 'feedback', style: styles.note }, t('aboutFeedback')),
          ],
          footer: [
            h(Btn, {
              key: 'mail',
              type: 'button',
              style: styles.button,
              onClick: () => {
                const subject = encodeURIComponent(`dsh-meeting-room ${about.version === '' ? '' : about.version} 反馈`)
                window.open(`mailto:${ABOUT_EMAIL}?subject=${subject}`, '_blank')
              },
            }, `${t('aboutMail')} ${ABOUT_EMAIL}`),
            h(Btn, {
              key: 'close',
              type: 'button',
              style: styles.button,
              onClick: () => setAboutOpen(false),
            }, t('hubClose')),
          ],
        }) : null,
        // The tutorial is a dialog, not a block inside the panel: it is read once, and it
        // should not push the meeting's own content down while it is open.
        helpOpen ? h(Dialog, {
          key: 'helpdialog',
          title: t('helpToggle'),
          // The tutorial is the one dialog with a page of text in it.
          wide: true,
          onClose: () => setHelpOpen(false),
          children: h('p', { key: 'body', style: styles.help }, t('helpBody')),
          footer: [h(Btn, {
            key: 'ok',
            type: 'button',
            style: styles.button,
            onClick: () => setHelpOpen(false),
          }, t('hubClose'))],
        }) : null,
        switchPrompt === null ? null : h(Dialog, {
          key: 'switchprompt',
          title: t('historyGuardTitle'),
          description: t('historyGuardBody'),
          // Every card is the same width, so a prompt never looks like a different app.
          wide: true,
          onClose: () => setSwitchPrompt(null),
          children: h('p', { key: 'count', style: styles.status }, `⏳ ${switchPrompt.seconds}`),
          footer: [
            h(Btn, {
              key: 'now',
              type: 'button',
              style: styles.button,
              onClick: () => setSwitchPrompt((value) => (value === null ? null : { ...value, seconds: 0 })),
            }, t('historyGuardNow')),
            h(Btn, {
              key: 'discard',
              type: 'button',
              style: styles.button,
              // Saving is the default, not the only option: this meeting may be a scratch one.
              onClick: () => {
                const row = switchPrompt.row
                setSwitchPrompt(null)
                void openHistorical(row)
              },
            }, t('historyGuardDiscard')),
            h(Btn, {
              key: 'cancel',
              type: 'button',
              style: styles.button,
              onClick: () => setSwitchPrompt(null),
            }, t('cancelEntry')),
          ],
        }),
        namePrompt === null ? null : h(Dialog, {
          key: 'nameprompt',
          // One line of title, nothing else: the description line pushed the fields down
          // and read as noise once the name was the only thing being asked for.
          title: t('meetingNameTitle'),
          // The same width as every other card; the fields inside stay compact.
          wide: true,
          onClose: () => setNamePrompt(null),
          children: [
            h(Field, {
              key: 'text',
              type: 'text',
              style: styles.inlineWide,
              className: 'mr-input-compact',
              value: namePrompt.text,
              placeholder: t('meetingNamePlaceholder'),
              spellCheck: false,
              onChange: (event) => setNamePrompt((current) => ({ ...current, text: event.target.value })),
            }),
            // Naming is optional: saying so here is what lets a person start immediately and
            // trust that the meeting will not stay nameless.
            namePrompt.start === false ? null : h('span', { key: 'autohint', style: styles.hint }, t('meetingNameAutoHint')),
            // The seat steers the review prompt, so it is chosen here — with the name the
            // meeting is starting under (§5.5). Three buttons cover the usual seats; the
            // narrow field next to them is for a seat of one's own, and it wins when filled.
            h('div', { key: 'roleblock', style: styles.fieldBlock }, [
              h('span', { key: 'rolelabel', style: styles.label }, t('roleLabel')),
              h('div', { key: 'seats', className: 'mr-chips' }, [
                ...['host', 'attendee', 'observer'].map((seat) => h(Btn, {
                  key: seat,
                  type: 'button',
                  style: (namePrompt.roleOther ?? '').trim() === '' && (namePrompt.role ?? 'attendee') === seat
                    ? styles.buttonActive
                    : styles.button,
                  onClick: () => setNamePrompt((current) => ({ ...current, role: seat, roleOther: '' })),
                }, t(ROLE_LABEL_KEYS[seat]))),
                h(Field, {
                  key: 'roleother',
                  type: 'text',
                  style: styles.inlineInput,
                  className: 'mr-input-compact',
                  value: namePrompt.roleOther ?? '',
                  placeholder: t('roleOtherPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => setNamePrompt((current) => ({ ...current, roleOther: event.target.value })),
                }),
              ]),
            ]),
            // The type row carries its own label, so the five chips read as one question rather
            // than as five more buttons in the dialog.
            h('div', { key: 'kindblock', style: styles.fieldBlock }, [
              h('span', { key: 'kindlabel', style: styles.label }, t('kindLabel')),
              h('div', { key: 'chips', className: 'mr-chips' }, KIND_VALUES.map((value) => h(Btn, {
                key: value === '' ? 'general' : value,
              type: 'button',
              style: namePrompt.kind === value ? styles.buttonActive : styles.button,
              onClick: () => setNamePrompt((current) => ({
                ...current,
                kind: value,
                // Choosing a type names the meeting after it: the title is a default the
                // person can still edit, and a name left over from another type is worse.
                text: `${t(NAMING_LABEL_KEYS[value])} · ${new Date().toLocaleDateString()}`,
              })),
            }, t(NAMING_LABEL_KEYS[value])))),
            ]),
          ],
          footer: [
          h(Btn, {
            key: 'go',
              type: 'button',
              style: styles.button,
              onClick: () => {
                const draft = namePrompt
                setNamePrompt(null)
                void (async () => {
                  if (draft === null) return
                  // The seat is stored with the name, so both land before recording starts. A
                  // seat typed in the "other" field is the seat.
                  const typedSeat = typeof draft.roleOther === 'string' ? draft.roleOther.trim() : ''
                  const nextRole = typedSeat !== '' ? typedSeat : (typeof draft.role === 'string' && draft.role !== '' ? draft.role : role)
                  if (nextRole !== role) await chooseRole(nextRole)
                  if (draft.text.trim() !== '' || draft.kind !== '') {
                    await saveMeta({ title: draft.text.trim(), kind: draft.kind })
                  }
                  // Opened from the menu it only saves; opened by Start it also records.
                  if (draft.start !== false) await start()
                })()
              },
            }, namePrompt.start === false ? t('saveEntry') : t('start')),
            namePrompt.start === false ? null : h(Btn, {
              key: 'skip',
              type: 'button',
              style: styles.button,
              onClick: () => { setNamePrompt(null); void start() },
            }, t('meetingNameSkip')),
            h(Btn, {
              key: 'cancel',
              type: 'button',
              style: styles.button,
              onClick: () => setNamePrompt(null),
            }, t('cancelEntry')),
          ],
        }),
        ]),
      ]))
    }

    /**
     * Show the tab's title from the sidebar registry.
     * @param props - Framework-bound tab identity.
     * @returns the tab title.
     */
    function MeetingTabTitle(props) {
      const tab = props.useTabInfo()
      return h(React.Fragment, null, tab.tab.title)
    }

    /**
     * The start page's guide card for this panel. A single click arms the begin request
     * and opens the meeting tab; the panel then runs its normal start path, so the
     * microphone prompt, the meeting creation and the agent hand-off stay unchanged.
     * @param props - Framework copy plus the injected opener.
     * @returns one full-width card, matching the guide's own cards.
     */
    function GuideStartCard(props) {
      const t = props.t
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const title = typeof props.title === 'string' && props.title !== '' ? props.title : t('guideTitle')
      const description = typeof props.description === 'string' && props.description !== ''
        ? props.description
        : t('guideDescription')
      // The shell's own guide card, in the shell's own numbers (GuideBody.module.css):
      // 380px-wide cell, 56px minimum, 0.5px border, xl radius, 26px glyph, 14/11px text.
      // Inline styles are the only handle a client plugin has on those hashed classes.
      const baseBackground = 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))'
      return h('button', {
        type: 'button',
        'aria-label': title,
        'aria-busy': busy ? 'true' : undefined,
        title: description,
        disabled: busy,
        style: {
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: '100%',
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 20px',
          textAlign: 'left',
          font: 'inherit',
          color: 'var(--dsw-alias-label-primary, inherit)',
          background: hover && !busy ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))' : baseBackground,
          border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.24))',
          borderRadius: 'var(--dsw-radius-xl, 20px)',
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.7 : 1,
          transition: 'background 120ms ease',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => {
          if (busy) return
          setBusy(true)
          // Start the meeting in a fresh conversation: reuse nothing, so the new session
          // owns the transcript and the Agent's own reading of it.
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
          let workspaceId
          try {
            const snapshot = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((state) => state) : undefined
            const items = Array.isArray(snapshot?.items) ? snapshot.items : []
            workspaceId = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))?.workspaceId
          } catch (failure) {
            console.warn('meeting-room: could not read the workspace for the guide card', failure)
          }
          try {
            props.begin(workspaceId)
          } catch (failure) {
            console.warn('meeting-room: the guide card could not begin the meeting', failure)
            setBusy(false)
            return
          }
          // The card stays in the guide list, so it must become clickable again even when
          // the microphone prompt is declined — the panel reports that failure itself.
          setTimeout(() => setBusy(false), 2000)
        },
      }, [
        h('span', {
          key: 'icon',
          style: {
            width: 26, height: 26, flex: 'none', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--dsw-alias-label-secondary, currentColor)',
          },
        }, h(MeetingPanelIcon, { size: 26 })),
        h('span', {
          key: 'text',
          style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 3, minWidth: 0 },
        }, [
          h('span', {
            key: 'title',
            style: {
              fontSize: 14, lineHeight: 1.4, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, title),
          h('span', {
            key: 'description',
            style: {
              fontSize: 11, lineHeight: 1.4, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, busy ? t('guideOpening') : description),
        ]),
      ])
    }

    /**
     * Open the meeting panel from the session header.
     * @param props - Localized copy plus the injected opener.
     * @returns the header button.
     */
    function OpenMeetingButton(props) {
      // The management page cannot open the right column: the shell refuses to address it
      // until a conversation surface is mounted, and that page is holding the main area. This
      // button sits in the conversation's own header, so it is mounted exactly when opening
      // is possible — it watches for a meeting the page asked to open and opens the column.
      React.useEffect(() => {
        const timer = setInterval(() => {
          const pending = pendingMeeting.current
          if (pending !== null && pending.openedByHeader !== true) {
            pending.openedByHeader = true
            console.info('meeting-room: header opens the panel for', pending.meetingId)
            try {
              if (typeof props.openOnly === 'function') props.openOnly()
              else props.open()
            } catch (failure) {
              console.warn('meeting-room: the header could not open the meeting panel', failure)
            }
            return
          }
          // The start page's guide card starts a new conversation and then asks whoever
          // is mounted in that conversation to open the meeting tab — this button is the
          // one surface guaranteed to exist there, and it runs after the switch.
          if (guideBegin.pending === true && guideBegin.opened !== true) {
            if (Date.now() > guideBegin.deadline) { guideBegin.pending = false; return }
            guideBegin.opened = true
            try {
              if (typeof props.openOnly === 'function') props.openOnly()
              else props.open()
            } catch (failure) {
              console.warn('meeting-room: the header could not open the meeting panel', failure)
            }
          }
        }, 300)
        return () => clearInterval(timer)
      }, [props])
      return h(Btn, {
        type: 'button',
        style: styles.headerButton,
        title: props.t('open'),
        onClick: () => props.open(),
      }, props.t('open'))
    }

    /**
     * Catch a render failure inside a panel so the page shows the error instead of
     * going blank; a plugin fault should be visible and reportable, never silent.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, message: '' }
      }

      static getDerivedStateFromError(error) {
        return { failed: true, message: error instanceof Error ? error.message : String(error) }
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'mr-card' }, [
            h('div', { style: styles.label }, 'meeting-room render error'),
            h('pre', { style: styles.pre }, this.state.message),
          ])
        }
        return this.props.children
      }
    }

    /**
     * Draw the left-sidebar row glyph. The row's registered component *is* the icon,
     * and the shell renders it as the row's direct icon child.
     * @param props - Owner-supplied glyph size.
     * @returns the icon element.
     */
    function MeetingPanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [
        h('rect', { key: 'body', x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('path', { key: 'stand', d: 'M7 20h10' }),
        h('path', { key: 'pole', d: 'M12 16v4' }),
        h('path', { key: 'lines', d: 'M8 10.5h2.5M13.5 8.5h2.5M8 13h8' }),
      ])
    }

    /** Recognizer geometry, measured against the official preprocessor (design §9.2.3). */
    const RECOGNIZE_HEIGHT = 32
    const RECOGNIZE_CHUNKS = 3
    const WINDOW_WIDTH = 300
    const PAGE_WIDTH = 804
    const CHUNK_STRIDE = 252

    /**
     * Pen canvas for handwritten notes. Implements the Windows pen facts the design
     * pins down: coalesced sampling so fast strokes keep their points, the real 0–1024
     * pressure range, the eraser button bit rather than a pointer type, and scroll
     * suppression through `touch-action` instead of `preventDefault`.
     * @param props - Localized copy plus the save callback.
     * @returns the drawing surface and its controls.
     */
    function InkPad(props) {
      const t = props.t
      const canvas = React.useRef(null)
      const strokes = React.useRef([])
      const active = React.useRef(null)
      /** Strokes a lasso has picked up; the recognition and task actions act on this set. */
      const selected = React.useRef(new Set())
      /** Pending long-press timer, or null. */
      const longPress = React.useRef(null)
      /** Cached character groups, recomputed when the stroke list changes. */
      const groups = React.useRef([])
      const [tool, setTool] = React.useState('pen')
      const [count, setCount] = React.useState(0)

      /** Stroke width for one pressure sample; the range stays legible for a mouse too. */
      const widthOf = (pressure) => 1.2 + 3.4 * pressure

      /** Repaint the whole surface from the stored strokes. */
      const redraw = React.useCallback(() => {
        const element = canvas.current
        if (element === null) return
        const context = element.getContext('2d')
        const ratio = window.devicePixelRatio || 1
        const width = element.clientWidth
        const height = element.clientHeight
        if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
          element.width = Math.round(width * ratio)
          element.height = Math.round(height * ratio)
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        context.clearRect(0, 0, width, height)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        for (const stroke of strokes.current) {
          // A selected stroke keeps its shape but gains a translucent halo, so the lasso's
          // result is visible without redrawing the ink in a different colour.
          if (selected.current.has(stroke)) {
            context.strokeStyle = 'rgba(64,132,255,0.45)'
            for (let i = 1; i < stroke.points.length; i++) {
              const from = stroke.points[i - 1]
              const to = stroke.points[i]
              context.beginPath()
              context.lineWidth = widthOf(to.p) + 5
              context.moveTo(from.x, from.y)
              context.lineTo(to.x, to.y)
              context.stroke()
            }
          }
          context.strokeStyle = '#111111'
          for (let i = 1; i < stroke.points.length; i++) {
            const from = stroke.points[i - 1]
            const to = stroke.points[i]
            context.beginPath()
            context.lineWidth = widthOf(to.p)
            context.moveTo(from.x, from.y)
            context.lineTo(to.x, to.y)
            context.stroke()
          }
        }
        // Faint boxes mark what the ink alone says are separate characters: tapping one of
        // them selects it, so a lasso is optional rather than required. The groups are cached
        // because this runs on every pointer move.
        context.save()
        context.setLineDash([4, 3])
        context.lineWidth = 1
        context.strokeStyle = 'rgba(64,132,255,0.35)'
        for (const group of groups.current) {
          context.strokeRect(group.left, group.top, group.right - group.left, group.bottom - group.top)
        }
        context.restore()
      }, [])

      React.useEffect(() => {
        groups.current = detectGroups(strokes.current)
        redraw()
      }, [count, redraw])

      // The pad is a percentage width, so opening or closing the meeting focus resizes it
      // without any stroke changing. Re-fitting the backing store on every box change is what
      // keeps the ink aligned with the drawn border instead of stretched across a stale bitmap.
      React.useEffect(() => {
        const element = canvas.current
        if (element === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => { redraw() })
        observer.observe(element)
        return () => observer.disconnect()
      }, [redraw])

      /**
       * Place one event in canvas-local coordinates.
       * @param event - A pointer event or one coalesced sample.
       * @returns the point with normalized pressure.
       */
      const localPoint = (event) => {
        const rect = canvas.current.getBoundingClientRect()
        // Windows reports 0–1024 levels and 0 while hovering or for a mouse.
        const pressure = typeof event.pressure === 'number' && event.pressure > 0 ? Math.min(1, event.pressure) : 0.5
        return { x: event.clientX - rect.left, y: event.clientY - rect.top, p: pressure }
      }

      /**
       * Drop every stroke passing near one eraser position.
       * @param point - Eraser centre in canvas coordinates.
       */
      const eraseAt = (point) => {
        const radius = 10
        strokes.current = strokes.current.filter((stroke) => !stroke.points.some(
          (candidate) => Math.abs(candidate.x - point.x) <= radius && Math.abs(candidate.y - point.y) <= radius,
        ))
      }

      /**
       * Ray-casting point-in-polygon test for the lasso.
       * @param point - Point in canvas coordinates.
       * @param polygon - Closed lasso path.
       * @returns whether the point lies inside.
       */
      const insidePolygon = (point, polygon) => {
        let inside = false
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i++) {
          const a = polygon[i]
          const b = polygon[j]
          if ((a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside
          }
        }
        return inside
      }

      /**
       * Replace the selection with every stroke whose ink falls inside the lasso.
       * @param polygon - The closed lasso path.
       */
      const selectInside = (polygon) => {
        const next = new Set()
        for (const stroke of strokes.current) {
          if (stroke.points.some((point) => insidePolygon(point, polygon))) next.add(stroke)
        }
        selected.current = next
      }

      const onPointerDown = (event) => {
        // Touch is dropped: the system's palm rejection is partial, so the surface keeps
        // to the pen and the mouse.
        if (event.pointerType === 'touch') return
        const erasing = (event.buttons & 32) !== 0 || tool === 'erase'
        canvas.current.setPointerCapture(event.pointerId)
        active.current = { points: [localPoint(event)], erasing, lasso: tool === 'lasso' && !erasing }
        if (erasing) eraseAt(localPoint(event))
        // A long press either recognizes an existing selection or starts a lasso, so circling
        // never needs the toolbar.
        longPress.current = setTimeout(() => {
          longPress.current = null
          const stroke = active.current
          // Only a press that never became a drawing counts.
          if (stroke === null || stroke.points.length > 2) return
          if (selected.current.size > 0) {
            active.current = null
            setCount((value) => value + 1)
            void recognizeSelection(false)
            return
          }
          setTool('lasso')
          if (active.current !== null) active.current.lasso = true
        }, 600)
        redraw()
      }

      const onPointerMove = (event) => {
        const stroke = active.current
        if (stroke === null) return
        // Coalesced samples: without them a fast stroke loses points and reads as chords.
        const native = event.nativeEvent
        const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [native]
        for (const sample of samples) {
          if (stroke.erasing) eraseAt(localPoint(sample))
          else stroke.points.push(localPoint(sample))
        }
        // Moving past a couple of samples means this is a stroke, not a long press.
        if (longPress.current !== null && stroke.points.length > 3) {
          clearTimeout(longPress.current)
          longPress.current = null
        }
        redraw()
      }

      const finishStroke = () => {
        if (longPress.current !== null) {
          clearTimeout(longPress.current)
          longPress.current = null
        }
        const stroke = active.current
        if (stroke === null) return
        active.current = null
        if (stroke.lasso) {
          // The lasso itself is never kept as ink; it only selects.
          if (stroke.points.length > 2) selectInside(stroke.points)
          setCount((value) => value + 1)
          return
        }
        // A tap with no drag selects the character the ink says is under it, so a selection
        // never requires the lasso gesture.
        if (!stroke.erasing && stroke.points.length <= 2) {
          const point = stroke.points[0]
          const group = detectGroups(strokes.current).find((candidate) =>
            point.x >= candidate.left - 8 && point.x <= candidate.right + 8
            && point.y >= candidate.top - 8 && point.y <= candidate.bottom + 8)
          if (group !== undefined) selected.current = new Set(group.strokes)
          setCount((value) => value + 1)
          return
        }
        // Windows reports pressure 0 on pointerup, so the last real sample is what counts.
        if (!stroke.erasing && stroke.points.length > 1) strokes.current.push(stroke)
        setCount((value) => value + 1)
      }

      const onPointerCancel = () => {
        // A cancelled pointer means the system took the stroke over: discard it outright.
        active.current = null
      }

      /**
       * Render the current strokes as PNG bytes.
       * @returns base64 PNG data, or an empty string when nothing was drawn.
       */
      const pngBytes = () => {
        const element = canvas.current
        if (element === null || strokes.current.length === 0) return ''
        const dataUrl = element.toDataURL('image/png')
        const comma = dataUrl.indexOf(',')
        return comma === -1 ? '' : dataUrl.slice(comma + 1)
      }

      /** Hand the rendered note to the host as PNG bytes. */
      const save = async () => {
        const pngBase64 = pngBytes()
        if (pngBase64 !== '') await props.onSave(pngBase64)
      }

      /**
       * Pack the drawing the way the recognizer reads it, following the official ModelScope
       * preprocessing: crop to the ink, fit the height to 32, paste at the top-left of a
       * BLACK 32x804 page, then take the three overlapping 300-wide windows at 0, 252, 504.
       * The host needs no image decoder this way.
       * @param subset - Strokes to pack; defaults to every stroke on the pad.
       * @returns base64 grayscale bytes, or an empty string when nothing was drawn.
       */
      const packPixels = (subset) => {
        const element = canvas.current
        const source = subset === undefined ? strokes.current : subset
        if (element === null || source.length === 0) return ''
        let minX = Number.POSITIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxX = Number.NEGATIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY
        for (const stroke of source) {
          for (const point of stroke.points) {
            if (point.x < minX) minX = point.x
            if (point.x > maxX) maxX = point.x
            if (point.y < minY) minY = point.y
            if (point.y > maxY) maxY = point.y
          }
        }
        const margin = 4
        minX = Math.max(0, minX - margin)
        minY = Math.max(0, minY - margin)
        maxX = Math.min(element.clientWidth, maxX + margin)
        maxY = Math.min(element.clientHeight, maxY + margin)
        const cropWidth = Math.max(1, maxX - minX)
        const cropHeight = Math.max(1, maxY - minY)
        const fittedWidth = Math.max(1, Math.min(PAGE_WIDTH, Math.round(RECOGNIZE_HEIGHT * (cropWidth / cropHeight))))
        const page = document.createElement('canvas')
        page.width = PAGE_WIDTH
        page.height = RECOGNIZE_HEIGHT
        const context = page.getContext('2d')
        // Everything outside the fitted image stays black, as upstream's zero-filled page.
        context.fillStyle = '#000000'
        context.fillRect(0, 0, PAGE_WIDTH, RECOGNIZE_HEIGHT)
        // The pad is transparent over dark ink, so the image area becomes white paper first.
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, fittedWidth, RECOGNIZE_HEIGHT)
        // Redraw just the chosen strokes onto a scratch pad, so a lasso selection is what
        // gets recognized rather than everything on the surface.
        const scratch = document.createElement('canvas')
        scratch.width = element.clientWidth
        scratch.height = element.clientHeight
        const scratchContext = scratch.getContext('2d')
        scratchContext.lineCap = 'round'
        scratchContext.lineJoin = 'round'
        scratchContext.strokeStyle = '#111111'
        for (const stroke of source) {
          for (let i = 1; i < stroke.points.length; i++) {
            const from = stroke.points[i - 1]
            const to = stroke.points[i]
            scratchContext.beginPath()
            scratchContext.lineWidth = widthOf(to.p)
            scratchContext.moveTo(from.x, from.y)
            scratchContext.lineTo(to.x, to.y)
            scratchContext.stroke()
          }
        }
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(scratch, minX, minY, cropWidth, cropHeight, 0, 0, fittedWidth, RECOGNIZE_HEIGHT)
        const pixels = context.getImageData(0, 0, PAGE_WIDTH, RECOGNIZE_HEIGHT).data
        const packed = new Uint8Array(RECOGNIZE_CHUNKS * RECOGNIZE_HEIGHT * WINDOW_WIDTH)
        for (let chunk = 0; chunk < RECOGNIZE_CHUNKS; chunk++) {
          for (let y = 0; y < RECOGNIZE_HEIGHT; y++) {
            for (let x = 0; x < WINDOW_WIDTH; x++) {
              const sourceX = chunk * CHUNK_STRIDE + x
              const target = (chunk * RECOGNIZE_HEIGHT + y) * WINDOW_WIDTH + x
              if (sourceX >= PAGE_WIDTH) continue
              const index = (y * PAGE_WIDTH + sourceX) * 4
              packed[target] = Math.round(0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2])
            }
          }
        }
        return base64(packed)
      }

      /**
       * Split strokes into text lines by the horizontal gaps between them. The recognizer is a
       * single-line model, so two lines squeezed into one 32-pixel strip read as noise; each
       * band is recognized on its own instead.
       * @param subset - Strokes to inspect.
       * @returns one stroke list per detected line, top to bottom.
       */
      const splitLines = (subset) => {
        const step = 4
        const coverage = new Map()
        for (const stroke of subset) {
          for (const point of stroke.points) {
            const band = Math.round(point.y / step) * step
            coverage.set(band, (coverage.get(band) ?? 0) + 1)
          }
        }
        const occupied = [...coverage.keys()].sort((left, right) => left - right)
        if (occupied.length === 0) return []
        // A gap wider than a character's breathing room separates two lines.
        const bands = [[occupied[0]]]
        for (let index = 1; index < occupied.length; index++) {
          if (occupied[index] - occupied[index - 1] > 40) bands.push([])
          bands[bands.length - 1].push(occupied[index])
        }
        return bands.map((group) => {
          const top = group[0] - step
          const bottom = group[group.length - 1] + step
          return subset.filter((stroke) => stroke.points.some((point) => point.y >= top && point.y <= bottom))
        }).filter((line) => line.length > 0)
      }

      /**
       * Detect text groups from the ink alone: lines by horizontal gaps, then character groups
       * by vertical gaps inside each line. Tapping a group selects it, so no lasso is needed.
       * @param subset - Strokes to inspect.
       * @returns groups with bounds and member strokes, in reading order.
       */
      const detectGroups = (subset) => {
        const step = 4
        const groups = []
        for (const line of splitLines(subset)) {
          const coverage = new Map()
          for (const stroke of line) {
            for (const point of stroke.points) {
              const band = Math.round(point.x / step) * step
              coverage.set(band, (coverage.get(band) ?? 0) + 1)
            }
          }
          const occupied = [...coverage.keys()].sort((left, right) => left - right)
          if (occupied.length === 0) continue
          // A gap of about a quarter of a character separates two groups.
          const bands = [[occupied[0]]]
          for (let index = 1; index < occupied.length; index++) {
            if (occupied[index] - occupied[index - 1] > 24) bands.push([])
            bands[bands.length - 1].push(occupied[index])
          }
          for (const band of bands) {
            const left = band[0] - step
            const right = band[band.length - 1] + step
            const members = line.filter((stroke) => stroke.points.some((point) => point.x >= left && point.x <= right))
            if (members.length === 0) continue
            let top = Number.POSITIVE_INFINITY
            let bottom = Number.NEGATIVE_INFINITY
            for (const stroke of members) {
              for (const point of stroke.points) {
                if (point.y < top) top = point.y
                if (point.y > bottom) bottom = point.y
              }
            }
            groups.push({ strokes: members, left, right, top, bottom })
          }
        }
        return groups
      }

      /**
       * Pack every text line found in the given strokes.
       * @param subset - Strokes to pack.
       * @returns one base64 payload per line, top to bottom.
       */
      const packLines = (subset) => {
        const payloads = []
        for (const line of splitLines(subset)) {
          const pixelsBase64 = packPixels(line)
          if (pixelsBase64 !== '') payloads.push(pixelsBase64)
        }
        return payloads
      }

      /** Recognize the drawing locally — no agent round-trip, no network. */
      const recognizeLocal = async () => {
        const payloads = packLines(strokes.current)
        if (payloads.length > 0) await props.onRecognizeLocal(payloads, false)
      }

      /**
       * Recognize what the lasso picked up, optionally turning the result into a task.
       * @param asTask - Whether the recognized text also becomes a draft assignment.
       */
      const recognizeSelection = async (asTask) => {
        const chosen = [...selected.current]
        if (chosen.length === 0) return
        const payloads = packLines(chosen)
        if (payloads.length > 0) await props.onRecognizeLocal(payloads, asTask === true)
      }

      return h('div', { style: styles.player }, [
        h('div', { key: 'bar', style: styles.row }, [
          h(Btn, {
            key: 'pen',
            type: 'button',
            style: tool === 'pen' ? styles.buttonActive : styles.button,
            onClick: () => setTool('pen'),
          }, t('inkPen')),
          h(Btn, {
            key: 'erase',
            type: 'button',
            style: tool === 'erase' ? styles.buttonActive : styles.button,
            onClick: () => setTool('erase'),
          }, t('inkErase')),
          h(Btn, {
            key: 'lasso',
            type: 'button',
            style: tool === 'lasso' ? styles.buttonActive : styles.button,
            onClick: () => setTool('lasso'),
          }, t('inkLasso')),
          h(Btn, {
            key: 'undo',
            type: 'button',
            style: styles.button,
            onClick: () => {
              const last = strokes.current.pop()
              if (last !== undefined) selected.current.delete(last)
              setCount((value) => value + 1)
            },
          }, t('inkUndo')),
          h(Btn, {
            key: 'clear',
            type: 'button',
            style: styles.button,
            onClick: () => {
              strokes.current = []
              selected.current = new Set()
              setCount((value) => value + 1)
            },
          }, t('inkClear')),
          h(Btn, {
            key: 'save',
            type: 'button',
            style: styles.button,
            disabled: count === 0 && strokes.current.length === 0,
            onClick: () => { void save() },
          }, t('inkSave')),
          h(Btn, {
            key: 'local',
            type: 'button',
            style: styles.buttonActive,
            disabled: count === 0 && strokes.current.length === 0,
            onClick: () => { void recognizeLocal() },
          }, t('inkLocal')),
        ]),
        // One row per recognized line, so a note holding several assignments can send each of
        // them to the task list on its own.
        props.recognizedText === '' ? null : h('div', { key: 'recognized', style: styles.list }, [
          ...props.recognizedText.split('\n').filter((line) => line.trim() !== '').map((line, index) => h('div', {
            key: `line${index}`,
            style: styles.row,
          }, [
            h('span', { key: 'text', style: styles.recognized }, line),
            h(Btn, {
              key: 'toTask',
              type: 'button',
              style: styles.buttonActive,
              onClick: () => { props.onRecognizedToTask(line) },
            }, t('inkToTask')),
          ])),
          h('div', { key: 'actions', style: styles.row }, [
            h(Btn, {
              key: 'dismiss',
              type: 'button',
              style: styles.button,
              onClick: () => props.onDismissRecognized(),
            }, t('clearEntry')),
          ]),
        ]),
        // Circled ink is the other target; it is only offered while something is selected.
        selected.current.size === 0 ? null : h('div', { key: 'selection', style: styles.row }, [
          h('span', { key: 'label', style: styles.recognized }, `${t('inkLasso')} ${selected.current.size}`),
          h(Btn, {
            key: 'recognizeSelection',
            type: 'button',
            style: styles.button,
            onClick: () => { void recognizeSelection(false) },
          }, t('inkSelection')),
          h(Btn, {
            key: 'toTask',
            type: 'button',
            style: styles.buttonActive,
            onClick: () => { void recognizeSelection(true) },
          }, t('inkToTask')),
          h(Btn, {
            key: 'clear',
            type: 'button',
            style: styles.button,
            onClick: () => {
              selected.current = new Set()
              setCount((value) => value + 1)
              props.onDismissRecognized()
            },
          }, t('clearEntry')),
        ]),
        h('canvas', {
          key: 'pad',
          ref: canvas,
          style: styles.ink,
          onPointerDown,
          onPointerMove,
          onPointerUp: finishStroke,
          onPointerCancel,
          onPointerLeave: finishStroke,
          onContextMenu: (event) => event.preventDefault(),
        }),
        h('span', { key: 'hint', style: styles.hint }, tool === 'lasso' ? t('inkLassoHint') : t('inkHint')),
      ])
    }

    /**
     * Render the meeting hub: where records live, how to start one, and the term list.
     * @param props - Root-scoped slot props plus this namespace's copy.
     * @returns the hub page.
     */
    function MeetingHubPage(props) {
      const t = props.t
      const [records, setRecords] = React.useState([])
      // The hub used to read the newest 200 and silently stop there; the host caps at 200,
      // so an older archive needs explicit pages (§5.2).
      const [recordsTotal, setRecordsTotal] = React.useState(0)
      const [preview, setPreview] = React.useState(null)
      const [error, setError] = React.useState('')
      const [termsText, setTermsText] = React.useState(readTerms)
      /** Push settings and the shared roster live here, not in a single meeting's panel. */
      const [settings, setSettings] = React.useState({ configured: [], people: [], departments: [] })
      const [settingsDraft, setSettingsDraft] = React.useState({ dingtalk: '', wecom: '', appKey: '', appSecret: '', agentId: '', mode: 'group' })
      /** Which settings group is open. One tab per configuration function (§5.2). */
      const [settingsTab, setSettingsTab] = React.useState('push')
      /** The monthly score weights, as percentages; the host stores them normalised (§2.4). */
      const [weightsDraft, setWeightsDraft] = React.useState({ quality: 40, completion: 40, learn: 20 })
      const [weightsNote, setWeightsNote] = React.useState('')
      /** Per-type distillation wording (§9 P4); an empty entry keeps the built-in text. */
      const [templateDraft, setTemplateDraft] = React.useState({ briefing: '', review: '', weekly: '', monthly: '' })
      const [templatesNote, setTemplatesNote] = React.useState('')
      const [personDraft, setPersonDraft] = React.useState({ name: '', phone: '', userId: '' })
      const [deptId, setDeptId] = React.useState(0)
      const [directoryBusy, setDirectoryBusy] = React.useState(false)
      const [settingsNote, setSettingsNote] = React.useState('')
      /** The hidden file field behind the import button, and whether an import is running. */
      const importField = React.useRef(null)
      const [importing, setImporting] = React.useState(false)
      /** Which hub section is showing; the page keeps its own tabs, not the panel's. */
      const [hubTab, setHubTab] = React.useState('records')
      /** The records page's kind filter chip and its day/week/month grouping (§5.2). */
      // '__all__' is a state of its own: '' is "general meeting" and must not double as "all".
      const [hubKind, setHubKind] = React.useState('__all__')
      const [hubGroup, setHubGroup] = React.useState('day')
      /**
       * The model catalog: which models exist, which are installed here, which one each
       * capability runs, and how a download in flight is going.
       */
      const [models, setModels] = React.useState({ models: [], active: {}, problem: '', directory: '', install: null })
      const [modelBusy, setModelBusy] = React.useState('')
      /** The hidden field used for "import a model from a local file", and what it is for. */
      const modelField = React.useRef(null)
      const modelTarget = React.useRef({ id: '', name: '' })
      /**
       * Cloud recognition: the summary the host reports (never the key itself) and the fields
       * being edited. A blank key field means "leave the stored one alone".
       */
      const [cloud, setCloud] = React.useState({ consent: false, asr: {}, speaker: {}, state: {} })
      const [cloudDraft, setCloudDraft] = React.useState({ consent: false, provider: 'off', baseUrl: '', model: '', language: '', apiKey: '' })
      const [cloudNote, setCloudNote] = React.useState('')
      const [cloudBusy, setCloudBusy] = React.useState(false)
      /**
       * Speaker recognition: the clustering threshold, whether the end-of-meeting pass covers
       * every cue, and the voice library (names and evidence only — vectors never arrive here).
       */
      const [speakerSettings, setSpeakerSettings] = React.useState({ threshold: 0.6, fullRelabel: true, backfillCap: 60, presets: [], library: [], libraryFile: '' })
      const [speakerDraft, setSpeakerDraft] = React.useState({ threshold: 0.6, fullRelabel: true, backfillCap: 60 })
      const [voiceNote, setVoiceNote] = React.useState('')
      /**
       * Transcript settings: how numbers and dates are written back, and where a cue is cut.
       * The cue limits are applied to the live capture loop, not just displayed.
       */
      const [transcript, setTranscript] = React.useState({ normalize: true, normalizeRules: [], minChunkSeconds: 1.2, maxChunkSeconds: 12, silenceRms: 0.012, silenceHoldSeconds: 0.7, maxLineChars: 60 })
      const [transcriptDraft, setTranscriptDraft] = React.useState(null)
      const [transcriptRules, setTranscriptRules] = React.useState([])
      const [transcriptNote, setTranscriptNote] = React.useState('')

      /** Load settings, the roster and any cached department tree when either tab opens. */
      React.useEffect(() => {
        if (hubTab !== 'settings' && hubTab !== 'people') return undefined
        let cancelled = false
        void (async () => {
          try {
            const config = await get('/webhooks')
            const roster = await get('/people')
            if (cancelled) return
            if (config.scoreWeights !== null && typeof config.scoreWeights === 'object') {
              setWeightsDraft({
                quality: Math.round(Number(config.scoreWeights.quality ?? 0.4) * 100),
                completion: Math.round(Number(config.scoreWeights.completion ?? 0.4) * 100),
                learn: Math.round(Number(config.scoreWeights.learn ?? 0.2) * 100),
              })
            }
            if (config.templates !== null && typeof config.templates === 'object') {
              setTemplateDraft({
                briefing: typeof config.templates.briefing === 'string' ? config.templates.briefing : '',
                review: typeof config.templates.review === 'string' ? config.templates.review : '',
                weekly: typeof config.templates.weekly === 'string' ? config.templates.weekly : '',
                monthly: typeof config.templates.monthly === 'string' ? config.templates.monthly : '',
              })
            }
            setSettings({
              ...config,
              people: Array.isArray(roster.people) ? roster.people : [],
              departments: Array.isArray(roster.departments) ? roster.departments : [],
            })
            // The secret never comes back, so only displayable fields are prefilled.
            setSettingsDraft((value) => ({
              ...value,
              mode: typeof config.mode === 'string' ? config.mode : value.mode,
              agentId: typeof config.agentId === 'string' ? config.agentId : value.agentId,
            }))
          } catch (failure) {
            if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
          }
        })()
        return () => { cancelled = true }
      }, [hubTab])

      /** Store the robot webhooks and the DingTalk internal application. */
      const saveSettings = React.useCallback(async () => {
        setError('')
        try {
          const reply = await post('/webhooks', settingsDraft)
          setSettings((value) => ({ ...value, ...reply }))
          setSettingsNote(t('robotSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [settingsDraft, t])

      /** Store the monthly score weights; the host refuses a set that does not add up. */
      const saveWeights = React.useCallback(async () => {
        setError('')
        setWeightsNote('')
        try {
          const reply = await post('/webhooks', { scoreWeights: weightsDraft })
          if (reply.scoreWeights !== null && typeof reply.scoreWeights === 'object') {
            setWeightsDraft({
              quality: Math.round(Number(reply.scoreWeights.quality) * 100),
              completion: Math.round(Number(reply.scoreWeights.completion) * 100),
              learn: Math.round(Number(reply.scoreWeights.learn) * 100),
            })
          }
          setWeightsNote(t('scoreWeightSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [t, weightsDraft])

      /** Store the per-type distillation wording; empty fields fall back to the built-in text. */
      const saveTemplates = React.useCallback(async () => {
        setError('')
        setTemplatesNote('')
        try {
          const reply = await post('/webhooks', { templates: templateDraft })
          if (reply.templates !== null && typeof reply.templates === 'object') {
            setTemplateDraft({
              briefing: typeof reply.templates.briefing === 'string' ? reply.templates.briefing : '',
              review: typeof reply.templates.review === 'string' ? reply.templates.review : '',
              weekly: typeof reply.templates.weekly === 'string' ? reply.templates.weekly : '',
              monthly: typeof reply.templates.monthly === 'string' ? reply.templates.monthly : '',
            })
          }
          setTemplatesNote(t('templateSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [t, templateDraft])

      /**
       * Add, update or remove one person on the shared roster.
       * @param draft - The person to store.
       * @param action - 'save' adds or updates, 'remove' deletes by name.
       */
      const savePerson = React.useCallback(async (draft, action = 'save') => {
        setError('')
        try {
          const reply = await post('/people', { ...draft, remove: action === 'remove' })
          if (Array.isArray(reply.people)) setSettings((value) => ({ ...value, people: reply.people }))
          if (action === 'save') setPersonDraft({ name: '', phone: '', userId: '' })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /** Read the DingTalk department tree so a department can be chosen for a sync. */
      const readDepartments = React.useCallback(async () => {
        setError('')
        setSettingsNote('')
        setDirectoryBusy(true)
        try {
          const reply = await post('/dingtalk/departments', {})
          if (Array.isArray(reply.departments)) setSettings((value) => ({ ...value, departments: reply.departments }))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setDirectoryBusy(false)
        }
      }, [])

      /** Import people from DingTalk. A department id of 0 means the whole organisation. */
      const syncPeople = React.useCallback(async () => {
        setError('')
        setSettingsNote('')
        setDirectoryBusy(true)
        try {
          const reply = await post('/dingtalk/sync', { deptId })
          if (Array.isArray(reply.people)) setSettings((value) => ({ ...value, people: reply.people }))
          setSettingsNote(`${t('peopleSynced')}: ${t('peopleAdded')} ${reply.added ?? 0} / ${reply.total ?? 0}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setDirectoryBusy(false)
        }
      }, [deptId, t])

      // These two hooks read root-scoped framework seats whose snapshots can be
      // undefined before the first frame or differ across runtime versions; guard every
      // access so a shape mismatch degrades to a neutral line instead of a blank page.
      const sessionId = props.useSessions((state) => {
        try {
          const byId = state === null || state === undefined ? undefined : state.byId
          if (byId === null || byId === undefined) return ''
          const current = Object.values(byId).find((session) => {
            const retainedBy = session === null || session === undefined ? undefined : session.retainedBy
            return ((retainedBy === null || retainedBy === undefined ? undefined : retainedBy.mainView) ?? 0) > 0
          })
          return current === undefined ? '' : current.id
        } catch {
          return ''
        }
      })
      const conversationOpen = props.usePanelInfo((info) => {
        try {
          return info !== null && info !== undefined && info.activePanelId === null
        } catch {
          return false
        }
      })

      React.useEffect(() => {
        try {
          localStorage.setItem(TERMS_KEY, termsText)
        } catch {
          // Storage refused (private mode): the list still applies to this meeting.
        }
      }, [termsText])

      /** Re-read the first page of records from the host, or append the next one. */
      const refresh = React.useCallback(async (offset = 0) => {
        setError('')
        try {
          const value = await get(`/history?limit=200&offset=${offset}`)
          const rows = Array.isArray(value.meetings) ? value.meetings : []
          setRecords((current) => (offset === 0 ? rows : [...current, ...rows]))
          setRecordsTotal(typeof value.total === 'number' ? value.total : rows.length)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      /** Read the cloud summary and seed the fields with it (the key stays blank by design). */
      const loadCloud = React.useCallback(async () => {
        try {
          const value = await get('/cloud')
          setCloud(value)
          setCloudDraft({
            consent: value.consent === true,
            provider: value.asr?.provider ?? 'off',
            baseUrl: value.asr?.baseUrl ?? '',
            model: value.asr?.model ?? '',
            language: value.asr?.language ?? '',
            apiKey: '',
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /** Read the transcript settings and the rule catalogue. */
      const loadTranscript = React.useCallback(async () => {
        try {
          const value = await get('/transcript')
          const stored = value.transcript ?? {}
          setTranscript(stored)
          setTranscriptDraft(stored)
          setTranscriptRules(Array.isArray(value.rules) ? value.rules : [])
          // The browser half cuts cues, so the limits have to reach the capture loop; without
          // this the settings page would be describing something that never happened.
          applyCueSettings(stored)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /** Store the transcript settings and apply the cue limits immediately. */
      const saveTranscript = React.useCallback(async () => {
        setError('')
        setTranscriptNote('')
        try {
          const reply = await post('/transcript', transcriptDraft ?? {})
          setTranscript(reply.transcript)
          setTranscriptDraft(reply.transcript)
          applyCueSettings(reply.transcript)
          setTranscriptNote(t('cloudSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [transcriptDraft, t])

      /** Read the speaker settings and the voice library. */
      const loadSpeakerSettings = React.useCallback(async () => {
        try {
          const value = await get('/speaker/settings')
          const speaker = value.speaker ?? {}
          setSpeakerSettings({
            threshold: speaker.threshold ?? 0.6,
            fullRelabel: speaker.fullRelabel !== false,
            backfillCap: speaker.backfillCap ?? 60,
            presets: Array.isArray(value.presets) ? value.presets : [],
            library: Array.isArray(value.library) ? value.library : [],
            libraryFile: typeof value.libraryFile === 'string' ? value.libraryFile : '',
          })
          setSpeakerDraft({
            threshold: speaker.threshold ?? 0.6,
            fullRelabel: speaker.fullRelabel !== false,
            backfillCap: speaker.backfillCap ?? 60,
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /** Store the speaker settings; the host retires the recogniser when the threshold changes. */
      const saveSpeakerSettings = React.useCallback(async () => {
        setError('')
        setVoiceNote('')
        try {
          const reply = await post('/speaker/settings', speakerDraft)
          setVoiceNote(reply.restarted === true ? t('speakerRestarted') : t('cloudSaved'))
          await loadSpeakerSettings()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [loadSpeakerSettings, speakerDraft, t])

      /** Forget one voice, or everyone. */
      const forgetVoice = React.useCallback(async (name) => {
        setError('')
        setVoiceNote('')
        try {
          if (name === '') await post('/voices/clear', {})
          else await post('/voices/remove', { name })
          await loadSpeakerSettings()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [loadSpeakerSettings])

      /** Store the cloud settings. An empty key field leaves the stored key untouched. */
      const saveCloud = React.useCallback(async () => {
        setError('')
        setCloudNote('')
        setCloudBusy(true)
        try {
          const asr = {
            provider: cloudDraft.provider,
            baseUrl: cloudDraft.baseUrl,
            model: cloudDraft.model,
            language: cloudDraft.language,
          }
          if (cloudDraft.apiKey !== '') asr.apiKey = cloudDraft.apiKey
          await post('/cloud', { consent: cloudDraft.consent, asr })
          setCloudNote(t('cloudSaved'))
          await loadCloud()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setCloudBusy(false)
        }
      }, [cloudDraft, loadCloud, t])

      /** Ask the host to try the configured service once — a tenth of a second of silence. */
      const runCloudTest = React.useCallback(async () => {
        setError('')
        setCloudNote('')
        setCloudBusy(true)
        try {
          const reply = await post('/cloud/test', {})
          const asr = reply.asr ?? {}
          setCloudNote(`${t('cloudTest')}：${asr.ok === true ? t('cloudOk') : t('cloudFailed')} ${asr.message ?? ''}`)
          await loadCloud()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setCloudBusy(false)
        }
      }, [loadCloud, t])

      React.useEffect(() => {
        if (hubTab !== 'settings') return
        void loadCloud()
        void loadSpeakerSettings()
        void loadTranscript()
      }, [hubTab, loadCloud, loadSpeakerSettings, loadTranscript])

      /** Read the model catalog and what is on disk. */
      const loadModels = React.useCallback(async () => {
        try {
          const value = await get('/models')
          setModels({
            models: Array.isArray(value.models) ? value.models : [],
            active: value.active ?? {},
            problem: typeof value.problem === 'string' ? value.problem : '',
            directory: typeof value.directory === 'string' ? value.directory : '',
            install: value.install ?? null,
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => {
        if (hubTab === 'models') void loadModels()
      }, [hubTab, loadModels])

      // A model download runs for minutes, so the page polls while one is in flight — the
      // percentage it shows is the host's own byte count, not an animation.
      React.useEffect(() => {
        if (models.install?.phase !== 'downloading') return undefined
        const timer = setInterval(() => { void loadModels() }, 1000)
        return () => clearInterval(timer)
      }, [models.install?.phase, loadModels])

      /**
       * Download one model through the host, which verifies size and sha256 as it writes.
       * @param id - model id.
       */
      const installModelNow = React.useCallback(async (id) => {
        setError('')
        setSettingsNote('')
        setModelBusy(id)
        try {
          const reply = await post('/models/install', { id })
          setSettingsNote(reply.error === undefined ? `${t('modelInstalled')}: ${id}` : String(reply.error))
          if (reply.error !== undefined) setError(String(reply.error))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }, [loadModels, t])

      /**
       * Install a model from a file the person already has — an offline machine, a private
       * mirror, or a model they trained. The bytes decide: a catalog sha256 must match.
       * @param id - model id.
       * @param name - which file of that model.
       * @param file - the chosen file.
       */
      const importModelNow = React.useCallback(async (id, name, file) => {
        if (file === undefined || file === null) return
        setError('')
        setSettingsNote('')
        setModelBusy(id)
        try {
          const response = await fetch(`${PREFIX}/models/import?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          })
          const text = await response.text()
          let value = {}
          try { value = text === '' ? {} : JSON.parse(text) } catch { value = {} }
          if (!response.ok) {
            setError(typeof value.error === 'string' ? value.error : `${response.status}`)
          } else {
            setSettingsNote(`${t('modelImported')}: ${name}`)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }, [loadModels, t])

      /** Choose which model a capability runs ('' goes back to the built-in default). */
      const activateModelNow = React.useCallback(async (kind, id) => {
        setError('')
        setSettingsNote('')
        setModelBusy(id)
        try {
          const reply = await post('/models/activate', { kind, id })
          if (reply.error !== undefined) setError(String(reply.error))
          else setSettingsNote(t('modelActivated'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }, [loadModels, t])

      /** Remove a model's files from this machine (built-ins can only be switched away from). */
      const removeModelNow = React.useCallback(async (id) => {
        setError('')
        setSettingsNote('')
        setModelBusy(id)
        try {
          const reply = await post('/models/remove', { id })
          if (reply.error !== undefined) setError(String(reply.error))
          else setSettingsNote(`${t('modelRemoved')}: ${reply.removed ?? 0}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }, [loadModels, t])

      /**
       * Bring one exported archive in as a meeting of this machine. The bytes go up as they
       * are — an imported meeting carries its recording, which JSON would only inflate.
       * @param file - The .zip the person chose.
       */
      const importMeeting = React.useCallback(async (file) => {
        if (file === undefined || file === null) return
        setError('')
        setSettingsNote('')
        setImporting(true)
        try {
          const response = await fetch(`${PREFIX}/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: file,
          })
          const text = await response.text()
          let value = {}
          try { value = text === '' ? {} : JSON.parse(text) } catch { value = {} }
          if (!response.ok) {
            setError(typeof value.error === 'string' ? value.error : `${response.status}`)
            return
          }
          const name = typeof value.title === 'string' && value.title !== '' ? value.title : String(value.meetingId ?? '')
          setSettingsNote(`${t('hubImported')}: ${name} · ${String(value.files ?? 0)}`)
          await refresh()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setImporting(false)
        }
      }, [refresh, t])

      /**
       * Open one meeting from the management page: remember it, switch to the conversation it
       * belongs to, and open the panel column — the panel then loads exactly this meeting.
       * @param row - The meeting row the page is showing.
       */
      const openMeeting = React.useCallback(async (row) => {
        setError('')
        // Wrapped because a throw in here happens after the conversation already switched:
        // an unhandled rejection would leave the person on a conversation with no panel and
        // no explanation, which is exactly how this went wrong once.
        try {
          if (row.sessionId === '') {
            setError(t('hubNoMeeting'))
            return
          }
          pendingMeeting.current = { sessionId: row.sessionId, meetingId: row.meetingId, openedByHeader: false }
          setSettingsNote(`${t('hubOpeningMeeting')} …`)
          console.info('meeting-room: open meeting requested', row.meetingId, 'in session', row.sessionId)
          const opened = typeof props.openConversation === 'function' ? props.openConversation(row.sessionId) : false
          if (opened === false) {
            pendingMeeting.current = null
            setError(t('hubNoWorkspace'))
            return
          }
          // The right column can only be addressed while a conversation surface is mounted and
          // adopted, and the management page is occupying the main area when this runs. Ask
          // repeatedly — up to a minute — and stop the moment the panel takes the meeting.
          const startedAt = Date.now()
          const tryFocus = () => {
            if (pendingMeeting.current === null) return
            if (typeof props.openMeetingPanel !== 'function') return
            if (props.openMeetingPanel() === true) return
            if (Date.now() - startedAt < 60000) {
              setTimeout(tryFocus, 400)
              return
            }
            console.warn('meeting-room: the right panel never opened; the conversation is open')
            setSettingsNote(t('hubOpenPanelManual'))
          }
          tryFocus()
        } catch (failure) {
          pendingMeeting.current = null
          setError(failure instanceof Error ? failure.message : String(failure))
          console.warn('meeting-room: opening a meeting failed', failure)
        }
      }, [props, t])

      /**
       * Read one meeting into the preview area: its timed cues when it has a recording, so
       * the synchronized player can follow along, and its stored document otherwise.
       * @param row - The meeting row as the history list reports it.
       */
      const openTranscript = React.useCallback(async (row) => {
        setError('')
        try {
          const value = await get(`/state?meetingId=${encodeURIComponent(row.meetingId)}`)
          setPreview({
            name: row.title === '' ? row.meetingId : row.title,
            image: false,
            markdown: '',
            segments: Array.isArray(value.segments) ? value.segments : [],
            audioName: typeof value.audioName === 'string' ? value.audioName : '',
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /**
       * Open one record: pair its recording and transcript by shared name, then hand the
       * timed cues to the synchronized player.
       * @param name - Artifact file name.
       */
      /**
       * Hand this meeting's record to a brand-new conversation, where it arrives as the
       * opening draft so the user reviews it before sending.
       * @param file - The listed artifact, carrying the meeting it belongs to.
       */
      const sendToNewConversation = React.useCallback(async (file) => {
        setError('')
        if (file.meetingId === '') {
          setError(t('hubNoMeeting'))
          return
        }
        try {
          const reply = await get(`/transcript?meetingId=${encodeURIComponent(file.meetingId)}&limit=4000`)
          const text = typeof reply.text === 'string' ? reply.text : ''
          if (text.trim() === '') {
            setError(t('hubNoText'))
            return
          }
          if (!props.startConversation(text)) setError(t('hubNoWorkspace'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [props, t])


      /** The records the kind chip keeps, grouped by the chosen calendar bucket (§5.2). */
      const visibleRecords = records.filter((row) => hubKind === '__all__' || row.kind === hubKind)
      const recordGroups = []
      for (const row of visibleRecords) {
        const bucket = periodBucketOf(row.startedAt, hubGroup)
        const group = recordGroups.find((entry) => entry.bucket === bucket)
        if (group === undefined) recordGroups.push({ bucket, rows: [row] })
        else group.rows.push(row)
      }

      /**
       * One meeting row: fixed columns — when, what, what it holds, what can be done with
       * it — so the rows line up down the page instead of drifting with the name's length.
       */
      const recordRow = (row) => h('div', {
        key: row.meetingId,
        style: styles.hubRecord,
      }, [
        h('span', { key: 'when', style: styles.hubRecordWhen }, new Date(row.startedAt).toLocaleString()),
        h('div', { key: 'main', style: styles.hubRecordMain }, [
          h(Btn, {
            key: 'open',
            type: 'button',
            style: styles.linkButton,
            onClick: () => { void openTranscript(row) },
          }, row.title === '' ? t('meetingNameNone') : row.title),
          h('span', { key: 'meta', style: styles.hint }, [
            // The type is a badge, not another word in the line: the filter chips and the
            // list then use the same vocabulary.
            row.kind === '' ? null : h('span', { key: 'kind', style: styles.chip }, t(KIND_LABEL_KEYS[row.kind] ?? 'kindGeneral')),
            row.period === '' ? null : h('span', { key: 'period', style: styles.stamp }, row.period),
            ` · ${t('panelTabTranscript')} ${row.counts.segments}`,
            ` · ${t('points')} ${row.counts.points}`,
            ` · ${t('tasks')} ${row.counts.tasks}`,
            // The check-off count the design asks for: an assignment list without its
            // completion says nothing about whether the work is being done.
            row.counts.tasks === 0 ? null : ` · ${t('hubTasksDone')} ${row.counts.done ?? 0}/${row.counts.tasks}`,
            row.counts.documents === 0 ? null : ` · ${t('panelTabMinutes')} ${row.counts.documents}`,
          ]),
          row.excerpt === '' ? null : h('span', { key: 'excerpt', style: styles.hubRecordExcerpt }, row.excerpt.length > 60 ? `${row.excerpt.slice(0, 60)}…` : row.excerpt),
        ]),
        h('div', { key: 'actions', style: styles.hubRecordActions }, [
          h(Btn, {
            key: 'send',
            type: 'button',
            style: styles.smallButton,
            title: t('hubSendHint'),
            onClick: () => { void sendToNewConversation({ meetingId: row.meetingId }) },
          }, t('hubSend')),
          row.sessionId === '' ? null : h(Btn, {
            key: 'session',
            type: 'button',
            style: styles.smallButton,
            title: t('hubOpenMeetingHint'),
            onClick: () => { void openMeeting(row) },
          }, t('hubOpenSession')),
        ]),
      ])

      return h(Boundary, null, h('section', { style: styles.hub }, [
        h('h1', { key: 'title', style: styles.hubTitle }, t('hubTitle')),
        h('p', { key: 'intro', style: styles.subtitle }, t('hubIntro')),
        h('div', { key: 'status', className: 'mr-card' }, [
          h('div', { key: 'line', style: styles.label }, t('hubCurrent')),
          h('div', { key: 'value', style: styles.status }, sessionId === ''
            ? t('hubNoSession')
            : conversationOpen ? t('hubSessionOpen') : t('hubSessionBackground')),
          h('div', { key: 'hint', style: styles.hint }, t('hubHowTo')),
        ]),
        h('div', { key: 'tabs', style: styles.tabs }, HUB_TAB_VALUES.map((value) => h(Btn, {
          key: value,
          type: 'button',
          style: hubTab === value ? styles.tabActive : styles.tab,
          onClick: () => setHubTab(value),
        }, t(HUB_TAB_KEYS[value])))),
        // Every tab body scrolls on its own: the page keeps its heading, status and tab row,
        // and whatever the tab holds moves under them.
        h('div', { key: 'hubbody', style: styles.hubBody }, [
        hubTab === 'models' ? h('div', { key: 'models', className: 'mr-card' }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('hubTabModels')),
            h(Btn, { key: 'refresh', type: 'button', style: styles.button, onClick: () => { void loadModels() } }, t('hubRefresh')),
          ]),
          h('span', { key: 'hint', style: styles.hint }, t('modelsHint')),
          // A file someone edited by hand is reported, never silently ignored.
          models.problem === '' ? null : h('p', { key: 'problem', style: styles.error }, models.problem),
          models.install?.phase === 'downloading'
            ? h('p', { key: 'progress', style: styles.note }, `${t('modelDownloading')} ${models.install.file} · ${models.install.total > 0 ? Math.min(100, Math.floor(models.install.received * 100 / models.install.total)) : 0}%`)
            : null,
          h('div', { key: 'list', style: styles.list }, models.models.map((model) => {
            const used = models.active[model.kind] === model.id
            const state = model.locked === true
              ? t('modelByDsh')
              : model.verified === true ? t('modelStateReady') : model.installed === true ? t('modelStateBad') : t('modelStateMissing')
            const size = model.totalBytes === 0 ? '—' : `${(model.totalBytes / 1048576).toFixed(1)} MB`
            return h('div', { key: model.id, style: styles.list }, [
              h('div', { key: 'row', style: styles.row }, [
                h('span', { key: 'name', style: styles.label }, `${model.name}${used ? ` · ${t('modelInUse')}` : ''}`),
                h('span', { key: 'state', style: styles.stamp }, state),
              ]),
              h('span', { key: 'meta', style: styles.hint }, `${model.kind} · ${size} · ${model.sizeClass}${model.languages.length === 0 ? '' : ` · ${model.languages.join('/')}`}`),
              model.note === '' ? null : h('span', { key: 'note', style: styles.hint }, model.note),
              model.licence === '' ? null : h('span', { key: 'licence', style: styles.hint }, `${t('modelLicence')}：${model.licence}`),
              h('div', { key: 'actions', style: styles.row }, model.locked === true ? [] : [
                model.verified === true
                  ? h(Btn, {
                    key: 'activate',
                    type: 'button',
                    style: styles.button,
                    disabled: used || modelBusy === model.id,
                    onClick: () => { void activateModelNow(model.kind, model.id) },
                  }, used ? t('modelInUse') : t('modelActivate'))
                  : h(Btn, {
                    key: 'install',
                    type: 'button',
                    style: styles.button,
                    disabled: modelBusy === model.id || models.install?.phase === 'downloading',
                    onClick: () => { void installModelNow(model.id) },
                  }, models.install?.phase === 'failed' && models.install.id === model.id ? t('modelRetry') : t('modelInstall')),
                h(Btn, {
                  key: 'import',
                  type: 'button',
                  style: styles.button,
                  disabled: modelBusy === model.id,
                  title: t('modelImportHint'),
                  onClick: () => {
                    // The file name decides which file of the model this is, so the person is
                    // told what to pick; the host refuses anything that does not match.
                    modelTarget.current = { id: model.id, name: model.files[0]?.name ?? '' }
                    modelField.current?.click()
                  },
                }, t('modelImportFile')),
                model.builtin === true ? null : h(Btn, {
                  key: 'remove',
                  type: 'button',
                  style: styles.button,
                  disabled: modelBusy === model.id,
                  onClick: () => { void removeModelNow(model.id) },
                }, t('modelRemove')),
              ]),
            ])
          })),
          h('span', { key: 'dir', style: styles.hint }, `${t('modelDirectory')}：${models.directory}`),
          h('input', {
            key: 'modelfile',
            type: 'file',
            ref: modelField,
            style: { display: 'none' },
            onChange: (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              const target = modelTarget.current
              void importModelNow(target.id, target.name, file)
            },
          }),
        ]) : null,
        hubTab === 'terms' ? h('div', { key: 'terms' }, [
          h('label', { key: 'label', style: styles.label, htmlFor: 'meeting-room-hub-terms' }, t('terms')),
          h('span', { key: 'hint', style: styles.hint }, t('termsHint')),
          h(Field, {
            key: 'input',
            id: 'meeting-room-hub-terms',
            style: styles.textarea,
            value: termsText,
            spellCheck: false,
            onChange: (event) => setTermsText(event.target.value),
          }),
        ]) : null,
        hubTab === 'settings' ? h('div', { key: 'settings', className: 'mr-card' }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('robotSettings')),
          ]),
          // One tab per configuration function: a single long card made every setting look
          // equally important and hid the one a person came for.
          h('div', { key: 'settingstabs', style: styles.row, role: 'tablist', 'aria-label': t('settingsTabs') }, SETTINGS_TABS.map(([id, label]) => h(Btn, {
            key: id,
            type: 'button',
            role: 'tab',
            'aria-selected': settingsTab === id,
            style: settingsTab === id ? styles.buttonActive : styles.button,
            onClick: () => setSettingsTab(id),
          }, t(label)))),
          h('div', { key: 'body', style: styles.list }, [
            settingsTab !== 'push' ? null : h('div', { key: 'settings-push', style: styles.list }, [
            // The delivery choice comes first: it decides whether the fields below matter.
            h('div', { key: 'mode', style: styles.row }, [
              h('span', { key: 'label', style: styles.status }, t('pushMode')),
              h(Picker, {
                key: 'select',
                style: styles.inlineInput,
                value: settingsDraft.mode,
                onChange: (event) => setSettingsDraft((draft) => ({ ...draft, mode: event.target.value })),
              }, PUSH_MODE_VALUES.map((value) => h('option', { key: value, value }, t(PUSH_MODE_KEYS[value])))),
            ]),
            h('span', { key: 'hint', style: styles.hint }, t('robotHint')),
            h(Field, {
              key: 'dingtalk',
              style: styles.textarea,
              placeholder: `dingtalk ${t('robotNone')}`,
              value: settingsDraft.dingtalk,
              spellCheck: false,
              onChange: (event) => setSettingsDraft((value) => ({ ...value, dingtalk: event.target.value })),
            }),
            h(Field, {
              key: 'wecom',
              style: styles.textarea,
              placeholder: `wecom ${t('robotNone')}`,
              value: settingsDraft.wecom,
              spellCheck: false,
              onChange: (event) => setSettingsDraft((value) => ({ ...value, wecom: event.target.value })),
            }),
            h('span', { key: 'apphint', style: styles.hint }, t('robotAppHint')),
            h(Field, {
              key: 'appKey',
              style: styles.textarea,
              placeholder: settings.appKey === undefined || settings.appKey === '' ? 'AppKey' : `AppKey ${settings.appKey}`,
              value: settingsDraft.appKey,
              spellCheck: false,
              onChange: (event) => setSettingsDraft((value) => ({ ...value, appKey: event.target.value })),
            }),
            h(Field, {
              key: 'appSecret',
              type: 'password',
              style: styles.textarea,
              placeholder: settings.hasSecret === true ? t('secretKept') : 'AppSecret',
              value: settingsDraft.appSecret,
              spellCheck: false,
              onChange: (event) => setSettingsDraft((value) => ({ ...value, appSecret: event.target.value })),
            }),
            h(Field, {
              key: 'agentId',
              style: styles.textarea,
              placeholder: 'AgentId',
              value: settingsDraft.agentId,
              spellCheck: false,
              onChange: (event) => setSettingsDraft((value) => ({ ...value, agentId: event.target.value })),
            }),
            h('div', { key: 'actions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', style: styles.button, onClick: () => { void saveSettings() } }, t('robotSave')),
              settingsNote === '' ? null : h('span', { key: 'note', style: styles.status }, settingsNote),
            ]),
            ]),
            settingsTab !== 'weights' ? null : h('div', { key: 'settings-weights', style: styles.list }, [
            // Monthly score weights (§2.4, P4). They are stored as fractions but edited as
            // percentages, and the three must add up before anything is written.
            h('span', { key: 'weightstitle', style: styles.label }, t('scoreWeightTitle')),
            h('span', { key: 'weightshint', style: styles.hint }, t('scoreWeightHint')),
            h('div', { key: 'weights', style: styles.row }, [
              ...['quality', 'completion', 'learn'].map((key) => h('label', { key, style: styles.row }, [
                h('span', { key: 'label', style: styles.status }, t(key === 'quality' ? 'scoreQuality' : key === 'completion' ? 'scoreCompletion' : 'scoreLearn')),
                h(Field, {
                  key: 'value',
                  type: 'number',
                  min: 0,
                  max: 100,
                  step: 1,
                  style: styles.inlineInput,
                  value: String(weightsDraft[key] ?? 0),
                  onChange: (event) => setWeightsDraft((draft) => ({ ...draft, [key]: Number(event.target.value) })),
                }),
                h('span', { key: 'pct', style: styles.status }, '%'),
              ])),
              h('span', {
                key: 'sum',
                style: (weightsDraft.quality + weightsDraft.completion + weightsDraft.learn) === 100 ? styles.status : styles.error,
              }, `${t('scoreWeightSum')} ${weightsDraft.quality + weightsDraft.completion + weightsDraft.learn}%`),
            ]),
            h('div', { key: 'weightsactions', style: styles.row }, [
              h(Btn, { key: 'saveweights', type: 'button', style: styles.button, onClick: () => { void saveWeights() } }, t('scoreWeightSave')),
              weightsNote === '' ? null : h('span', { key: 'note', style: styles.status }, weightsNote),
            ]),
            ]),
            settingsTab !== 'templates' ? null : h('div', { key: 'settings-templates', style: styles.list }, [
            // Per-type distillation wording (§9 P4): the prompt behind each one-click button
            // can be replaced without touching the code. An empty box uses the built-in text.
            h('span', { key: 'templatestitle', style: styles.label }, t('templateTitle')),
            h('span', { key: 'templateshint', style: styles.hint }, t('templateHint')),
            ...['briefing', 'review', 'weekly', 'monthly'].map((kind) => h('label', { key: kind, style: styles.fieldBlock }, [
              h('span', { key: 'label', style: styles.status }, t(KIND_LABEL_KEYS[kind])),
              h('textarea', {
                key: 'text',
                style: styles.templateArea,
                value: templateDraft[kind] ?? '',
                placeholder: t(DISTILL_PROMPT_KEYS[kind]),
                spellCheck: false,
                onChange: (event) => setTemplateDraft((draft) => ({ ...draft, [kind]: event.target.value })),
              }),
            ])),
            h('div', { key: 'templateactions', style: styles.row }, [
              h(Btn, { key: 'savetemplates', type: 'button', style: styles.button, onClick: () => { void saveTemplates() } }, t('templateSave')),
              templatesNote === '' ? null : h('span', { key: 'note', style: styles.status }, templatesNote),
            ]),
            ]),
            settingsTab !== 'cloud' ? null : h('div', { key: 'settings-cloud', style: styles.list }, [
            // Cloud recognition sits with the robots because it is the same kind of decision:
            // something leaves this machine, and only when a person says so.
            h('span', { key: 'cloudtitle', style: styles.label }, t('cloudTitle')),
            h('span', { key: 'cloudhint', style: styles.hint }, t('cloudHint')),
            h('div', { key: 'cloudconsent', style: styles.row }, [
              h(Field, {
                key: 'consent',
                type: 'checkbox',
                checked: cloudDraft.consent,
                onChange: (event) => setCloudDraft((draft) => ({ ...draft, consent: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('cloudConsent')),
            ]),
            h('div', { key: 'cloudprovider', style: styles.row }, [
              h('span', { key: 'label', style: styles.status }, t('cloudProvider')),
              h(Picker, {
                key: 'select',
                style: styles.inlineInput,
                value: cloudDraft.provider,
                onChange: (event) => setCloudDraft((draft) => ({ ...draft, provider: event.target.value })),
              }, CLOUD_PROVIDER_VALUES.map((value) => h('option', { key: value, value }, t(CLOUD_PROVIDER_KEYS[value])))),
            ]),
            h(Field, {
              key: 'cloudbase',
              style: styles.textarea,
              placeholder: 'https://api.example.com/v1',
              value: cloudDraft.baseUrl,
              spellCheck: false,
              onChange: (event) => setCloudDraft((draft) => ({ ...draft, baseUrl: event.target.value })),
            }),
            h(Field, {
              key: 'cloudmodel',
              style: styles.textarea,
              placeholder: 'model（如 whisper-1）',
              value: cloudDraft.model,
              spellCheck: false,
              onChange: (event) => setCloudDraft((draft) => ({ ...draft, model: event.target.value })),
            }),
            h(Field, {
              key: 'cloudlanguage',
              style: styles.textarea,
              placeholder: 'language（如 zh，可留空）',
              value: cloudDraft.language,
              spellCheck: false,
              onChange: (event) => setCloudDraft((draft) => ({ ...draft, language: event.target.value })),
            }),
            h(Field, {
              key: 'cloudkey',
              type: 'password',
              style: styles.textarea,
              placeholder: cloud.asr?.keySet === true ? t('secretKept') : 'API Key',
              value: cloudDraft.apiKey,
              spellCheck: false,
              onChange: (event) => setCloudDraft((draft) => ({ ...draft, apiKey: event.target.value })),
            }),
            // Saying exactly where the audio would go is the point of asking: "cloud" on its
            // own is not something a person can judge.
            h('span', { key: 'cloudwhere', style: styles.hint }, cloud.asr?.host === undefined || cloud.asr.host === ''
              ? t('cloudNowhere')
              : `${t('cloudWhere')}：${cloud.asr.host} · ${t('cloudRetention')}`),
            cloud.state?.fallback === true
              ? h('span', { key: 'cloudfallback', style: styles.error }, `${t('cloudFallback')}：${cloud.state.message}`)
              : null,
            h('div', { key: 'cloudactions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', style: styles.button, onClick: () => { void saveCloud() } }, t('cloudSave')),
              h(Btn, { key: 'test', type: 'button', style: styles.button, disabled: cloudBusy, onClick: () => { void runCloudTest() } }, t('cloudTest')),
              cloudNote === '' ? null : h('span', { key: 'note', style: styles.status }, cloudNote),
            ]),
            ]),
            settingsTab !== 'speaker' ? null : h('div', { key: 'settings-speaker', style: styles.list }, [
            // Speaker recognition: how voices are told apart, and the library that remembers them.
            h('span', { key: 'speakertitle', style: styles.label }, t('speakerTitle')),
            h('div', { key: 'presets', style: styles.row }, [
              h('span', { key: 'label', style: styles.status }, t('speakerThreshold')),
              ...speakerSettings.presets.map((preset) => h(Btn, {
                key: preset.id,
                type: 'button',
                style: speakerDraft.threshold === preset.threshold ? styles.buttonActive : styles.button,
                title: preset.note,
                onClick: () => setSpeakerDraft((draft) => ({ ...draft, threshold: preset.threshold })),
              }, `${preset.threshold}`)),
              h(Field, {
                key: 'threshold',
                type: 'number',
                style: styles.inlineInput,
                value: String(speakerDraft.threshold),
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, threshold: Number(event.target.value) })),
              }),
            ]),
            h('div', { key: 'full', style: styles.row }, [
              h(Field, {
                key: 'fullrelabel',
                type: 'checkbox',
                checked: speakerDraft.fullRelabel,
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, fullRelabel: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('speakerFullRelabel')),
              speakerDraft.fullRelabel ? null : h(Field, {
                key: 'cap',
                type: 'number',
                style: styles.inlineInput,
                value: String(speakerDraft.backfillCap),
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, backfillCap: Number(event.target.value) })),
              }),
            ]),
            h('span', { key: 'speakerhint', style: styles.hint }, t('speakerSettingsHint')),
            h('div', { key: 'voicelist', style: styles.list }, speakerSettings.library.length === 0
              ? [h('span', { key: 'none', style: styles.hint }, t('voiceLibraryEmpty'))]
              : [
                h('span', { key: 'label', style: styles.label }, `${t('voiceLibrary')} (${speakerSettings.library.length})`),
                ...speakerSettings.library.map((voice) => h('div', { key: voice.name, style: styles.row }, [
                  h('span', { key: 'name', style: styles.status }, `${voice.name} · ${voice.count}`),
                  h(Btn, {
                    key: 'forget',
                    type: 'button',
                    style: styles.smallButton,
                    onClick: () => { void forgetVoice(voice.name) },
                  }, t('voiceForget')),
                ])),
                h(Btn, {
                  key: 'clear',
                  type: 'button',
                  style: styles.smallButton,
                  onClick: () => { void forgetVoice('') },
                }, t('voiceClear')),
              ]),
            h('span', { key: 'voicefile', style: styles.hint }, `${t('voiceLibraryFile')}：${speakerSettings.libraryFile}`),
            h('div', { key: 'speakeractions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', style: styles.button, onClick: () => { void saveSpeakerSettings() } }, t('speakerSave')),
              voiceNote === '' ? null : h('span', { key: 'note', style: styles.status }, voiceNote),
            ]),
            ]),
            settingsTab !== 'transcript' ? null : h('div', { key: 'settings-transcript', style: styles.list }, [
            // Transcript: how it reads, and where a cue is cut.
            h('span', { key: 'transcripttitle', style: styles.label }, t('transcriptTitle')),
            h('div', { key: 'normalize', style: styles.row }, [
              h(Field, {
                key: 'on',
                type: 'checkbox',
                checked: transcriptDraft?.normalize !== false,
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), normalize: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('transcriptNormalize')),
            ]),
            h('span', { key: 'normalizehint', style: styles.hint }, t('transcriptNormalizeHint')),
            // The switch decides whether the cue is shaped for a local recogniser or sent whole
            // to the cloud, so it has to say which one this installation will actually use.
            h('div', { key: 'cues', style: styles.row }, [
              h('span', { key: 'min', style: styles.status }, t('transcriptMinCue')),
              h(Field, {
                key: 'minvalue',
                type: 'number',
                style: styles.inlineInput,
                value: String(transcriptDraft?.minChunkSeconds ?? ''),
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), minChunkSeconds: Number(event.target.value) })),
              }),
              h('span', { key: 'max', style: styles.status }, t('transcriptMaxCue')),
              h(Field, {
                key: 'maxvalue',
                type: 'number',
                style: styles.inlineInput,
                value: String(transcriptDraft?.maxChunkSeconds ?? ''),
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), maxChunkSeconds: Number(event.target.value) })),
              }),
            ]),
            h('div', { key: 'lines', style: styles.row }, [
              h('span', { key: 'linechars', style: styles.status }, t('transcriptMaxLine')),
              h(Field, {
                key: 'linevalue',
                type: 'number',
                style: styles.inlineInput,
                value: String(transcriptDraft?.maxLineChars ?? ''),
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), maxLineChars: Number(event.target.value) })),
              }),
            ]),
            h('div', { key: 'vad', style: styles.row }, [
              h('span', { key: 'hold', style: styles.status }, t('transcriptSilenceHold')),
              h(Field, {
                key: 'holdvalue',
                type: 'number',
                style: styles.inlineInput,
                value: String(transcriptDraft?.silenceHoldSeconds ?? ''),
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), silenceHoldSeconds: Number(event.target.value) })),
              }),
              h('span', { key: 'rms', style: styles.status }, t('transcriptSilenceRms')),
              h(Field, {
                key: 'rmsvalue',
                type: 'number',
                style: styles.inlineInput,
                value: String(transcriptDraft?.silenceRms ?? ''),
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcript), silenceRms: Number(event.target.value) })),
              }),
            ]),
            h('span', { key: 'cuehint', style: styles.hint }, t('transcriptCueHint')),
            h('span', { key: 'rulecount', style: styles.hint }, `${t('transcriptRules')}：${(transcriptDraft?.normalizeRules ?? []).length}/${transcriptRules.length}`),
            h('div', { key: 'transcriptactions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', style: styles.button, onClick: () => { void saveTranscript() } }, t('transcriptSave')),
              transcriptNote === '' ? null : h('span', { key: 'note', style: styles.status }, transcriptNote),
            ]),
            ]),
          ]),
        ]) : null,
        hubTab === 'people' ? h('div', { key: 'people', className: 'mr-card' }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('peopleTitle')),
            h('span', { key: 'count', style: styles.stamp }, `${settings.people.length} ${t('peopleUnit')}`),
          ]),
          h('div', { key: 'body', style: styles.list }, [
            h('span', { key: 'peoplehint', style: styles.hint }, t('peopleHint')),
            // DingTalk knows the organisation, so the roster can be filled from it instead of
            // typed by hand; one department or the whole tree.
            h('div', { key: 'sync', style: styles.row }, [
              h(Btn, {
                key: 'read',
                type: 'button',
                style: styles.button,
                disabled: directoryBusy,
                onClick: () => { void readDepartments() },
              }, t('readDepartments')),
              h(Picker, {
                key: 'dept',
                style: styles.inlineInput,
                value: String(deptId),
                onChange: (event) => setDeptId(Number(event.target.value)),
              }, [
                h('option', { key: 'all', value: '0' }, t('allOrganization')),
                ...settings.departments.map((department) => h('option', {
                  key: department.id,
                  value: String(department.id),
                }, department.name)),
              ]),
              h(Btn, {
                key: 'sync',
                type: 'button',
                style: styles.buttonActive,
                disabled: directoryBusy,
                onClick: () => { void syncPeople() },
              }, directoryBusy ? t('hubWorking') : t('syncFromDingtalk')),
            ]),
            ...settings.people.map((person) => h('div', { key: person.name, style: styles.row }, [
              h('span', { key: 'name', style: styles.chip }, person.name),
              h('span', { key: 'phone', style: styles.status }, person.phone === '' ? t('phonePh') : person.phone),
              h('span', { key: 'userId', style: styles.status }, person.userId === '' ? t('userIdPh') : person.userId),
              h(Btn, {
                key: 'edit',
                type: 'button',
                style: styles.smallButton,
                onClick: () => setPersonDraft({ name: person.name, phone: person.phone, userId: person.userId }),
              }, t('editEntry')),
              h(Btn, {
                key: 'del',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { void savePerson({ name: person.name }, 'remove') },
              }, t('remove')),
            ])),
            h('div', { key: 'personadd', style: styles.row }, [
              h(Field, {
                key: 'name',
                style: styles.inlineInput,
                placeholder: t('speakerNamePlaceholder'),
                value: personDraft.name,
                spellCheck: false,
                onChange: (event) => setPersonDraft((value) => ({ ...value, name: event.target.value })),
              }),
              h(Field, {
                key: 'phone',
                style: styles.inlineInput,
                placeholder: t('phonePh'),
                value: personDraft.phone,
                spellCheck: false,
                onChange: (event) => setPersonDraft((value) => ({ ...value, phone: event.target.value })),
              }),
              h(Field, {
                key: 'userId',
                style: styles.inlineInput,
                placeholder: t('userIdPh'),
                value: personDraft.userId,
                spellCheck: false,
                onChange: (event) => setPersonDraft((value) => ({ ...value, userId: event.target.value })),
              }),
              h(Btn, {
                key: 'add',
                type: 'button',
                style: styles.button,
                disabled: personDraft.name.trim() === '',
                onClick: () => { void savePerson(personDraft) },
              }, t('saveEntry')),
            ]),
          ]),
        ]) : null,
        hubTab === 'records' ? h('div', { key: 'records', className: 'mr-card' }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('hubRecords')),
            h(Btn, { key: 'refresh', type: 'button', style: styles.button, onClick: () => { void refresh() } }, t('hubRefresh')),
            // Bringing a meeting in from another DSH: the archive holds the record, its
            // recording and the artifacts that belong to it.
            h(Btn, {
              key: 'import',
              type: 'button',
              style: styles.button,
              disabled: importing,
              title: t('hubImportHint'),
              onClick: () => {
                const field = importField.current
                // The field is rendered right next to this button; if it ever is not, say so
                // instead of a click that appears to do nothing.
                if (field === null) {
                  console.warn('meeting-room: the import file field is not mounted')
                  setError(t('hubImportHint'))
                  return
                }
                field.click()
              },
            }, importing ? `${t('hubImport')} …` : t('hubImport')),
            // A raw element rather than the Field wrapper: React does not hand a `ref` to a function
            // component, so a ref on Field stays null and the button would silently do nothing.
            h('input', {
              key: 'importfile',
              type: 'file',
              ref: importField,
              accept: '.zip,application/zip',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void importMeeting(file)
              },
            }),
          ]),
          // Where the last meeting left off: opening the record page should answer "what did
          // we last talk about?" before the person scrolls the list.
          records.length === 0 ? null : h('span', { key: 'lasttopic', style: styles.hint },
            `${t('hubLastTopic')}：${records[0].title === '' ? t('meetingNameNone') : records[0].title}`
            + `${records[0].excerpt === '' ? '' : ` · ${records[0].excerpt.length > 50 ? `${records[0].excerpt.slice(0, 50)}…` : records[0].excerpt}`}`),
          // Kind filter chips and the day/week/month grouping (§5.2): the same history,
          // asked for by type and by the calendar unit that type is judged on.
          h('div', { key: 'filters', style: styles.row }, [
            h('div', { key: 'kinds', className: 'mr-chips' }, ['__all__', ...KIND_VALUES].map((value) => h(Btn, {
              key: value === '' ? 'general' : value,
              type: 'button',
              style: hubKind === value ? styles.buttonActive : styles.button,
              onClick: () => setHubKind(value),
            }, t(value === '__all__' ? 'hubAll' : KIND_LABEL_KEYS[value])))),
            h(Picker, {
              key: 'group',
              style: styles.inlineInput,
              value: hubGroup,
              title: t('hubGroupBy'),
              onChange: (event) => setHubGroup(event.target.value),
            }, [['day', 'hubGroupDay'], ['week', 'hubGroupWeek'], ['month', 'hubGroupMonth']].map(([value, key]) => h('option', {
              key: value,
              value,
            }, t(key)))),
          ]),
          visibleRecords.length === 0
            ? h('p', { key: 'empty', style: styles.empty }, records.length === 0 ? t('hubEmpty') : t('hubFilterEmpty'))
            // One row per MEETING, not per exported file: the meeting is the record, and its
            // files are artifacts of it (FEATURES §5.4's rule, applied to this page too).
            : h('div', { key: 'list', className: 'mr-list' }, recordGroups.map((group) => h('div', {
              key: group.bucket,
              style: styles.list,
            }, [
              h('div', { key: 'bucket', style: styles.groupHead }, group.bucket),
              ...group.rows.map(recordRow),
            ]))),
          // More than one page: say how many are left and let the person ask for them.
          records.length < recordsTotal ? h('div', { key: 'more', style: styles.row }, [
            h(Btn, {
              key: 'load',
              type: 'button',
              style: styles.button,
              onClick: () => { void refresh(records.length) },
            }, `${t('hubLoadMore')} (${recordsTotal - records.length})`),
          ]) : null,
        ]) : null,
        hubTab === 'records' && preview !== null ? h('div', { key: 'preview', className: 'mr-card' }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'name', style: styles.label }, preview.name),
            h(Btn, { key: 'close', type: 'button', style: styles.button, onClick: () => setPreview(null) }, t('hubClose')),
          ]),
          preview.image
            ? h('img', {
              key: 'img',
              style: styles.inkShot,
              alt: preview.name,
              src: `${PREFIX}/raw?name=${encodeURIComponent(preview.name)}`,
            })
            : preview.name.endsWith('.md')
              ? h('pre', { key: 'body', style: styles.pre }, preview.markdown)
              : preview.segments.length > 0
                ? h(SyncedTranscriptPlayer, {
                  key: 'player',
                  t,
                  src: preview.audioName === '' ? '' : `${PREFIX}/audio?name=${encodeURIComponent(preview.audioName)}`,
                  segments: preview.segments,
                })
                : h('p', { key: 'none', style: styles.empty }, t('hubNoText')),
        ]) : null,
        error === '' ? null : h('p', { key: 'error', style: styles.error }, `${t('error')}: ${error}`),
        ]),
      ]))
    }

    const SPEECH_BUSY = ['downloading', 'checking', 'loading', 'waking']
    async function readSpeechState() {
      try {
        const reply = await get('/speech')
        const phase = typeof reply.phase === 'string' ? reply.phase : 'unavailable'
        const ready = reply.ready === true || phase === 'ready'
        const message = typeof reply.message === 'string' ? reply.message : ''
        const completedBytes = typeof reply.completedBytes === 'number' ? reply.completedBytes : 0
        const totalBytes = typeof reply.totalBytes === 'number' ? reply.totalBytes : 0
        return { ready, phase, busy: SPEECH_BUSY.includes(phase), message, completedBytes, totalBytes }
      } catch (failure) {
      // A missing or unreachable route is NOT readiness. This fallback once said `ready: true`,
      // which turned a half-installed plugin (no host routes registered at all) into "ready"
      // and sent the first click down a path that could only fail.
      const status = typeof failure?.status === 'number' ? failure.status : 0
      return {
        ready: false,
        // 404 is its own case: the route does not exist, so no amount of waiting will help.
        phase: status === 404 ? 'missing' : 'unavailable',
        busy: false,
        message: failure instanceof Error ? failure.message : String(failure),
        completedBytes: 0,
        totalBytes: 0,
      }
    }
    }
    function SetupNotice(props) {
      const [preparing, setPreparing] = React.useState(false)
      const [done, setDone] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      async function prepare() {
        if (preparing) return
        setPreparing(true); setDone(false); setFailure('')
        try {
          await post('/prepare', {})
          const deadline = Date.now() + 240000
          for (;;) {
            const reply = await get('/prepare')
            const sp = typeof reply.speaker?.phase === 'string' ? reply.speaker.phase : ''
            const hw = typeof reply.handwriting?.phase === 'string' ? reply.handwriting.phase : ''
            if (sp === 'failed' || hw === 'failed') { setFailure([reply.speaker?.message, reply.handwriting?.message].filter(Boolean).join('; ') || props.t('setupPrepareFailed')); break }
            if (sp !== 'downloading' && sp !== 'unprepared' && hw !== 'downloading' && hw !== 'unprepared') { setDone(true); break }
            if (Date.now() >= deadline) { setFailure(props.t('setupPrepareFailed')); break }
            await new Promise((r) => setTimeout(r, 1500))
          }
        } catch (e) { setFailure(e instanceof Error ? e.message : String(e)) }
        finally { setPreparing(false) }
      }
      const status = failure ? h('span', { style: styles.error }, failure) : done ? h('span', { style: styles.status }, props.t('setupPrepared')) : preparing ? h('span', { style: styles.status }, props.t('setupPreparing')) : null
      return h('div', { style: styles.setupOverlay, role: 'dialog', 'aria-modal': 'true' }, [h('div', { style: styles.setupCard }, [
        h('h2', { style: styles.setupTitle }, props.t('setupTitle')),
        h('p', { style: styles.subtitle }, props.t('setupBody')),
        h('div', { style: styles.setupFeature }, '\u00b7 ' + props.t('setupTranscribe')),
        h('div', { style: styles.setupFeature }, '\u00b7 ' + props.t('setupSpeaker')),
        h('div', { style: styles.setupFeature }, '\u00b7 ' + props.t('setupHandwriting')),
        h('p', { style: styles.note }, props.t('setupNote')),
        h('p', { style: styles.note }, props.t('setupPrepareHint')),
        status,
        h('div', { style: styles.setupFoot }, [
          h(Btn, { key: 'p', type: 'button', style: styles.button, disabled: preparing, onClick: () => { void prepare() } }, props.t('setupPrepare')),
          h(Btn, { key: 'd', type: 'button', style: styles.button, onClick: () => props.onOpenDetails() }, props.t('setupDetails')),
          h(Btn, { key: 'x', type: 'button', style: styles.button, onClick: () => props.onDismiss() }, props.t('setupDismiss')),
        ]),
      ])])
    }
    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meeting-room: dictionaries')
        const t = ctx.locale.bind(NS)

        /**
         * Resolve the shared layout store product (state plus actions). The store seat
         * sits on the registration entry itself, not inside its options table.
         * @returns the store instance, or null when the seat is unreadable.
         */
        function layoutStore() {
          try {
            const entries = ctx.slots.entries('root')
            const entry = entries.find((candidate) => candidate.store !== undefined)
              ?? entries.find((candidate) => candidate.options?.store !== undefined)
            const seat = entry?.store ?? entry?.options?.store
            return seat?.create?.() ?? null
          } catch (failure) {
            console.warn('meeting-room: could not reach the layout store', failure)
            return null
          }
        }

        /**
         * Read the workspace rail's collapsed state. The layout service only toggles, so
         * without this read the button would expand an already-closed rail.
         * @returns true when collapsed, false when open, null when unreadable.
         */
        function readRailCollapsed() {
          const sidebar = layoutStore()?.getSnapshot?.()?.layoutInfo?.sidebar
          // The layout store records 0 for the closed preference and a px width otherwise.
          return typeof sidebar === 'number' ? sidebar === 0 : null
        }

        /**
         * Set the right panel's width preference. The layout service exposes no width
         * setter, so this writes the store's own action, which clamps to the frame's
         * maximum — the widest the panel can be while the conversation stays visible.
         * @param px - Requested width in px.
         */
        function setRightbarWidth(px) {
          try {
            layoutStore()?.actions?.setRightbar?.(px)
          } catch (failure) {
            console.warn('meeting-room: could not set the right panel width', failure)
          }
        }

        /** Panel width to restore when leaving meeting focus; null until the first focus. */
        let savedRightbar = null

        /**
         * Toggle meeting focus from the session header. Opening: collapse the workspace
         * rail, open the meeting panel, and widen it to the frame's maximum while the
         * conversation stays visible. Closing: shut the right panel and give the frame
         * back to the workspace.
         *
         * The decision follows the pane's real state, never a remembered flag: a pane the
         * user closed by any other route would otherwise leave the memory stale and make every
         * later click take the opening branch again, collapsing the rail each time.
         */
        function toggleMeetingFocus() {
          if (ctx.sidebarRight.isExpanded()) {
            // Collapse the column first: it is the visible close of the right window.
            ctx.sidebarRight.toggleExpanded()
            if (readRailCollapsed() === true) ctx.layout.toggleSidebar()
            if (savedRightbar !== null) setRightbarWidth(savedRightbar)
            return
          }
          openMeetingFocus()
        }

        /**
         * Open the meeting panel without ever closing it. `focus` (the default, used by a
         * click on the header button) also collapses the workspace rail and widens the column;
         * the automatic open that follows a click in the management page passes false, so the
         * person keeps their rail and their panel width.
         * @param focus - whether to take over the frame as well.
         * @returns whether the column accepted the tab.
         */
        function openMeetingFocus(focus = true) {
          if (focus && readRailCollapsed() === false) ctx.layout.toggleSidebar()
          // Opening expands the column and seeds its default width when it never had one.
          ctx.sidebarRight.openTab(TAB_KIND)
          if (focus !== true) return true
          const info = layoutStore()?.getSnapshot?.()?.layoutInfo
          savedRightbar = typeof info?.rightbar === 'number' ? info.rightbar : null
          setRightbarWidth(info?.viewportWidth ?? window.innerWidth)
          return true
        }

        /**
         * Submit a prompt carrying one drawing into a session, so handwriting recognition
         * runs through the agent loop and both the request and the answer stay in the log.
         * @param sessionId - Target session.
         * @param text - Prompt text.
         * @param pngBase64 - The drawing as base64 PNG bytes.
         * @returns whether the prompt was accepted.
         */
        async function askNote(sessionId, text, pngBase64) {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return { ok: false, error: 'no live session binding' }
          const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
          try {
            const result = await binding.session.prompt([
              { type: 'text', text },
              { type: 'image', mediaType: 'image/png', data: pngBase64, name: 'note.png' },
            ], 'queue', undefined, handle.requestId)
            if (!result.ok) {
              handle.abandon()
              return { ok: false, error: String(result.error?.code ?? 'rejected') }
            }
            return { ok: true }
          } catch (failure) {
            handle.abandon()
            return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
          }
        }

        /**
         * Submit a plain text prompt into a session, so a request and its answer stay in the
         * conversation log.
         * @param sessionId - Target session.
         * @param text - Prompt text.
         * @returns whether the prompt was accepted.
         */
        async function askText(sessionId, text) {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return { ok: false, error: 'no live session binding' }
          const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
          try {
            const result = await binding.session.prompt([{ type: 'text', text }], 'queue', undefined, handle.requestId)
            if (!result.ok) {
              handle.abandon()
              return { ok: false, error: String(result.error?.code ?? 'rejected') }
            }
            return { ok: true }
          } catch (failure) {
            handle.abandon()
            return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
          }
        }

        // A page type (no patterns): the header button opens it by kind.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('title'),
          // The start page's guide: one card, first in the list, that opens this panel and
          // starts recording (see GuideStartCard). Clicking a guide card opens its kind, so
          // the card itself only has to arm the begin request.
          guide: [{
            id: 'start',
            order: 5,
            title: () => t('guideTitle'),
            description: () => t('guideDescription'),
          }],
        }), 'meeting-room: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
          inject: () => ({
            askNote,
            askText,
            /**
             * Bring this panel's tab forward in its own column. The panel calls this when it
             * was asked to show a meeting, which is more reliable than the caller doing it
             * before the conversation switch has finished rebuilding the column.
             * @returns whether the tab could be selected.
             */
            focusMeetingPanel: () => {
              try {
                ctx.sidebarRight.openTab(TAB_KIND)
                return true
              } catch (failure) {
                console.warn('meeting-room: could not focus the meeting tab', failure)
                return false
              }
            },
            openVoiceInputBundle: () => { if (readRailCollapsed() === true) ctx.layout.toggleSidebar(); const nav = ctx.get('pluginNavigation'); if (nav) nav.openBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'); else ctx.layout.selectPanel('plugins') },
          }),
        }, MeetingPanel))
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: TAB_ID,
        }, MeetingTabTitle))
        // One card, not the standard icon button: the whole point is that a single click
        // begins the meeting, so the click arms the panel and opens its tab.
        ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
          name: 'sidebar.right.tab.guide.entry', key: TAB_ID, locale: NS,
          inject: () => ({
            begin: (workspaceId) => {
              // Already recording: the panel belongs to the running meeting, so just bring
              // its tab forward instead of starting a second conversation.
              if (recorder.active !== null) {
                try {
                  ctx.sidebarRight.openTab(TAB_KIND)
                } catch (failure) {
                  console.warn('meeting-room: the guide could not open the meeting tab', failure)
                }
                return
              }
              // A fresh conversation for every meeting: its transcript and the Agent's work
              // stay in one session instead of mixing with whatever was open before.
              guideBegin.pending = true
              guideBegin.opened = false
              // Without this window a request that never reached a session would fire later.
              guideBegin.deadline = Date.now() + 15_000
              void (async () => {
                let created = ''
                try {
                  if (typeof workspaceId === 'string' && workspaceId !== '') {
                    created = await ctx.uiWorkspace.connectWorkspace(workspaceId)
                  }
                } catch (failure) {
                  console.warn('meeting-room: the guide could not create a session', failure)
                }
                try {
                  // `openSession` swaps the main surface synchronously; knowing the id is
                  // what makes the next step land in the *new* session rather than the old.
                  guideBegin.target = typeof created === 'string' ? created : ''
                  if (guideBegin.target !== '') ctx.uiWorkspace.openSession(guideBegin.target)
                  else ctx.uiWorkspace.startSession(workspaceId)
                } catch (failure) {
                  console.warn('meeting-room: the guide could not open the new session', failure)
                  guideBegin.pending = false
                  return
                }
                // The meeting tab belongs to a session, so it can only be opened after the
                // switch. Retry briefly: the column rebuilds after the main surface changes.
                for (const delay of [60, 250, 800]) {
                  window.setTimeout(() => {
                    if (guideBegin.pending !== true) return
                    try {
                      ctx.sidebarRight.openTab(TAB_KIND)
                    } catch (failure) {
                      console.warn('meeting-room: the guide could not open the meeting tab', failure)
                    }
                  }, delay)
                }
              })()
            },
          }),
        }, GuideStartCard))
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'meeting-room.open',
          order: 20,
          locale: NS,
          inject: () => ({ open: () => toggleMeetingFocus(), openOnly: () => openMeetingFocus(false) }),
        }, OpenMeetingButton))

        // The left-sidebar row and its main-panel page share one id: the row addresses the page.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          // Navigating the workspace is the shell's job, so the page asks for the service
          // rather than reaching into the session list itself.
          inject: () => ({
            /**
             * Open a fresh conversation with this meeting's content ready in the input.
             * @param prompt - The text the new conversation starts from.
             * @returns whether the workspace could take it.
             */
            startConversation: (prompt) => {
              const workspace = ctx.get('uiWorkspace')
              if (workspace === undefined) return false
              workspace.startSession(undefined, { prompt, clearPreviousDraft: true })
              return true
            },
            /**
             * Show the conversation that produced a meeting.
             * @param sessionId - Target session.
             * @returns whether the workspace could open it.
             */
            openConversation: (sessionId) => {
              const workspace = ctx.get('uiWorkspace')
              if (workspace === undefined || sessionId === '') return false
              // `openSession(target)` takes the SessionId ITSELF — it is passed straight to
              // `replaceMain`. Handing it `{ sessionId }` resolves to no session at all and
              // lands on a blank one, which is exactly what "it only opened a new chat" was.
              console.info('meeting-room: revealing session', sessionId)
              workspace.openSession(sessionId)
              return true
            },
            /**
             * Open the meeting panel column beside whichever conversation is showing, so the
             * page's "open meeting" lands on the record itself rather than only the chat.
             * @returns whether the column could be opened.
             */
            openMeetingPanel: () => {
              try {
                // The right column addresses a mounted conversation surface, and while the
                // management page holds the main area there is none — `selectPanel(null)`
                // shows the Conversation, which is the session already selected by the click.
                try {
                  ctx.layout.selectPanel(null)
                } catch {
                  // Older or restricted layout: fall through and let openTab speak for itself.
                }
                // Always select the tab: skipping this when the column is merely expanded
                // left whatever other tab was showing in place of the meeting.
                ctx.sidebarRight.openTab(TAB_KIND)
                return true
              } catch (failure) {
                // The shell needs a mounted, adopted session surface — one exists only while
                // the conversation is on screen. Report the real reason occasionally, not on
                // every poll.
                panelOpenFailures += 1
                if (panelOpenFailures === 1 || panelOpenFailures % 40 === 0) {
                  console.warn('meeting-room: the right panel refused the tab', failure)
                }
                return false
              }
            },
          }),
        }, MeetingHubPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('hubTitle'),
        }, MeetingPanelIcon))
        try {
          ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: 'dsh-meeting-room', locale: NS }, SetupNotice))
        } catch (error) {
          // The activation guidance slot is declared by the plugin manager; if it is
          // ever unavailable, the rest of the plugin must still load.
          console.warn('meeting-room: could not register the bundle activation notice', error)
        }
      },
    }
  },
})
