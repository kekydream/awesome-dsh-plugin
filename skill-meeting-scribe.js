/**
 * The `meeting-scribe` skill registered by the meeting-room plugin.
 *
 * A skill is prompt text plus a workflow: here the workflow is a five-minute reminder
 * loop that keeps the meeting's points and assignments up to date while it runs, and
 * deletes itself once the recording has stopped. The skill lives in this file (instead
 * of a SKILL.md) because the browser package ships no data directory; the Host registers
 * it into `ctx.skills` at activation.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 */

/** The reminder prompt, written once so the skill and the reminder cannot drift apart. */
export const SCRIBE_REMINDER_PROMPT = [
  '会议要点整理（5 分钟一轮）：',
  '1) 先调 meeting_session {action:"status"} 查看会议是否仍在录音；',
  '2) 已停止录音 → 收尾：meeting_read {limit:400} 读全文 → meeting_write {mode:"append"} 补写遗漏的要点与工作安排',
  '→ meeting_save_document {kind:"summary"} 写会议小结 → schedule_list 找到标题为「会议要点整理」的提醒并 schedule_delete → 告诉用户已结束及条数；',
  '3) 仍在录音 → meeting_read {limit:200}，只整理上次总结之后的新内容，写成要点（decision/point/risk/question）与工作安排',
  '（title 以动词开头；owner、due 只有会上明确说了才填，没说不编；quote 用原话）→ meeting_write {mode:"append"}；',
  '4) 第一轮还要检查会议名：若为空或「类型 · 日期」占位，用前 5 分钟内容起一个 6–16 字的名称并 meeting_session {action:"create", title:"…"} 更新；',
  '5) 用一两句话汇报本轮新增，不要重复已有要点，不要创建第二个提醒。',
].join(' ')

