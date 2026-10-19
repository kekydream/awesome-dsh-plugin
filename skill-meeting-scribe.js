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
  '4) 用一两句话汇报本轮新增，不要重复已有要点，不要创建第二个提醒。',
].join(' ')

/** The skill body; the catalog shows `description` and loads this on demand. */
export const MEETING_SCRIBE_SKILL = {
  name: 'meeting-scribe',
  description: '用会议记录助手开会：每 5 分钟自动整理会议要点与工作安排，会议结束后自动停止整理，并把内容写回会议面板。',
  whenToUse: '用户要开始一场会议、要求「边开会边记要点」「每 5 分钟总结一次」，或要把讨论实时整理成要点/工作安排时。',
  source: 'runtime',
  content: `# 会议记录助手（meeting-scribe）

用这个技能主持一场会议：会中每 5 分钟把新内容整理成会议要点与工作安排，会议结束后停止。

## 一、开始会议

1. 问清会议名称与类型；类型只有五种：
   - 晨会 \`briefing\`、复盘 \`review\`、周会 \`weekly\`、月会 \`monthly\`、临时会议 \`''\`（空字符串）。
   - 名称没定就用「类型 · 日期」。周期由系统按类型和开始时间推导，不要问用户。
2. 调 \`meeting_session\`：
   \`{"action":"create","title":"…","kind":"briefing"}\`
   回执里有会议 id、类型、周期、是否在录音。把会议 id 记在上下文里，后续每轮都带上。
3. 告诉用户：请在右侧「会议记录」面板点「开始记录」并允许麦克风。
   **录音只能由面板开启**——不要在对话里声称已经开始录音。
4. 建一个 5 分钟循环提醒（只建一个）：
   - 先 \`schedule_list\`；已有标题「会议要点整理」的提醒就复用，不再新建。
   - 否则 \`schedule_create\`：
     - title: \`会议要点整理\`
     - every_seconds: \`300\`
     - prompt: 把本技能「三、每轮做什么」的全文附上，并写明会议 id 与名称。
   - 把返回的 schedule id 记下来（收尾时删除用）。
5. 立刻做一次第 0 轮（把开场白也整理进去）。

## 二、自动停止的条件

每轮先查 \`meeting_session {action:"status"}\`：

- \`recording: true\` → 继续整理。
- \`recording: false\` → 会议已结束，执行收尾（下面第四节），然后 **schedule_delete** 掉「会议要点整理」提醒。
- 用户说「结束会议」但录音还在：提醒他去面板点停止；不要替他停麦克风。

## 三、每轮做什么（录音进行中）

1. \`meeting_read\`（默认最近 400 段）读实录。回执里已有「已记录的要点 / 工作安排」，据此避免重复。
2. 只处理**上次整理之后**的新内容（对照时间与已有要点；重复内容不要写第二次）。
3. 调 \`meeting_write\`，\`mode:"append"\`：
   - points：决定/结论 \`decision\`、关键信息 \`point\`、风险 \`risk\`、待定问题 \`question\`。
     每条一句话；\`quote\` 用原话（逐字），便于人核对。
   - tasks：工作安排，\`title\` 以动词开头（负责/跟进/整理/确认/发出…）。
     \`owner\`、\`due\` 只有会上明确说了才填；\`source\` 用分配任务的原话。
   - 不写寒暄、口头禅、没有信息量的句子；听不清或不确定的宁可不写。
4. 汇报：一两句话说清本轮新增了几条要点、几项安排；不要复述整段内容。

## 四、收尾（录音已停止）

1. \`meeting_read {limit:400}\` 读完整实录，补齐遗漏的要点与工作安排（\`meeting_write\`，append）。
2. \`meeting_save_document {kind:"summary", title:"会议小结", markdown:"…"}\`：
   写清会议名称/类型/时间、3–6 条要点、工作安排清单（负责人 / 时间）。
3. \`schedule_list\` 找到「会议要点整理」，\`schedule_delete\` 删除它。
4. 告诉用户：会议已结束，共整理 n 条要点、m 项工作安排，可在面板里确认。

## 五、硬性规则

- 要点与工作安排都是**草稿**，需要人在面板里确认；不要说「已定稿」。
- 不创建第二个循环提醒；每轮先 \`schedule_list\` 检查。
- \`meeting_session\` 说找不到会议时：说明当前会话还没有会议记录，请用户先在面板点「开始记录」，
  不要编造会议 id，也不要自己创建会议条目。
- 会议内容只留在本机；除非用户明确要求，不要外发。
`,
}

/** The tool registration text for `meeting_session`, kept beside the skill it serves. */
export const MEETING_SESSION_TOOL = {
  name: 'meeting_session',
  description: 'Create/configure this session\'s meeting or read whether it is still recording. Use action "create" to set its name and type (briefing, review, weekly, monthly, or empty for an ad-hoc meeting) before recording; use action "status" to check recording state, elapsed time, cue count and how many points/tasks are stored. Recording itself is started and stopped in the meeting panel, never from a tool.',
}