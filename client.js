/**
 * Browser half of the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：kekydream@qq.com
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
     * searches with, so it is the one that behaves under an IME; the plugin falls back to a
     * plain input (with its own composition handling) if the module is absent.
     */
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }
    const SearchInput = typeof primitives.Input === 'function' || typeof primitives.Input === 'object' ? primitives.Input : 'input'

    /** Locale namespace owned by this plugin. */
    const NS = 'meetingRoom'

    /** Tab implementation identity; the body and title register under it. */
    const TAB_ID = 'dsh-meeting-room'

    /** Tab type discriminator used by `sidebarRight.openTab`. */
    const TAB_KIND = 'meeting-room'

    /** Route prefix owned by the host half. */
    const PREFIX = '/meeting-room'

    /** Main-panel key and left-sidebar row id; the row id addresses this page. */
    const PANEL_ID = 'meeting-room'

    /** Browser-storage key holding the terminology list between meetings. */
    const TERMS_KEY = 'dsh-meeting-room.terms'

    /** Target sample rate for the speech provider. */
    const TARGET_RATE = 16000

    /** Shortest audio a cue may hold; below this a pause is not treated as an endpoint. */
    const MIN_CHUNK_SECONDS = 1.2

    /**
     * Hard ceiling per request; a speaker who never pauses still gets periodic cues. The
     * recognizer is request/response, so this ceiling — not a partial hypothesis — is what
     * decides how live the transcript feels during a long uninterrupted sentence.
     */
    const MAX_CHUNK_SECONDS = 5

    /** Block RMS under which the microphone hears room noise rather than speech. */
    const SILENCE_RMS = 0.012

    /** Silence that must accumulate before a cue is closed. */
    const SILENCE_HOLD_SECONDS = 0.5

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
      exportFile: '保存为文件（SRT + Markdown）',
      copySrt: '复制 SRT',
      copy: '复制全文',
      copyForFix: '复制纠错请求',
      copied: '已复制',
      saved: '已保存',
      error: '出错',
      hubTitle: '会议管理',
      hubIntro: '会议实录保存在本机；录制在会话里进行（标题栏的「会议记录」按钮 → 右侧栏面板）。',
      hubCurrent: '当前会话',
      hubNoSession: '还没有打开的会话。',
      hubSessionOpen: '会话已在前台 —— 点标题栏的「会议记录」开始录制。',
      hubSessionBackground: '当前会话不在前台 —— 切回会话后即可开始录制。',
      hubHowTo: '录制在会话作用域进行：它需要会话身份，才能让 Agent 用 meeting_read 读到这场实录。',
      hubRecords: '历史实录（本机 meetings 目录）',
      hubRefresh: '刷新',
      hubEmpty: '还没有导出的实录。录完一场并点「保存为文件」后就会出现在这里。',
      hubSend: '发送到新对话',
      hubSendHint: '新建一个对话，把这场会议的实录放进去，确认后发送',
      hubOpenSession: '打开对话',
      hubReveal: '定位文件',
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
      refresh: '刷新要点/任务',
      point_decision: '决定',
      point_point: '要点',
      point_risk: '风险',
      point_question: '待定',
      taskDraft: '待确认',
      taskConfirmed: '已确认',
      noAnalysis: '还没有要点或工作安排。点下面的按钮在本地生成。',
      pointsNoRecording: '本场还没有实录。点上方「开始记录」，也可以在下面直接写一条要点。',
      tasksNoRecording: '本场还没有实录。点上方「开始记录」，也可以在下面直接写一条工作安排。',
      tasksEmpty: '还没有工作安排。点上方「生成要点与任务」从实录提取，或直接添加；勾选表示人已确认，确认后才能推送。',
      addEntry: '添加',
      entryAdded: '已添加',
      taskTextRequired: '请先写工作安排的内容',
      originManual: '手填',
      kindGeneral: '通用',
      kindBriefing: '晨会',
      kindReview: '复盘会',
      kindWeekly: '例会',
      kindMonthly: '总结会',
      distillButtonGeneral: '提炼要点',
      distillButtonBriefing: '提炼部署',
      distillButtonReview: '盘点今日',
      distillButtonWeekly: '整理本周',
      distillButtonMonthly: '生成评分',
      distillSent: '已把提炼请求发给对话',
      meetingNameTitle: '这场会议叫什么？',
      meetingNameHint: '选一个常用名称，或自己写一个；名称会显示在面板、实录抬头与纪要里。',
      meetingNamePlaceholder: '会议名称，如「晨会 · 10月18日」',
      meetingNameSkip: '暂不命名',
      meetingNameNone: '（未命名）',
      periodNone: '（无周期）',
      panelTabScores: '评分',
      scoresPrefill: '统计预填',
      scoresExportCsv: '导出 CSV',
      scoresExportXlsx: '导出 Excel',
      scoresHint: '完成率可按本月任务统计预填；质量与学习由人打分（1–10）。勾选＝已确认。总分＝质量 40% ＋ 完成率 40% ＋ 学习 20%。',
      scoresAddPerson: '添加人员',
      scoreHours: '课时',
      scoreCompletion: '完成率 %',
      scoreQuality: '工作质量 1–10',
      scoreLearn: '学习参与 1–10',
      scoreTotal: '总分',
      scoreHighlight: '亮点',
      scoreImprove: '待改进',
      scoreBasis: '依据',
      scoresExported: '已导出',
      needPerson: '请先填写人员姓名',
      seriesPrev: '← 上一场',
      seriesNext: '下一场 →',
      carryOverHint: '昨日复盘遗留',
      carryOverAction: '据此派活',
      carryOverOpen: '看复盘会',
      pauseRecording: '暂停',
      resumeRecording: '继续',
      pausedStatus: '已暂停 · 已录',
      pauseLongHint: '仍在暂停（已超过 10 分钟）',
      carryOverPrompt: '昨天复盘会留下了 {count} 项未完成/遗留事项：\n{list}\n\n请在本次晨会实录里对照这些事项，决定今天派给谁、什么时候完成，并用 meeting_write 把结果写成本会 tasks（草稿，等人确认）。只依据实录与上面的清单，不要编造。',
      historyPlaceholder: '搜索历史会议（名称 / 日期 / 类型 / 实录关键词）',
      historyOpen: '打开会议',
      historyLoading: '正在读取…',
      historyEmpty: '没有匹配的会议',
      historyBlank: '空',
      historyChoose: '打开',
      historyViewing: '正在查看历史会议',
      historyOpenSession: '打开原会话',
      historyBack: '返回本会话',
      historyViewOnly: '查看历史会议时不可修改：请先「返回本会话」',
      historyGuardTitle: '当前会议有未保存内容',
      historyGuardBody: '3 秒后自动保存，然后打开所选会议；也可以立即保存或取消。',
      historyGuardNow: '立即保存并打开',
      meetingSetup: '会议名称与角色',
      historyAll: '已全部显示',
      historyMore: '滚动加载更多…',
      distillGeneral: '请按本场会议的类型提炼内容。先调用 meeting_read（meetingId={meetingId}）读完实录，然后：1) 用 meeting_write（meetingId={meetingId}）把决定与要点写入 points（kind 取 decision/point/risk/question）；2) 把明确的行动项写入 tasks（任务/负责人/时限/优先级，草稿，等人确认）；3) 需要存档时用 meeting_save_document 存一份 Markdown。只依据实录，不要编造；人名与术语不确定时保守处理并标注。',
      distillBriefing: '以下是本会话的晨会（名称：{title}，周期：{period}）。请先调用 meeting_read（meetingId={meetingId}）读完实录，再按晨会模板提炼：1) 昨日遗留：用 meeting_query（kind:"review", period:"yesterday", include:["tasks"]）查昨天复盘会留下的遗留事项，与实录对照后单独成段；2) 部署事项：每条写清「任务 / 负责人 / 时限 / 优先级」，区分决定（decision）与要求（point）；3) 用 meeting_write（meetingId={meetingId}）把要点写入 points、把部署写入 tasks（草稿，等人确认）。只依据实录，不要编造。写完用一句话说明提取了多少条。',
      distillReview: '以下是本会话的复盘会（名称：{title}，周期：{period}）。请先调用 meeting_read（meetingId={meetingId}）读完实录，并按顺序做：1) 用 meeting_query（kind:"briefing", period:"today", include:["tasks"]）取今天晨会的任务，每条都带 #id 与它所属的 meetingId；2) 逐项核销：用 meeting_write 写回**晨会那份记录**（meetingId 填晨会的 id，tasks 里写 {id, done:true/false, source:"实录原句"}）——这是跨会写回，不要复制任务；3) 本会的问题与风险写入 points（kind 取 risk 或 question）；4) 遗留事项写入本会 tasks（草稿），标题注明「遗留」；5) 用 meeting_save_document 存一份「复盘盘点 · {period}」。只依据实录，不要编造。',
      distillWeekly: '以下是本会话的例会（名称：{title}，周期：{period}）。请先调用 meeting_read（meetingId={meetingId}）读完实录，再做两件事：1) 学习部分：主题、核心论点、体会启发、下一步实践，写入 points；2) 本周汇总：用 meeting_query（kind:"briefing" 与 kind:"review"，period:"this-week"，include:["tasks"]）取本周的晨会与复盘会，输出「完成事项 / 未完成事项 / 风险与问题」三份清单，每条注明来自哪场会议；最后用 meeting_save_document 存一份「本周纪要 · {period}」。只依据实录与查询结果。',
      distillMonthly: '以下是本会话的总结会（名称：{title}，周期：{period}）。请先调用 meeting_read（meetingId={meetingId}）读完实录，再做：1) 用 meeting_query（period:"this-month", include:["tasks","points"]）取本月全部会议与任务，按人汇总完成情况；2) 结合本会实录逐人整理：课时/工作量、完成情况、亮点、待改进，每条给出依据（会议 id + 实录原句）；3) 用 meeting_write（meetingId={meetingId}）把每人一行写进 scores（person/hours/completion/quality/learn/highlight/improve/basis，全部落为草稿，等人确认改分）；4) 再用 meeting_save_document 存一份「月度评分 · {period}」草稿表（Markdown 表格，含依据列）。评分依据必须来自实录与查询结果，不要凭空打分；面板「评分」页签可用「统计预填」补齐完成率。',
      generate: '生成要点与任务（本地）',
      extractEmpty: '没有识别出明显的要点或行动项。可在会话里直接对 Agent 说「读一下这场会议，给我要点和行动项」来精修。',
      noMeeting: '这个会话还没有会议记录。点「开始记录」录一场，再来生成要点与任务。',
      seekHint: '点击跳到这一句',
      agentDone: '已更新',
      follow: '跟随播放',
      hubNoText: '这段录音没有对应的文字实录。',
      segments: '句',
      remove: '删除',
      ownerPh: '负责人',
      duePh: '时间',
      originRule: '规则',
      originAgent: 'AI',
      ink: '手写笔记',
      inkHint: '用笔或鼠标在下面书写；Windows 触屏笔的橡皮端会被识别为橡皮。',
      inkPen: '笔',
      inkErase: '橡皮',
      inkUndo: '撤销',
      inkClear: '清空',
      inkSave: '保存为笔记',
      inkSaved: '笔记已保存',
      inkClose: '收起手写板',
      inkRecognize: '发送到对话（较慢）',
      inkLocal: '识别为文字',
      inkLocalEmpty: '没有识别出文字，写大一点再试',
      inkLasso: '圈选',
      clearEntry: '清除',
      inkLassoHint: '轻点一个字即可选中；长按画布可直接开始圈选',
      inkSelection: '识别选中',
      inkToTask: '转为任务',
      inkToTaskDone: '已转为待确认任务',
      needSession: '这需要一个会话：请先在某个对话里打开会议记录面板',
      roleLabel: '我的角色',
      speakingNow: '正在说',
      roleHost: '主持人',
      roleAttendee: '参会人',
      roleObserver: '旁听',
      roleHint: '复盘时会按这个角色组织内容',
      review: '复盘会议',
      push: '同步任务',
      pushDone: '已推送到机器人',
      robotSettings: '机器人设置',
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
      hubTabTerms: '会议术语',
      hubTabSettings: '机器人设置',
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
      revise: '二次纠错',
      revisePrompt: '本场会议已经结束。请先调用 meeting_read 读取这场会议的完整实录（每段都带 #编号），再以会议上下文为依据做一次统一订正：同一个人名/公司名/术语前后一致；明显听错的同音词改成正确写法；明显的错字修正。然后用 meeting_revise 提交订正，corrections 每一项写 {id, text}——id 用实录里的 #编号，text 给该段订正后的完整文本。只订正上下文能支撑的地方，不要编造内容，拿不准的保持原样。完成后用一段话说明改了哪些地方。',
      reviseSending: '已请 Agent 做会终二次纠错，完成后实录会自动更新',
      minutesDone: '纪要已写入导出目录',
      minutesEmpty: '这场会议还没有内容可以成文',
      inkSystem: '系统手写输入',
      inkStore: '存为笔记',
      inkSystemHint: '此功能依赖 Windows 自带的手写面板，先在系统里开启：\n① 设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「手写」\n② 设置 → 蓝牙和设备 → 触摸键盘 → 打开「未连接键盘时显示触摸键盘」\n③ 设置 → 蓝牙和设备 → 笔和 Windows Ink → 手写 → 打开识别\n开启后点下面的按钮重试；本环境是 Electron，也可能仍然唤不出，那就直接在此输入。',
      inkSystemOpen: '唤起系统手写面板',
      tabInk: '手写板',
      tabSystem: '系统手写',
      tabTerms: '会议术语',
      notesToggle: '笔记',
      helpToggle: '使用说明',
      helpBody: '【手写板】\n· 「笔」「橡皮」「撤销」「清空」是书写工具。\n· 淡蓝色虚线框是自动发现的一个个字：轻点某个字就能选中它，不必画圈。\n· 长按画布约 0.6 秒可直接开始圈选，继续拖动即可圈住一片内容。\n· 选中或识别出文字后，下方出现同一排动作：「识别选中」只读圈住的字；「转为任务」把文字直接建成待确认任务；「清除」清空选择与识别结果。\n· 「识别为文字」按行识别整页：本地模型、离线、约 43 毫秒一行，多行会自动分行，识别完下方直接给出「转为任务」。\n· 「保存为图片」把整页存成 PNG 进会议记录。\n· 「发送到对话」交给 Agent 识别，较慢且需要登录。\n\n【系统手写】\n· 用 Windows 自带手写面板输入文字，再点「存为笔记」。\n· 需要系统先开启手写功能：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「手写」。\n· 本环境是 Electron，可能唤不出系统面板；那就直接在这个输入框里打字。\n\n【会议术语】\n· 每行一条。写成「错词=正确词」可在转写里自动替换；只写词则作为热词。\n· 内容会自动保存到本场会议。\n\n【没有开始录音也能用】\n· 写笔记、识别、转任务都不需要先点「开始记录」；第一次写入时会自动建一条会议记录，之后录音会并入同一条。',
      inkRecognizing: '已请求识别，Agent 完成后会显示',
      inkRecognizeFailed: '识别请求失败',
      inkNote: '笔记文字',
      documents: '会议文档',
      openDocument: '查看',
      inkPrompt: '这是一张会议手写笔记的图片。请识别其中的文字，然后用 meeting_note_write 把识别结果写回本场会议（作为草稿）。字迹不清的部分请如实标注，不要猜测。',
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
      speechAutoStart: '语音识别准备就绪后将自动开始录音',
      speechCancel: '取消',
      prepareInPanel: '下载本地模型',
      preparingInPanel: '正在准备…',
      preparedInPanel: '模型已就绪',
    }

    const en = {
      title: 'Meeting notes',
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
      exportFile: 'Save files (SRT + Markdown)',
      copySrt: 'Copy SRT',
      copy: 'Copy transcript',
      copyForFix: 'Copy correction request',
      copied: 'Copied',
      saved: 'Saved',
      error: 'Error',
      hubTitle: 'Meeting management',
      hubIntro: 'Records stay on this machine; recording happens inside a session (the "Meeting notes" button in the session header opens the sidebar panel).',
      hubCurrent: 'Current session',
      hubNoSession: 'No session is open.',
      hubSessionOpen: 'The session is in the foreground — open the header button to start recording.',
      hubSessionBackground: 'The session is in the background — switch back to it to start recording.',
      hubHowTo: 'Recording runs in the session scope: the session identity is what lets the agent read this meeting through meeting_read.',
      hubRecords: 'Past records (this machine\'s meetings directory)',
      hubRefresh: 'Refresh',
      hubEmpty: 'No record has been exported yet. Finish a meeting and choose "Save files" to see it here.',
      hubSend: 'Send to new chat',
      hubSendHint: 'Open a new conversation with this meeting\'s transcript, ready to send',
      hubOpenSession: 'Open chat',
      hubReveal: 'Show file',
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
      refresh: 'Refresh points and tasks',
      point_decision: 'Decision',
      point_point: 'Point',
      point_risk: 'Risk',
      point_question: 'Open question',
      taskDraft: 'Draft',
      taskConfirmed: 'Confirmed',
      noAnalysis: 'No points or assignments yet. Use the button below to extract them locally.',
      pointsNoRecording: 'This meeting has no recording yet. Press Start above, or write a point below.',
      tasksNoRecording: 'This meeting has no recording yet. Press Start above, or write an assignment below.',
      tasksEmpty: 'No assignments yet. Extract them from the recording, or add one below; the checkbox is the human confirmation that pushing requires.',
      addEntry: 'Add',
      entryAdded: 'Added',
      taskTextRequired: 'Write the assignment first',
      originManual: 'written',
      kindGeneral: 'General',
      kindBriefing: 'Morning briefing',
      kindReview: 'Daily review',
      kindWeekly: 'Weekly meeting',
      kindMonthly: 'Monthly review',
      distillButtonGeneral: 'Distill',
      distillButtonBriefing: 'Distill assignments',
      distillButtonReview: 'Review today',
      distillButtonWeekly: 'Summarize the week',
      distillButtonMonthly: 'Draft scores',
      distillSent: 'Distill request sent to the conversation',
      meetingNameTitle: 'Name this meeting',
      meetingNameHint: 'Pick a common name or type your own; it shows in the panel, the transcript header and the minutes.',
      meetingNamePlaceholder: 'Meeting name, e.g. "Briefing · Oct 18"',
      meetingNameSkip: 'Skip naming',
      meetingNameNone: '(unnamed)',
      periodNone: '(no period)',
      panelTabScores: 'Scores',
      scoresPrefill: 'Pre-fill completion',
      scoresExportCsv: 'Export CSV',
      scoresExportXlsx: 'Export Excel',
      scoresHint: 'Completion can be pre-filled from this period\'s tasks; quality and learning are scored by a person (1–10). Checked = confirmed. Total = quality 40% + completion 40% + learning 20%.',
      scoresAddPerson: 'Add a person',
      scoreHours: 'Hours',
      scoreCompletion: 'Completion %',
      scoreQuality: 'Quality 1–10',
      scoreLearn: 'Learning 1–10',
      scoreTotal: 'Total',
      scoreHighlight: 'Highlight',
      scoreImprove: 'To improve',
      scoreBasis: 'Evidence',
      scoresExported: 'Exported',
      needPerson: 'Write the person\'s name first',
      seriesPrev: '← Previous',
      seriesNext: 'Next →',
      carryOverHint: 'Left open by yesterday\'s review:',
      carryOverAction: 'Assign these',
      carryOverOpen: 'Open the review',
      pauseRecording: 'Pause',
      resumeRecording: 'Resume',
      pausedStatus: 'Paused · recorded',
      pauseLongHint: 'Still paused (over 10 minutes)',
      carryOverPrompt: 'Yesterday\'s review left {count} item(s) unfinished or carried over:\n{list}\n\nCheck them against this briefing\'s transcript, decide who takes each one and by when, then write the result into this meeting\'s tasks with meeting_write (drafts a human confirms). Use only the transcript and the list above; do not invent anything.',
      historyPlaceholder: 'Search meetings (name / date / type / transcript)',
      historyOpen: 'Open meeting',
      historyLoading: 'Loading…',
      historyEmpty: 'No meeting matches',
      historyBlank: 'empty',
      historyChoose: 'Open',
      historyViewing: 'Viewing a past meeting',
      historyOpenSession: 'Open its conversation',
      historyBack: 'Back to this session',
      historyViewOnly: 'Read-only while viewing a past meeting — go back to this session to edit',
      historyGuardTitle: 'This meeting has unsaved content',
      historyGuardBody: 'It is saved automatically in 3 seconds, then the chosen meeting opens; you can also save now or cancel.',
      historyGuardNow: 'Save and open now',
      meetingSetup: 'Meeting name & role',
      historyAll: 'All shown',
      historyMore: 'Scroll for more…',
      distillGeneral: 'Distill this meeting according to its type. First call meeting_read (meetingId={meetingId}) for the full transcript, then: 1) write decisions and points with meeting_write (meetingId={meetingId}), kind being decision/point/risk/question; 2) write clear action items as tasks (title/owner/due/priority — drafts that a human confirms); 3) store a Markdown document with meeting_save_document when it should be archived. Use only the transcript; never invent content and mark anything uncertain.',
      distillBriefing: 'This session is a morning briefing (name: {title}, period: {period}). Call meeting_read (meetingId={meetingId}) for the transcript, then: 1) carry-over — call meeting_query (kind:"review", period:"yesterday", include:["tasks"]) for what yesterday\'s review left open, checked against the transcript and listed separately; 2) assignments, each with task / owner / due / priority, separating decisions from requests; 3) write points and tasks back with meeting_write (meetingId={meetingId}); tasks stay drafts. Use only the transcript and finish with one line saying how many entries you extracted.',
      distillReview: 'This session is a daily review (name: {title}, period: {period}). Call meeting_read (meetingId={meetingId}) for the transcript, then work in order: 1) meeting_query (kind:"briefing", period:"today", include:["tasks"]) for today\'s briefing tasks, each carrying its #id and the meetingId that owns it; 2) check them off by writing back to the BRIEFING record with meeting_write — that briefing\'s meetingId, tasks entries {id, done:true|false, source:"transcript words"}; never copy tasks between meetings; 3) this meeting\'s problems and risks go to points (kind risk or question); 4) carry-over items go to this meeting\'s tasks, marked "carry-over"; 5) save a "Review · {period}" document with meeting_save_document. Use only the transcript.',
      distillWeekly: 'This session is the weekly meeting (name: {title}, period: {period}). Call meeting_read (meetingId={meetingId}) for the transcript, then: 1) the learning part — topics, main arguments, takeaways, next practice — as points; 2) the week — meeting_query (kind:"briefing" and kind:"review", period:"this-week", include:["tasks"]) for this week\'s meetings, then three lists: finished / unfinished / risks and problems, each entry naming the meeting it came from; 3) save a "Week · {period}" document with meeting_save_document. Use only the transcript and the query results.',
      distillMonthly: 'This session is the monthly review (name: {title}, period: {period}). Call meeting_read (meetingId={meetingId}) for the transcript, then: 1) meeting_query (period:"this-month", include:["tasks","points"]) for the month\'s meetings and tasks, summarised per person; 2) go person by person — hours/workload, completion, highlights, improvements — each with evidence (meeting id + transcript words); 3) write one row per person into meeting_write\'s scores (person/hours/completion/quality/learn/highlight/improve/basis — every row lands as a draft a human then confirms); 4) also save a "Monthly scores · {period}" draft table (Markdown, with an evidence column) through meeting_save_document. Scores must be grounded in the transcript and the query results; the panel\'s Scores tab can pre-fill completion rates.',
      generate: 'Extract points and tasks (local)',
      extractEmpty: 'No obvious points or assignments were found. Ask the agent in the conversation to refine, e.g. "read this meeting and give me the key points and action items".',
      noMeeting: 'This session has no meeting yet. Start a recording first, then extract the points and tasks.',
      seekHint: 'Click to jump to this cue',
      agentDone: 'Updated',
      follow: 'Follow playback',
      hubNoText: 'This recording has no matching transcript.',
      segments: 'cues',
      remove: 'Delete',
      ownerPh: 'Owner',
      duePh: 'Due',
      originRule: 'Rule',
      originAgent: 'AI',
      ink: 'Handwritten note',
      inkHint: 'Write below with the pen or the mouse; the Windows pen eraser end is read as an eraser.',
      inkPen: 'Pen',
      inkErase: 'Eraser',
      inkUndo: 'Undo',
      inkClear: 'Clear',
      inkSave: 'Save as note',
      inkSaved: 'Note saved',
      inkClose: 'Hide the pad',
      inkRecognize: 'Send to the conversation (slow)',
      inkLocal: 'Recognize as text',
      inkLocalEmpty: 'Nothing was recognized; write larger and retry',
      inkLasso: 'Lasso',
      clearEntry: 'Clear',
      inkLassoHint: 'Tap a character to select it; long-press the pad to start a lasso',
      inkSelection: 'Recognize selection',
      inkToTask: 'To task',
      inkToTaskDone: 'Added as a draft task',
      needSession: 'This needs a session: open the meeting panel from a conversation first',
      roleLabel: 'My role',
      speakingNow: 'speaking',
      roleHost: 'Host',
      roleAttendee: 'Attendee',
      roleObserver: 'Observer',
      roleHint: 'Reviews are organised around this role',
      review: 'Review the meeting',
      push: 'Push tasks',
      pushDone: 'Pushed to the group robot',
      robotSettings: 'Robot settings',
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
      hubTabTerms: 'Terms',
      hubTabSettings: 'Robot settings',
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
      revise: 'Second-pass correction',
      revisePrompt: 'This meeting has finished. First call meeting_read to read the full transcript (each cue carries a #id), then make one consistent correction pass using the meeting context: the same person, company and terminology written the same way; words clearly misheard as homophones fixed; obvious misrecognitions repaired. Then submit the corrections with meeting_revise, where each entry is {id, text} — the id from the transcript and the full corrected text for that cue. Correct only what the context supports, never invent content, and leave anything uncertain as it is. Finish with a short note saying what you changed.',
      reviseSending: 'The agent is making the second correction pass; the transcript updates when it finishes',
      minutesDone: 'Minutes written to the export directory',
      minutesEmpty: 'This meeting has nothing to write up yet',
      inkSystem: 'System handwriting input',
      inkStore: 'Store as note',
      inkSystemHint: 'This needs the Windows handwriting panel; enable it first:\n1) Settings → Time & language → Language & region → Chinese → Language options → install "Handwriting"\n2) Settings → Bluetooth & devices → Touch keyboard → show it when no keyboard is attached\n3) Settings → Bluetooth & devices → Pen & Windows Ink → Handwriting → turn recognition on\nThen retry below. Electron may still refuse to show it, in which case type here.',
      tabInk: 'Pad',
      tabSystem: 'System input',
      tabTerms: 'Terms',
      notesToggle: 'Notes',
      helpToggle: 'Help',
      helpBody: '【Handwriting pad】\n· Pen, eraser, undo and clear are the drawing tools.\n· Faint dashed boxes are characters found from the ink alone: tap one to select it, no lasso needed.\n· Long-press the pad for about 0.6 s to start a lasso, then drag to circle an area.\n· A selection or a recognized result shows one action row: "Recognize selection" reads only the circled characters, "To task" turns the text straight into a draft task, and "Clear" empties both.\n· "Recognize as text" reads the page line by line locally, offline, about 43 ms per line, splitting lines automatically, and offers "To task" right below.\n· "Save as image" stores the page as a PNG in the meeting record.\n· "Send to the conversation" asks the agent instead; it is slower and needs a signed-in session.\n\n【System handwriting】\n· Type with the Windows handwriting panel, then store it as a note.\n· Windows must have handwriting installed: Settings → Time & language → Language & region → Chinese (Simplified) → Language options → install Handwriting.\n· This Electron shell may not summon the system panel; the text box here always works.\n\n【Meeting terms】\n· One entry per line. Write "wrong=right" to replace it in transcripts; a bare word is a hint.\n· Entries save automatically.\n\n【Works without recording】\n· Notes, recognition and tasks need no recording; the first write creates the meeting record, and a later recording joins it.',
      inkRecognizing: 'Recognition requested; the result appears when the agent finishes',
      inkRecognizeFailed: 'Recognition request failed',
      inkNote: 'Note text',
      documents: 'Meeting documents',
      openDocument: 'Open',
      inkPrompt: 'This image is a handwritten meeting note. Read the text in it, then call meeting_note_write to store the result on this meeting as a draft. Mark anything illegible honestly instead of guessing.',
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
      speechAutoStart: 'Recording starts automatically once speech recognition is ready',
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
      hub: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '860px' },
      hubTitle: { margin: 0, fontSize: '18px', fontWeight: 600 },
      hubCard: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)' },
      hubList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflowY: 'auto' },
      hubRow: { display: 'flex', alignItems: 'baseline', gap: '10px', justifyContent: 'space-between' },
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
        zIndex: 20,
        minWidth: '168px',
        display: 'flex',
        flexDirection: 'column',
        padding: '4px',
        gap: '2px',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
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
        zIndex: 20,
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
      setupOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
      setupCard: { position: 'relative', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', padding: '18px 20px', maxWidth: '460px', width: 'calc(100% - 40px)', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
      setupTitle: { margin: 0, fontSize: '16px', fontWeight: 600 },
      setupFeature: { fontSize: '13px', lineHeight: 1.6 },
      setupFoot: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      setupClose: { position: 'absolute', top: '8px', right: '12px', border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: '4px' },
    }

    /**
     * The plugin's one control stylesheet. Every button, field, picker and tab renders a
     * raw element (behaviour and per-site widths stay exactly as they were) but takes its
     * surface, border, radius and interactive states from these classes, so the whole plugin
     * looks like one product instead of a dozen inline variants. Colours are theme tokens,
     * which is also what makes light and dark both correct.
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
.mr-btn--active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
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
     * One button. The caller's props and handlers pass straight through; the look comes from
     * `.mr-*`, and a style object the map does not know (a width, a flex) is still honoured.
     * @param props - usual button props, plus `variant` to force one.
     * @returns the button element.
     */
    function Btn(props) {
      const { style, variant, ...rest } = props
      const resolved = variant ?? BTN_VARIANT.get(style) ?? 'default'
      const extra = style !== undefined && !BTN_VARIANT.has(style) ? style : undefined
      return h('button', { ...rest, className: `mr-btn mr-btn--${resolved}`, style: extra })
    }

    /**
     * One text field (or textarea when the variant says so).
     * @param props - usual input props, plus `variant` to force one.
     * @returns the field element.
     */
    function Field(props) {
      const { style, variant, ...rest } = props
      // A checkbox is a control but not a *field*: it keeps its own shape.
      if (rest.type === 'checkbox' || rest.type === 'radio' || rest.type === 'file' || rest.type === 'range') {
        return h('input', { ...rest, style })
      }
      const resolved = variant ?? FIELD_VARIANT.get(style) ?? 'wide'
      const extra = style !== undefined && !FIELD_VARIANT.has(style) ? style : undefined
      return h(resolved === 'area' ? 'textarea' : 'input', { ...rest, className: `mr-field mr-field--${resolved}`, style: extra })
    }

    /**
     * One select, styled as a field so rows of controls line up.
     * @param props - usual select props, plus `variant` to force one.
     * @returns the select element.
     */
    function Picker(props) {
      const { style, variant, ...rest } = props
      const resolved = variant ?? FIELD_VARIANT.get(style) ?? 'tight'
      const extra = style !== undefined && !FIELD_VARIANT.has(style) ? style : undefined
      return h('select', { ...rest, className: `mr-picker mr-picker--${resolved}`, style: extra })
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
      if (active.frames >= rate * MAX_CHUNK_SECONDS) return true
      return active.frames >= rate * MIN_CHUNK_SECONDS && active.silenceFrames >= rate * SILENCE_HOLD_SECONDS
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
     * Render an absolute local timestamp.
     * @param at - Epoch milliseconds.
     * @returns `YYYY-MM-DD HH:MM:SS` in local time.
     */
    function absoluteOf(at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      return `${day} ${time}`
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
     * Render the transcript as a readable Markdown document.
     * @param segments - Timed transcript segments.
     * @param startedAt - Meeting start in epoch milliseconds.
     * @param terms - Meeting terminology to record alongside the transcript.
     * @returns the Markdown document.
     */
    function markdownOf(segments, startedAt, terms, points = [], tasks = []) {
      const end = segments.length === 0 ? 0 : segments[segments.length - 1].end
      const lines = [
        '# 会议实录',
        '',
        `- 开始时间：${absoluteOf(startedAt)}`,
        `- 时长：${clock(end)}`,
        `- 段落数：${segments.length}`,
        '',
      ]
      if (terms.length > 0) {
        lines.push('## 术语表', '')
        for (const term of terms) lines.push(`- ${term}`)
        lines.push('')
      }
      if (points.length > 0) {
        lines.push('## 要点', '')
        for (const point of points) lines.push(`- **${point.kind}**　${point.text}`)
        lines.push('')
      }
      if (tasks.length > 0) {
        lines.push('## 工作安排', '')
        for (const task of tasks) {
          const owner = task.owner === '' ? '未定负责人' : task.owner
          const due = task.due === '' ? '未定时间' : task.due
          // The checkbox mirrors the human confirmation state, not the extractor's guess.
          lines.push(`- [${task.status === 'confirmed' ? 'x' : ' '}] ${task.title}　—　${owner}　·　${due}　·　${task.priority}　·　${task.status}`)
        }
        lines.push('')
      }
      lines.push('## 逐句记录', '')
      // Every line carries its own wall-clock time, so a record read out of context
      // still says when it was said; the SRT keeps relative timecodes as the format requires.
      for (const segment of segments) {
        lines.push(`- **${absoluteOf(startedAt + segment.start * 1000)}**　${speakerPrefixOf(segment)}${seenOf(segment)}`)
      }
      lines.push('')
      return lines.join('\n')
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
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `请求失败 (${response.status})`)
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
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `请求失败 (${response.status})`)
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
    /** One distill prompt and one button label per kind (FEATURES.md §3). */
    const DISTILL_KEYS = { '': 'distillGeneral', briefing: 'distillBriefing', review: 'distillReview', weekly: 'distillWeekly', monthly: 'distillMonthly' }
    const DISTILL_BUTTON_KEYS = { '': 'distillButtonGeneral', briefing: 'distillButtonBriefing', review: 'distillButtonReview', weekly: 'distillButtonWeekly', monthly: 'distillButtonMonthly' }

    /** Id of the datalist that offers this meeting's speaker names as owners. */
    const OWNER_LIST_ID = 'meeting-room-owners'

    /** Delivery choices for confirmed assignments, and their locale keys. */
    const PUSH_MODE_VALUES = ['group', 'work', 'both']
    const PUSH_MODE_KEYS = { group: 'pushModeGroup', work: 'pushModeWork', both: 'pushModeBoth' }

    /** Hub sections, in the order a user meets them. */
    const HUB_TAB_VALUES = ['records', 'terms', 'settings', 'people']
    const HUB_TAB_KEYS = { records: 'hubTabRecords', terms: 'hubTabTerms', settings: 'hubTabSettings', people: 'hubTabPeople' }

    /** Panel body sections: the record first, then what was read out of it. */
    const BODY_TAB_VALUES = ['transcript', 'points', 'tasks', 'names']
    const BODY_TAB_KEYS = { transcript: 'panelTabTranscript', points: 'points', tasks: 'tasks', names: 'panelTabSpeakers' }

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
      const [speech, setSpeech] = React.useState({ ready: true, phase: 'checking', requesting: false, completedBytes: 0, totalBytes: 0 })
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
          for (;;) {
            const s = await readSpeechState()
            // Stay busy-looking until the server actually reports the model ready, so the
            // panel shows progress instead of a false "download started" one-liner.
            setSpeech({ ready: s.ready, phase: s.phase, requesting: s.busy === true || s.ready !== true, completedBytes: s.completedBytes, totalBytes: s.totalBytes })
            if (s.ready) return
            if (s.phase === 'failed') {
              setPendingStart(false)
              setSpeech({ ready: false, phase: 'failed', requesting: false, completedBytes: 0, totalBytes: 0 })
              setError(typeof s.message === 'string' && s.message !== '' ? s.message : t('setupPrepareFailed'))
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
          setError(e instanceof Error ? e.message : String(e))
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
      /** Tasks whose row is showing the free date-and-time picker rather than a quick choice. */
      const [customDueIds, setCustomDueIds] = React.useState([])
      /** Voice labels found in this meeting and the real names assigned to them. */
      const [labels, setLabels] = React.useState([])
      const [speakers, setSpeakers] = React.useState({})
      /** The monthly review's score table (FEATURES.md §5.1). */
      const [scores, setScores] = React.useState([])
      /** The person being added to that table by hand. */
      const [newScorePerson, setNewScorePerson] = React.useState('')
      const [draftNames, setDraftNames] = React.useState({})
      const [playhead, setPlayhead] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      /** The meeting's name, type and derived period (FEATURES.md §2.1). */
      const [meta, setMeta] = React.useState({ kind: '', period: '', title: '' })
      /** The start-of-recording name dialog; null when it is closed (§5.5). */
      const [namePrompt, setNamePrompt] = React.useState(null)
      /** The same kind's neighbouring meetings, for series navigation (FEATURES.md §5.1). */
      const [series, setSeries] = React.useState({ prev: null, next: null })
      /** What the previous day's review left open, shown while a briefing is prepared (§3.1). */
      const [carry, setCarry] = React.useState({ review: null, items: [] })
      /** Whether capture is paused, and since when (FEATURES.md §5.6). */
      const [paused, setPaused] = React.useState(false)
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
      /** The switch guard: the row to open once the countdown saved the current meeting. */
      const [switchPrompt, setSwitchPrompt] = React.useState(null)
      const audio = React.useRef(null)
      const rows = React.useRef([])
      const noteSeq = React.useRef(0)
      const [tab, setTab] = React.useState('ink')
      const [notesOpen, setNotesOpen] = React.useState(false)
      const [helpOpen, setHelpOpen] = React.useState(false)
      const [systemText, setSystemText] = React.useState('')
      const systemField = React.useRef(null)

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
          setMeta({
            kind: typeof value.meeting.kind === 'string' ? value.meeting.kind : '',
            period: typeof value.meeting.period === 'string' ? value.meeting.period : '',
            title: typeof value.meeting.title === 'string' ? value.meeting.title : '',
          })
          return value.meeting
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        }
      }, [sessionId])

      React.useEffect(() => { void adopt() }, [adopt])

      // Series navigation and the carry-over reminder follow the meeting's identity and
      // type, so they reload whenever either changes (FEATURES.md §3.1, §5.1).
      React.useEffect(() => {
        if (meetingId === '') {
          setSeries({ prev: null, next: null })
          setCarry({ review: null, items: [] })
          return undefined
        }
        let live = true
        void (async () => {
          try {
            const value = await get(`/series?meetingId=${encodeURIComponent(meetingId)}`)
            if (live) setSeries({ prev: value.prev ?? null, next: value.next ?? null })
          } catch {
            // Navigation is an extra: a failure simply leaves the buttons hidden.
          }
          if (meta.kind !== 'briefing') {
            if (live) setCarry({ review: null, items: [] })
            return
          }
          try {
            const value = await get(`/carryover?meetingId=${encodeURIComponent(meetingId)}`)
            if (live) setCarry({ review: value.review ?? null, items: Array.isArray(value.items) ? value.items : [] })
          } catch {
            // Same: the reminder is optional.
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
        const id = await ensureMeeting()
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
          setMeta({
            kind: typeof reply.kind === 'string' ? reply.kind : '',
            period: typeof reply.period === 'string' ? reply.period : '',
            title: typeof reply.title === 'string' ? reply.title : '',
          })
          return true
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return false
        }
      }, [ensureMeeting, t])

      /**
       * Ask the agent to distill this meeting with the template its kind calls for
       * (FEATURES.md §3): the button injects the template as a normal message, so the
       * agent reads the transcript and writes the result back through its tools.
       */
      const distill = React.useCallback(async () => {
        setError('')
        if (sessionId === '') {
          setError(t('needSession'))
          return
        }
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        const prompt = t(DISTILL_KEYS[meta.kind] ?? 'distillGeneral')
          .replace('{meetingId}', id)
          .replace('{title}', meta.title === '' ? t('meetingNameNone') : meta.title)
          .replace('{period}', meta.period === '' ? t('periodNone') : meta.period)
        setNote(t('distillSent'))
        const asked = await props.askText(sessionId, prompt)
        if (asked.ok !== true) setError(`${t('reviewNoSession')}: ${asked.error}`)
      }, [ensureMeeting, meta.kind, meta.period, meta.title, props, sessionId, t])

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
            .replaceAll('{role}', t(ROLE_LABEL_KEYS[seat]))
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

      /** Ask the agent for a context-aware correction pass over the finished transcript. */
      const revise = React.useCallback(async () => {
        setError('')
        setNote('')
        if (sessionId === '') {
          setError(t('reviewNoSession'))
          return
        }
        const asked = await props.askText(sessionId, t('revisePrompt'))
        if (!asked.ok) {
          setError(`${t('reviewNoSession')}: ${asked.error}`)
          return
        }
        setNote(t('reviseSending'))
      }, [props, sessionId, t])

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
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /** Send the confirmed assignments to the configured group robots. Nothing leaves this
       * machine until the user both confirms a task and presses this.
       */
      const push = React.useCallback(async () => {
        setError('')
        setNote('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/push', { meetingId: id })
          const lines = reply.results.map((entry) => `${entry.kind}: ${entry.ok ? t('pushDone') : entry.message}`)
          setNote(lines.join('；'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /** Load the shared roster once, to suggest owners in task editing. */
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

      /**
       * Add or update one person on the meeting's roster. The mobile number is what a group
       * robot mentions; the DingTalk user id is what a private work notification addresses.
       * @param draft - The person to store.
       * @param action - 'save' adds or updates, 'remove' deletes by name.
       */
      /** Write the meeting up as a minutes document the user can keep or send on. */
      const writeMinutes = React.useCallback(async (format = 'md') => {
        setError('')
        setNote('')
        const id = await ensureMeeting()
        if (id === '') {
          setError(t('needSession'))
          return
        }
        try {
          const reply = await post('/minutes', { meetingId: id, format })
          setNote(`${format === 'docx' ? t('minutesDocxDone') : t('minutesDone')}: ${reply.name}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

      /**
       * Derive draft points and tasks locally — no model, no login. The agent can refine
       * them later through the conversation; until then this path always works.
       */
      const extract = React.useCallback(async () => {
        setError('')
        setNote('')
        let id = meetingId
        if (id === '') {
          const adopted = await adopt()
          if (adopted === null) {
            setNote(t('noMeeting'))
            return
          }
          id = adopted.meetingId
        }
        try {
          const reply = await post('/extract', { meetingId: id })
          setPoints(reply.points)
          setTasks(reply.tasks)
          setNote(reply.points.length + reply.tasks.length === 0 ? t('extractEmpty') : t('agentDone'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [adopt, meetingId, t])

      /**
       * Confirm, edit, or remove one stored entry. Only a human reaches this path, which
       * is what keeps an unconfirmed draft from becoming somebody else's todo.
       * @param kind - 'point' or 'task'.
       * @param id - Entry id from the stored list.
       * @param patch - Fields to change; empty when removing.
       * @param op - 'remove' deletes the entry.
       */
      const editEntry = React.useCallback(async (kind, id, patch = {}, op = 'update') => {
        // Writes belong to the session's own meeting; a viewed history stays read-only (§5.4).
        if (viewedRef.current !== null) {
          setNote(t('historyViewOnly'))
          return
        }
        setError('')
        // Confirm, edit or delete before recording even started: the meeting is created on
        // demand, so an edit is never silently dropped for a missing id.
        const target = await ensureMeeting()
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

      /** Open the original conversation of a neighbouring meeting in this series. */
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
      React.useEffect(() => {
        if (!moreOpen) return undefined
        const close = () => setMoreOpen(false)
        const onKey = (event) => { if (event.key === 'Escape') setMoreOpen(false) }
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
        }
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
        if (composingRef.current) return
        window.clearTimeout(searchTimer.current)
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

      // The picker is a dropdown as well: an outside click or Escape closes it.
      React.useEffect(() => {
        if (picker.open !== true) return undefined
        const close = () => setPicker((value) => ({ ...value, open: false }))
        const onKey = (event) => { if (event.key === 'Escape') setPicker((value) => ({ ...value, open: false })) }
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
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
          setSpeakers(value.speakers !== null && typeof value.speakers === 'object' ? value.speakers : {})
          setMeta({
            kind: typeof value.kind === 'string' ? value.kind : '',
            period: typeof value.period === 'string' ? value.period : '',
            title: typeof value.title === 'string' ? value.title : row.title,
          })
          setPlayhead(0)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

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
       * Ask the agent to read a drawing and store the text. The image travels as a prompt
       * attachment because only user messages may carry images in this build.
       * @param pngBase64 - The drawing as base64 PNG bytes.
       */
      const recognize = React.useCallback(async (pngBase64) => {
        setError('')
        setNote('')
        if (sessionId === '') {
          setError(t('inkRecognizeFailed'))
          return
        }
        const asked = await props.askNote(sessionId, t('inkPrompt'), pngBase64)
        if (!asked.ok) {
          setError(`${t('inkRecognizeFailed')}: ${asked.error}`)
          return
        }
        setNote(t('inkRecognizing'))
      }, [props, sessionId, t])

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
       * Store text recognised by the system handwriting panel or typed here. This path
       * never reaches the agent, so it is the fast one.
       * @param text - The note text.
       */
      const saveText = React.useCallback(async (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return
        setError('')
        try {
          const target = await ensureMeeting()
          if (target === '') {
            setError(t('needSession'))
            return
          }
          const reply = await post('/note', { text: trimmed, meetingId: target, source: 'system' })
          if (Array.isArray(reply.notes)) setNotes(reply.notes)
          // Typed or system-panel text can become an assignment the same way a recognized
          // drawing can.
          setLastNote(trimmed)
          setNote(t('inkSaved'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [ensureMeeting, t])

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

      /** Release capture resources held by the current meeting. */
      const release = React.useCallback(async () => {
        const active = recorder.active
        if (active === null) return
        recorder.active = null
        try {
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
          const created = await post('/start', { sessionId, terms: termsText })
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
            // Endpoint at a pause instead of a fixed clock: a cue then holds what a
            // speaker actually said, rather than being cut mid-sentence. The cap keeps
            // a long monologue from growing without bound.
            if (blockRms(block) < SILENCE_RMS) active.silenceFrames += block.length
            else active.silenceFrames = 0
            if (!active.inflight && shouldFlush(active)) void flush(active)
          }
          setPaused(false)
          pausedAt.current = 0
          pauseWarned.current = false
          setSegments([])
          setSeconds(0)
          setMeetingId(created.meetingId)
          setStartedAt(created.startedAt ?? Date.now())
          setAudioName(typeof created.audioName === 'string' ? created.audioName : '')
          setPhase('recording')
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

      /** Stop capture, drain the remaining audio, then finalize the meeting. */
      const stop = React.useCallback(async () => {
        const active = recorder.active
        if (active === null) return
        active.stopping = true
        setPhase('transcribing')
        for (let attempt = 0; attempt < 120 && (active.inflight || active.pending.length > 0); attempt++) {
          if (active.inflight) await new Promise((resolve) => setTimeout(resolve, 200))
          else await flush(active)
        }
        await release()
        try {
          const reply = await post('/stop', { meetingId: active.meetingId })
          setSegments(reply.segments)
          setSeconds(reply.seconds)
          if (typeof reply.audioName === 'string') setAudioName(reply.audioName)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setPhase('idle')
      }, [flush, release])

      /** Write the SRT record and its Markdown companion into the host's meetings directory. */
      const exportFiles = React.useCallback(async () => {
        if (meetingId === '') return
        // Local date and time, so the file name matches the meeting's wall clock.
        const stamp = stampOf(startedAt === 0 ? Date.now() : startedAt)
        try {
          const reply = await post('/export', {
            meetingId,
            files: [
              { name: `${stamp}.srt`, content: srtOf(visible) },
              { name: `${stamp}.md`, content: markdownOf(visible, startedAt, terms, points, tasks) },
            ],
          })
          setNote(`${t('saved')}: ${reply.paths.join('  |  ')}`)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [meetingId, points, startedAt, tasks, terms, t, visible])

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
          // The meeting picker: search every meeting on this machine and open one for
          // reading. Switching the view never changes which meeting the session owns (§5.4).
          h('div', {
            key: 'pickerwrap',
            style: styles.pickerWrap,
            // Clicks inside the dropdown must not reach the document listener that closes it.
            onClick: (event) => event.stopPropagation(),
          }, [
          h('div', { key: 'pickerbar', style: styles.row }, [
            // The platform's Input: the same field the built-in model picker searches with,
            // so an IME behaves; a plain input is the fallback when primitives are absent.
            h(SearchInput, {
              key: 'query',
              type: 'text',
              style: styles.inlineWide,
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
            h(Btn, {
              key: 'toggle',
              type: 'button',
              style: styles.smallButton,
              onClick: () => {
                const open = picker.open !== true
                setPicker((value) => ({ ...value, open }))
                if (open) void loadHistory(picker.query)
              },
            }, picker.open ? t('hubClose') : t('historyOpen')),
          ]),
          // The results float under the field, scroll and page in as they are read: the
          // dropdown is a component, not a block that pushes the panel around.
          picker.open !== true ? null : h('div', {
            key: 'pickerlist',
            style: styles.historyPanel,
            onScroll: onPickerScroll,
          }, [
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
              // The whole card opens the meeting — the name is the obvious target, and the
              // preview line beside it means the same thing.
              onClick: () => { void chooseHistorical(row) },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void chooseHistorical(row)
                }
              },
            }, [
              // First line: when it happened, what it was called, and its type and period.
              h('div', { key: 'head', style: styles.historyHead }, [
                h('span', { key: 'when', style: styles.stamp }, new Date(row.startedAt).toLocaleDateString()),
                h('span', { key: 'name', style: styles.historyName }, row.title === '' ? t('meetingNameNone') : row.title),
                row.kind === '' ? null : h('span', { key: 'kind', style: styles.chip }, t(KIND_LABEL_KEYS[row.kind] ?? 'kindGeneral')),
                row.period === '' ? null : h('span', { key: 'period', style: styles.hint }, row.period),
                row.hasContent === true ? null : h('span', { key: 'blank', style: styles.chip }, t('historyBlank')),
              ]),
              // Second line: the preview sentence, on its own line so a long name never
              // squeezes it.
              row.excerpt === '' ? null : h('div', { key: 'excerpt', style: styles.historyExcerpt }, row.excerpt.length > 120 ? `${row.excerpt.slice(0, 120)}…` : row.excerpt),
            ])),
            // The footer says where the paging stands: more to come, or everything shown.
            picker.rows.length === 0 ? null : h('div', { key: 'more', style: styles.hint }, picker.rows.length >= picker.total
              ? t('historyAll')
              : (picker.loadingMore === true ? t('historyLoading') : t('historyMore'))),
          ]),
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
          // Meeting identity: name, type, the derived period, and this kind's one-click
          // distill (FEATURES.md §2.1, §3, §5.1). Hidden while viewing a historical meeting.
          viewed !== null ? null : h('div', { key: 'metabar', style: styles.row }, [
            h(Field, {
              key: `title-${meta.title}`,
              type: 'text',
              style: styles.inlineWide,
              defaultValue: meta.title,
              placeholder: t('meetingNamePlaceholder'),
              spellCheck: false,
              onBlur: (event) => {
                const next = event.target.value.trim()
                if (next !== meta.title) void saveMeta({ title: next })
              },
            }),
            h(Picker, {
              key: 'kind',
              style: styles.inlineInput,
              value: meta.kind,
              onChange: (event) => { void saveMeta({ kind: event.target.value }) },
            }, KIND_VALUES.map((value) => h('option', { key: value === '' ? 'general' : value, value }, t(KIND_LABEL_KEYS[value])))),
            meta.period === '' ? null : h('span', { key: 'period', style: styles.chip }, meta.period),
            series.prev === null ? null : h(Btn, {
              key: 'prev',
              type: 'button',
              style: styles.smallButton,
              title: `${series.prev.title === '' ? t('meetingNameNone') : series.prev.title}${series.prev.period === '' ? '' : ` · ${series.prev.period}`}`,
              onClick: () => openSeries(series.prev),
            }, t('seriesPrev')),
            series.next === null ? null : h(Btn, {
              key: 'next',
              type: 'button',
              style: styles.smallButton,
              title: `${series.next.title === '' ? t('meetingNameNone') : series.next.title}${series.next.period === '' ? '' : ` · ${series.next.period}`}`,
              onClick: () => openSeries(series.next),
            }, t('seriesNext')),
            h(Btn, {
              key: 'distill',
              type: 'button',
              style: styles.button,
              onClick: () => { void distill() },
            }, t(DISTILL_BUTTON_KEYS[meta.kind] ?? 'distillButtonGeneral')),
          ]),
          // A briefing starts by accounting for what yesterday's review left open (§3.1).
          carry.items.length === 0 || viewed !== null ? null : h('div', { key: 'carry', style: styles.row }, [
            h('span', { key: 'hint', style: styles.hint }, `${t('carryOverHint')} ${carry.items.length}`),
            h(Btn, { key: 'handle', type: 'button', style: styles.smallButton, onClick: () => { void handleCarryOver() } }, t('carryOverAction')),
            carry.review === null ? null : h(Btn, { key: 'open', type: 'button', style: styles.smallButton, onClick: () => openSeries(carry.review) }, t('carryOverOpen')),
          ]),
          // Recording and the meeting's own actions belong to the session's meeting, so they
          // step aside while a historical meeting is being read (§5.4).
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
              setNamePrompt({ text: '', kind: meta.kind, role: role === '' ? 'attendee' : role, start: true })
            },
          }, recording ? t('stop') : t('start')),
          // Pause sits beside Stop: a pause keeps the meeting open, Stop ends it (§5.6).
          phase !== 'recording' ? null : h(Btn, {
            key: 'pause',
            type: 'button',
            style: paused ? styles.buttonActive : styles.button,
            onClick: () => togglePause(),
          }, paused ? t('resumeRecording') : t('pauseRecording')),
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
          h(Btn, {
            key: 'minutes',
            type: 'button',
            style: styles.button,
            onClick: () => { void writeMinutes() },
          }, t('minutes')),
          // The overflow is a dropdown under its own button: the action row keeps one line,
          // and 「生成要点与任务」 sits with the other occasional actions instead of shouting
          // in the bar.
          hasContent ? h('div', { key: 'morewrap', style: styles.menuWrap }, [
            h(Btn, {
              key: 'more',
              type: 'button',
              style: moreOpen ? styles.buttonActive : styles.button,
              'aria-expanded': moreOpen,
              onClick: () => setMoreOpen((value) => !value),
            }, t('more')),
            moreOpen ? h('div', { key: 'moremenu', style: styles.menu, role: 'menu' }, [
              segments.length === 0 ? null : h(Btn, {
                key: 'extract', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void extract() },
              }, t('generate')),
              h(Btn, {
                key: 'files', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void exportFiles() },
              }, t('exportFile')),
              segments.length === 0 ? null : h(Btn, {
                key: 'srt', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copySrt() },
              }, t('copySrt')),
              segments.length === 0 ? null : h(Btn, {
                key: 'copy', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copyText() },
              }, t('copy')),
              segments.length === 0 ? null : h(Btn, {
                key: 'fix', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void copyForFix() },
              }, t('copyForFix')),
              h(Btn, {
                key: 'refresh', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void refreshAnalysis() },
              }, t('refresh')),
              segments.length === 0 ? null : h(Btn, {
                key: 'revise', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void revise() },
              }, t('revise')),
              h(Btn, {
                key: 'minutesdocx', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void writeMinutes('docx') },
              }, t('minutesDocx')),
              h(Btn, {
                key: 'push', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => { setMoreOpen(false); void push() },
              }, t('push')),
              // Name and role live in one dialog; this brings it back after the meeting
              // was named, so the seat stays changeable (FEATURES §5.5).
              h(Btn, {
                key: 'setup', type: 'button', style: styles.menuItem, role: 'menuitem',
                onClick: () => {
                  setMoreOpen(false)
                  setNamePrompt({ text: meta.title, kind: meta.kind, role: role === '' ? 'attendee' : role, start: false })
                },
              }, t('meetingSetup')),
            ]) : null,
          ]) : null,
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
        h('span', { key: 'status', style: styles.status }, status),
        notesOpen ? h('div', { key: 'tabs', style: styles.tabs }, [
          h(Btn, {
            key: 'ink',
            type: 'button',
            style: tab === 'ink' ? styles.tabActive : styles.tab,
            onClick: () => setTab('ink'),
          }, t('tabInk')),
          h(Btn, {
            key: 'system',
            type: 'button',
            style: tab === 'system' ? styles.tabActive : styles.tab,
            onClick: () => setTab('system'),
          }, t('tabSystem')),
          h(Btn, {
            key: 'terms',
            type: 'button',
            style: tab === 'terms' ? styles.tabActive : styles.tab,
            onClick: () => setTab('terms'),
          }, t('tabTerms')),
        ]) : null,
        // One fixed-height body so switching tabs never resizes the panel.
        notesOpen ? h('div', { key: 'tabbody', style: styles.tabBody }, [
          tab === 'ink' ? h(InkPad, {
            key: 'ink',
            t,
            onSave: saveNote,
            onRecognize: recognize,
            onRecognizeLocal: recognizeNote,
            recognizedText: lastNote,
            onRecognizedToTask: (text) => { void noteToTask(text) },
            onDismissRecognized: () => setLastNote(''),
          }) : null,
          tab === 'system' ? h('div', { key: 'system', style: styles.list }, [
            h('span', { key: 'hint', style: styles.hintLines }, t('inkSystemHint')),
            h(Btn, {
              key: 'open',
              type: 'button',
              style: styles.button,
              onClick: () => {
                const field = systemField.current
                if (field !== null) field.focus()
                try {
                  navigator.virtualKeyboard?.show?.()
                } catch (failure) {
                  console.warn('meeting-room: the system handwriting panel did not open', failure)
                }
              },
            }, t('inkSystemOpen')),
            h(Field, {
              key: 'field',
              ref: systemField,
              style: styles.textarea,
              value: systemText,
              placeholder: t('inkStore'),
              onChange: (event) => setSystemText(event.target.value),
            }),
            h(Btn, {
              key: 'store',
              type: 'button',
              style: styles.button,
              disabled: systemText.trim() === '',
              onClick: () => { void saveText(systemText) },
            }, t('inkStore')),
          ]) : null,
          tab === 'terms' ? h('div', { key: 'terms', style: styles.list }, [
            h('span', { key: 'hint', style: styles.hint }, t('termsHint')),
            h(Field, {
              key: 'input',
              id: 'meeting-room-terms',
              style: styles.termsArea,
              value: termsText,
              spellCheck: false,
              onChange: (event) => setTermsText(event.target.value),
            }),
          ]) : null,
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
        helpOpen ? h('div', { key: 'help', style: styles.help }, t('helpBody')) : null,
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
          : h('div', { key: 'list', style: styles.list }, visible.map((segment, index) => h('div', {
            key: segment.id,
            ref: (element) => { rows.current[index] = element },
            style: index === activeIndex ? styles.segmentActive : styles.segment,
            className: 'mr-hover',
            title: t('seekHint'),
            onClick: () => seekTo(segment.start),
          }, [
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
        bodyTab !== 'names' ? null : h('div', { key: 'names', style: styles.list }, [
          // Folded away by default: naming voices is an occasional task, and the fields would
          // otherwise sit in the panel the whole time.
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'title', style: styles.label }, t('speakerNames')),
            labels.length === 0 ? null : h(Btn, {
              key: 'toggle',
              type: 'button',
              style: namesOpen ? styles.buttonActive : styles.button,
              onClick: () => setNamesOpen((value) => !value),
            }, namesOpen ? t('hubClose') : t('openNames')),
            viewed !== null ? null : h(Btn, {
              key: 'relabel',
              type: 'button',
              style: styles.button,
              disabled: relabeling,
              onClick: () => { void relabelRecording() },
            }, relabeling ? t('speakerRelabeling') : t('speakerRelabel')),
          ]),
          labels.length === 0
            // An empty tab must explain itself: labels appear once someone speaks and pauses,
            // and this button is the repair path when the online pass left the meeting blank.
            ? h('span', { key: 'empty', style: styles.hint }, t('speakerNamesEmpty'))
            : namesOpen ? h('div', { key: 'body', style: styles.list }, [
            h('span', { key: 'hint', style: styles.hint }, t('speakerNameHint')),
            ...labels.map((label) => h('div', { key: label, style: styles.row }, [
            h('span', { key: 'label', style: styles.chip }, label),
            h(Field, {
              key: 'name',
              style: styles.textarea,
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
          ]) : null,
        ]),
        bodyTab !== 'points' ? null : h('div', { key: 'points', style: styles.list }, [
          h('div', { key: 'title', style: styles.label }, `${t('points')} (${points.length})`),
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
          h('div', { key: 'add', style: styles.row }, [
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
          h('div', { key: 'title', style: styles.label }, `${t('tasks')} (${tasks.filter((task) => task.status === 'confirmed').length}/${tasks.length})`),
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
                key: 'done',
                type: 'checkbox',
                checked: task.status === 'confirmed',
                title: t('confirm'),
                onChange: (event) => { void editEntry('task', task.id, { status: event.target.checked ? 'confirmed' : 'draft' }) },
              }),
              h(Field, {
                key: 'title',
                type: 'text',
                style: styles.taskTitleInput,
                defaultValue: task.title,
                placeholder: t('taskTitlePh'),
                spellCheck: false,
                title: task.status === 'draft' ? t('taskDraft') : t('taskConfirmed'),
                onBlur: (event) => {
                  const next = event.target.value.trim()
                  if (next !== '' && next !== task.title) void editEntry('task', task.id, { title: next })
                  else event.target.value = task.title
                },
              }),
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
                key: 'del',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { void editEntry('task', task.id, {}, 'remove') },
              }, t('remove')),
            ])
          }),
          // The same promise as the points tab: this tab is never a dead end.
          h('div', { key: 'add', style: styles.row }, [
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
        bodyTab !== 'scores' ? null : h('div', { key: 'scores', style: styles.list }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'title', style: styles.label }, `${t('panelTabScores')} (${scores.length})`),
            viewed !== null ? null : h(Btn, { key: 'prefill', type: 'button', style: styles.button, onClick: () => { void prefillScores() } }, t('scoresPrefill')),
            viewed !== null ? null : h(Btn, { key: 'csv', type: 'button', style: styles.smallButton, onClick: () => { void exportScores('csv') } }, t('scoresExportCsv')),
            viewed !== null ? null : h(Btn, { key: 'xlsx', type: 'button', style: styles.smallButton, onClick: () => { void exportScores('xlsx') } }, t('scoresExportXlsx')),
          ]),
          h('span', { key: 'hint', style: styles.hint }, t('scoresHint')),
          scores.length === 0 ? null : h('div', { key: 'rows', style: styles.list }, scores.map((row) => h('div', {
            key: row.person,
            style: row.status === 'confirmed' ? styles.segment : styles.taskDone,
          }, [
            h(Field, {
              key: 'confirmed',
              type: 'checkbox',
              checked: row.status === 'confirmed',
              title: t('confirm'),
              onChange: (event) => { void editScore(row.person, { status: event.target.checked ? 'confirmed' : 'draft' }) },
            }),
            h('span', { key: 'person', style: styles.chip }, row.person),
            h(Field, { key: 'hours', type: 'number', style: styles.inlineInput, defaultValue: String(row.hours ?? 0), title: t('scoreHours'), onBlur: (event) => { void editScore(row.person, { hours: Number(event.target.value) }) } }),
            h(Field, { key: 'completion', type: 'number', style: styles.inlineInput, defaultValue: String(row.completion ?? 0), title: t('scoreCompletion'), onBlur: (event) => { void editScore(row.person, { completion: Number(event.target.value) }) } }),
            h(Field, { key: 'quality', type: 'number', style: styles.inlineInput, defaultValue: String(row.quality ?? 0), title: t('scoreQuality'), onBlur: (event) => { void editScore(row.person, { quality: Number(event.target.value) }) } }),
            h(Field, { key: 'learn', type: 'number', style: styles.inlineInput, defaultValue: String(row.learn ?? 0), title: t('scoreLearn'), onBlur: (event) => { void editScore(row.person, { learn: Number(event.target.value) }) } }),
            h('span', { key: 'total', style: styles.chip }, `${t('scoreTotal')} ${row.total ?? 0}`),
            h(Field, { key: 'highlight', type: 'text', style: styles.inlineWide, defaultValue: row.highlight ?? '', placeholder: t('scoreHighlight'), spellCheck: false, onBlur: (event) => { void editScore(row.person, { highlight: event.target.value }) } }),
            h(Field, { key: 'improve', type: 'text', style: styles.inlineWide, defaultValue: row.improve ?? '', placeholder: t('scoreImprove'), spellCheck: false, onBlur: (event) => { void editScore(row.person, { improve: event.target.value }) } }),
            (row.basis ?? []).length === 0 ? null : h('span', { key: 'basis', style: styles.chip, title: (row.basis ?? []).join('\n') }, `${t('scoreBasis')} ${(row.basis ?? []).length}`),
            h(Btn, { key: 'del', type: 'button', style: styles.smallButton, onClick: () => { void removeScore(row.person) } }, t('remove')),
          ]))),
          h('div', { key: 'add', style: styles.row }, [
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
          ]),
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
        documents.length === 0 ? null : h('div', { key: 'docs', style: styles.list }, [
          h('div', { key: 'label', style: styles.label }, `${t('documents')} (${documents.length})`),
          ...documents.map((entry) => h('div', { key: entry.id, style: styles.row }, [
            h('span', { key: 'title', style: { flex: 1 } }, entry.title),
            h('span', { key: 'name', style: styles.chip }, entry.name),
            h(Btn, {
              key: 'open',
              type: 'button',
              style: styles.smallButton,
              onClick: () => { void openStoredDocument(entry) },
            }, t('openDocument')),
          ])),
        ]),
        openDocument === null ? null : h('div', { key: 'docview', style: styles.help }, openDocument),
        note === '' ? null : h('p', { key: 'note', style: styles.note }, note),
        speech.ready === false ? h('div', { key: 'sp', style: styles.help }, [
          h('p', { style: styles.subtitle }, speech.requesting ? (speechDetail !== '' ? speechDetail : t('speechPreparing')) : speech.phase === 'unavailable' ? t('speechUnavailableHint') : t('speechPrepareHint')),
          pendingStart ? h('p', { style: styles.status }, t('speechAutoStart')) : null,
          h('div', { style: styles.row }, [
            h(Btn, { key: 'dl', type: 'button', style: styles.button, disabled: speech.requesting, onClick: () => { void prepareSpeech() } }, speech.requesting ? t('preparingInPanel') : t('speechPrepareAction')),
            pendingStart ? h(Btn, { key: 'cn', type: 'button', style: styles.button, onClick: () => setPendingStart(false) }, t('speechCancel')) : null,
            typeof props.openVoiceInputBundle === 'function' && !speech.requesting && !pendingStart ? h(Btn, { key: 'dt', type: 'button', style: styles.linkButton, onClick: () => props.openVoiceInputBundle() }, t('setupDetails')) : null,
          ]),
        ]) : error === '' ? null : h('p', { key: 'error', style: styles.error }, `${t('error')}: ${error}`),
        switchPrompt === null ? null : h('div', {
          key: 'switchprompt',
          style: styles.setupOverlay,
          role: 'dialog',
          'aria-modal': 'true',
        }, [
          h('div', { style: styles.setupCard }, [
            h('h2', { style: styles.setupTitle }, t('historyGuardTitle')),
            h('p', { style: styles.note }, t('historyGuardBody')),
            h('p', { key: 'count', style: styles.status }, `⏳ ${switchPrompt.seconds}`),
            h('div', { key: 'foot', style: styles.setupFoot }, [
              h(Btn, {
                key: 'now',
                type: 'button',
                style: styles.button,
                onClick: () => setSwitchPrompt((value) => (value === null ? null : { ...value, seconds: 0 })),
              }, t('historyGuardNow')),
              h(Btn, {
                key: 'cancel',
                type: 'button',
                style: styles.button,
                onClick: () => setSwitchPrompt(null),
              }, t('cancelEntry')),
            ]),
          ]),
        ]),
        namePrompt === null ? null : h('div', {
          key: 'nameprompt',
          style: styles.setupOverlay,
          role: 'dialog',
          'aria-modal': 'true',
        }, [
          h('div', { style: styles.setupCard }, [
            h('h2', { style: styles.setupTitle }, t('meetingNameTitle')),
            h('p', { style: styles.note }, t('meetingNameHint')),
            h(Field, {
              key: 'text',
              type: 'text',
              style: styles.inlineWide,
              value: namePrompt.text,
              placeholder: t('meetingNamePlaceholder'),
              spellCheck: false,
              onChange: (event) => setNamePrompt((current) => ({ ...current, text: event.target.value })),
            }),
            // The seat steers the review prompt, so it is chosen here — with the name the
            // meeting is starting under (§5.5).
            h('div', { key: 'rolerow', style: styles.row }, [
              h('span', { key: 'rolelabel', style: styles.status }, t('roleLabel')),
              h(Picker, {
                key: 'role',
                style: styles.inlineInput,
                value: namePrompt.role ?? 'attendee',
                onChange: (event) => setNamePrompt((current) => ({ ...current, role: event.target.value })),
              }, ['host', 'attendee', 'observer'].map((seat) => h('option', { key: seat, value: seat }, t(ROLE_LABEL_KEYS[seat])))),
            ]),
            h('div', { key: 'chips', style: styles.row }, KIND_VALUES.map((value) => h(Btn, {
              key: value === '' ? 'general' : value,
              type: 'button',
              style: namePrompt.kind === value ? styles.buttonActive : styles.button,
              onClick: () => setNamePrompt((current) => ({
                ...current,
                kind: value,
                // A chip fills the default name only while nothing was typed yet.
                text: current.text.trim() === ''
                  ? `${t(KIND_LABEL_KEYS[value])} · ${new Date().toLocaleDateString()}`
                  : current.text,
              })),
            }, t(KIND_LABEL_KEYS[value])))),
            h('div', { key: 'foot', style: styles.setupFoot }, [
              h(Btn, {
                key: 'go',
                type: 'button',
                style: styles.button,
                onClick: () => {
                  const draft = namePrompt
                  setNamePrompt(null)
                  void (async () => {
                    if (draft === null) return
                    // The seat is stored with the name, so both land before recording starts.
                    const nextRole = typeof draft.role === 'string' && draft.role !== '' ? draft.role : role
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
            ]),
          ]),
        ]),
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
     * Open the meeting panel from the session header.
     * @param props - Localized copy plus the injected opener.
     * @returns the header button.
     */
    function OpenMeetingButton(props) {
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
          return h('div', { style: styles.hubCard }, [
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

      /** Hand the rendered note to the agent for handwriting recognition. */
      const recognize = async () => {
        const pngBase64 = pngBytes()
        if (pngBase64 !== '') await props.onRecognize(pngBase64)
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
          h(Btn, {
            key: 'recognize',
            type: 'button',
            style: styles.button,
            disabled: count === 0 && strokes.current.length === 0,
            onClick: () => { void recognize() },
          }, t('inkRecognize')),
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
      const [files, setFiles] = React.useState([])
      const [preview, setPreview] = React.useState(null)
      const [error, setError] = React.useState('')
      const [termsText, setTermsText] = React.useState(readTerms)
      /** Push settings and the shared roster live here, not in a single meeting's panel. */
      const [settings, setSettings] = React.useState({ configured: [], people: [], departments: [] })
      const [settingsDraft, setSettingsDraft] = React.useState({ dingtalk: '', wecom: '', appKey: '', appSecret: '', agentId: '', mode: 'group' })
      const [personDraft, setPersonDraft] = React.useState({ name: '', phone: '', userId: '' })
      const [deptId, setDeptId] = React.useState(0)
      const [directoryBusy, setDirectoryBusy] = React.useState(false)
      const [settingsNote, setSettingsNote] = React.useState('')
      /** Which hub section is showing; the page keeps its own tabs, not the panel's. */
      const [hubTab, setHubTab] = React.useState('records')

      /** Load settings, the roster and any cached department tree when either tab opens. */
      React.useEffect(() => {
        if (hubTab !== 'settings' && hubTab !== 'people') return undefined
        let cancelled = false
        void (async () => {
          try {
            const config = await get('/webhooks')
            const roster = await get('/people')
            if (cancelled) return
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

      /** Re-read the exported artifacts from the host. */
      const refresh = React.useCallback(async () => {
        setError('')
        try {
          const value = await get('/list')
          setFiles(value.files)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

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

      /**
       * Show one artifact in the operating system's file manager.
       * @param name - File name inside the export directory.
       */
      const reveal = React.useCallback(async (name) => {
        setError('')
        try {
          await post('/reveal', { name })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const open = React.useCallback(async (name) => {
        setError('')
        // A drawing is shown as an image; nothing to parse.
        if (name.endsWith('.png')) {
          setPreview({ name, audioName: '', image: true, segments: [], markdown: '' })
          return
        }
        const base = name.replace(/\.(srt|md|wav)$/u, '')
        const has = (candidate) => files.some((file) => file.name === candidate)
        const audioName = has(`${base}.wav`) ? `${base}.wav` : ''
        const srtName = has(`${base}.srt`) ? `${base}.srt` : ''
        const mdName = has(`${base}.md`) ? `${base}.md` : ''
        const load = async (target) => {
          if (target === '') return ''
          const value = await get(`/file?name=${encodeURIComponent(target)}`)
          return typeof value.content === 'string' ? value.content : ''
        }
        try {
          const srtText = await load(srtName)
          const markdown = await load(mdName)
          setPreview({
            name,
            audioName,
            segments: srtText === '' ? [] : parseSrt(srtText),
            markdown,
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [files])

      return h(Boundary, null, h('section', { style: styles.hub }, [
        h('h1', { key: 'title', style: styles.hubTitle }, t('hubTitle')),
        h('p', { key: 'intro', style: styles.subtitle }, t('hubIntro')),
        h('div', { key: 'status', style: styles.hubCard }, [
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
        hubTab === 'settings' ? h('div', { key: 'settings', style: styles.hubCard }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('robotSettings')),
          ]),
          h('div', { key: 'body', style: styles.list }, [
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
        ]) : null,
        hubTab === 'people' ? h('div', { key: 'people', style: styles.hubCard }, [
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
        hubTab === 'records' ? h('div', { key: 'records', style: styles.hubCard }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'label', style: styles.label }, t('hubRecords')),
            h(Btn, { key: 'refresh', type: 'button', style: styles.button, onClick: () => { void refresh() } }, t('hubRefresh')),
          ]),
          files.length === 0
            ? h('p', { key: 'empty', style: styles.empty }, t('hubEmpty'))
            : h('div', { key: 'list', style: styles.hubList }, files.map((file) => h('div', {
              key: file.name,
              style: styles.hubRow,
            }, [
              h(Btn, {
                key: 'open',
                type: 'button',
                style: styles.linkButton,
                onClick: () => { void open(file.name) },
              }, file.name),
              h('span', { key: 'meta', style: styles.stamp }, `${Math.max(1, Math.round(file.size / 1024))} KB · ${absoluteOf(file.modified)}`),
              h(Btn, {
                key: 'send',
                type: 'button',
                style: styles.smallButton,
                title: t('hubSendHint'),
                onClick: () => { void sendToNewConversation(file) },
              }, t('hubSend')),
              file.sessionId === '' ? null : h(Btn, {
                key: 'session',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { props.openConversation(file.sessionId) },
              }, t('hubOpenSession')),
              h(Btn, {
                key: 'reveal',
                type: 'button',
                style: styles.smallButton,
                onClick: () => { void reveal(file.name) },
              }, t('hubReveal')),
            ]))),
        ]) : null,
        hubTab === 'records' && preview !== null ? h('div', { key: 'preview', style: styles.hubCard }, [
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
      } catch { return { ready: true, phase: 'unavailable', busy: false, message: '', completedBytes: 0, totalBytes: 0 } }
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
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout', 'sessions'],
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
          if (readRailCollapsed() === false) ctx.layout.toggleSidebar()
          // Opening expands the column and seeds its default width when it never had one.
          ctx.sidebarRight.openTab(TAB_KIND)
          const info = layoutStore()?.getSnapshot?.()?.layoutInfo
          savedRightbar = typeof info?.rightbar === 'number' ? info.rightbar : null
          setRightbarWidth(info?.viewportWidth ?? window.innerWidth)
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
        }), 'meeting-room: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
          inject: () => ({ askNote, askText, openVoiceInputBundle: () => { if (readRailCollapsed() === true) ctx.layout.toggleSidebar(); const nav = ctx.get('pluginNavigation'); if (nav) nav.openBundle('@deepseek-ai/dsh-experimental-voice-input-bundle'); else ctx.layout.selectPanel('plugins') } }),
        }, MeetingPanel))
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: TAB_ID,
        }, MeetingTabTitle))
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'meeting-room.open',
          order: 20,
          locale: NS,
          inject: () => ({ open: () => toggleMeetingFocus() }),
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
              workspace.openSession({ sessionId })
              return true
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