/** The skill body; the catalog shows `description` and loads this on demand. */
export const MEETING_SCRIBE_SKILL = {
  name: 'meeting-scribe',
  description: '用会议记录助手开会：可以不带任何参数直接开始，自动建会并开启录音；每 5 分钟整理要点与工作安排，第一轮用前 5 分钟内容补会议名称，停录后自动收尾并停止整理。',
  whenToUse: '用户调用 meeting-scribe、说「开始记录」「开会」「边开会边记要点」「每 5 分钟总结一次」，或要把讨论实时整理成要点/工作安排时。不需要用户先提供会议名称或参数。',
  source: 'runtime',
  content: `# 会议记录助手（meeting-scribe）

用这个技能主持一场会议：可以**不带任何参数**直接开始；会中每 5 分钟把新内容整理成
会议要点与工作安排，会议结束后停止。名称来不及起也没关系——第一轮整理时按前 5 分钟
的内容补上。

## 一、开始会议（不需要问名称）

用户调用本技能、或只说一句「开始记录」「开会」「用 meeting-scribe」，就**直接开始**，
不要先追问会议名称、类型或参会人。

1. \`meeting_session {action:"status"}\`
   - 已有会议：跳过第 2 步。
   - 没有会议（回执说没有会议记录）：\`meeting_session {action:"create"}\`。
     这个调用会为该会话创建会议，不传 title/kind 也可以。
2. 用户**主动说了**类型才设置类型（晨会 \`briefing\`、复盘 \`review\`、周会 \`weekly\`、
   月会 \`monthly\`）；没说就保持空（临时会议）。\`meeting_session {action:"create","kind":"…"}\`
   周期由系统推导，不要问。
   **不要**为了填名称而停下——名称留给第 5 步。
3. \`meeting_session {action:"record"}\`：请求会议面板自动开始录音。
   - 这是**请求**，不是替用户开麦克风：面板会在几秒内开始，浏览器第一次会询问麦克风权限。
   - 你**不要**声称「已经开始录音」，而要说「已请求开始，面板会自动开启；如果十几秒还没开始，
     请点一下面板的『开始记录』」。
   - 回执说「录音已经在进行中」就不要再请求。
4. 建一个 5 分钟循环提醒（只建一个）：
   - 先 \`schedule_list\`；已有标题「会议要点整理」的提醒就复用，不再新建。
   - 否则 \`schedule_create\`：
     - title: \`会议要点整理\`
     - every_seconds: \`300\`
     - prompt: 把本技能「三、每轮做什么」的全文附上，并写明会议 id 与名称（没有名称就写「未命名」）。
   - 把返回的 schedule id 记下来（收尾时删除用）。
5. 立刻做一次第 0 轮（把开场白也整理进去）。**这一轮不要改名**：内容太少，等第一轮。

## 二、第一轮补会议名称（约 5 分钟后）

第一轮（第一次 5 分钟提醒）除了整理要点，还要检查名称：

- \`meeting_session {action:"status"}\` 或 \`meeting_read\` 回执里的名称。
- 名称**为空**，或是「通用 · 日期」「晨会 · 日期」这类由类型+日期自动填的占位：
  1. 从**前 5 分钟**的实录里提炼主题：谁、讨论什么、要解决什么；
  2. 起一个 **6–16 字**的中文名称，能让人一眼认出这场会（例如「周三选题会：双十一预热」）；
  3. \`meeting_session {action:"create","title":"新名称"}\`（kind 保持不变）；
  4. 汇报时加一句「已按前 5 分钟内容把会议命名为『…』，可以在面板里改」。
- 名称已经是用户起的：**不要改**，不要「优化」它。
- 用户后来自己改了名称：以用户的为准，后续不要再动。

## 三、自动停止的条件

每轮先查 \`meeting_session {action:"status"}\`：

- \`recording: true\` → 继续整理。
- \`recording: false\` → 会议已结束，执行收尾（第四节），然后 **schedule_delete** 掉「会议要点整理」提醒。
- 用户说「结束会议」但录音还在：提醒他去面板点停止；不要替他停麦克风。

## 四、每轮做什么（录音进行中）

1. \`meeting_read\`（默认最近 400 段）读实录。回执里已有「已记录的要点 / 工作安排」，据此避免重复。
2. 只处理**上次整理之后**的新内容（对照时间与已有要点；重复内容不要写第二次）。
3. 调 \`meeting_write\`，\`mode:"append"\`：
   - points：决定/结论 \`decision\`、关键信息 \`point\`、风险 \`risk\`、待定问题 \`question\`。
     每条一句话；\`quote\` 用原话（逐字），便于人核对。
   - tasks：工作安排，\`title\` 以动词开头（负责/跟进/整理/确认/发出…）。
     \`owner\`、\`due\` 只有会上明确说了才填；\`source\` 用分配任务的原话。
   - 不写寒暄、口头禅、没有信息量的句子；听不清或不确定的宁可不写。
4. 汇报：一两句话说清本轮新增了几条要点、几项安排；不要复述整段内容。

## 五、收尾（录音已停止）

1. \`meeting_read {limit:400}\` 读完整实录，补齐遗漏的要点与工作安排（\`meeting_write\`，append）。
2. \`meeting_save_document {kind:"summary", title:"会议小结", markdown:"…"}\`：
   写清会议名称/类型/时间、3–6 条要点、工作安排清单（负责人 / 时间）。
3. \`schedule_list\` 找到「会议要点整理」，\`schedule_delete\` 删除它。
4. 告诉用户：会议已结束，共整理 n 条要点、m 项工作安排，可在面板里确认。

## 六、硬性规则

- 开始会议**不需要**用户提供名称或参数；不要因为「还没起名」而等待。
- 名称只在第一轮补一次，且只补空名/占位名；用户起的名字永远不改。
- 要点与工作安排都是**草稿**，需要人在面板里确认；不要说「已定稿」。
- 不创建第二个循环提醒；每轮先 \`schedule_list\` 检查。
- \`meeting_session\` 说找不到会议、\`create\` 也无法创建时：说明当前会话不能创建会议，
  请用户先在面板点「开始记录」，不要编造会议 id。
- 会议内容只留在本机；除非用户明确要求，不要外发。
`,
}

/** The tool registration text for `meeting_session`, kept beside the skill it serves. */
export const MEETING_SESSION_TOOL = {
  name: 'meeting_session',
  description: 'Create/configure this session\'s meeting, request that the panel start recording, or read whether it is still recording. Use action "create" (no arguments needed) to create or name the meeting and set its type (briefing, review, weekly, monthly, or empty for an ad-hoc meeting); action "record" leaves a start request the meeting panel picks up within seconds — the microphone stays the browser\'s, so if it is blocked the panel says why; action "status" reports recording state, elapsed time, cue count and how many points/tasks are stored.',
}