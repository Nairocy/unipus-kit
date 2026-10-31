# 典型工作流

这套工具**不产生答案**，只负责「把页面变成结构化题目」和「把答案变回页面」。所以 agent 的循环是：

```
login → courses → scan → status
        ↓
   取一个 pending 任务
        ↓
      open  ←── 返回题目 JSON（+ 媒体直链）
        ↓
   （转写 / 读题 → 产出答案）
        ↓
     answer ──→ 得分 + 是否通过
        ↓ 未通过
      grade ──→ 逐题 isRight / 逐选项 judgmentResult
        ↓
  只改错的那题，再 answer 一次
```

## 1. 建立登录态（只需一次）

```
unipus_login
```

返回二维码 png 的绝对路径，用 `MEDIA:` 或直接给用户看。扫码后登录态写进 `~/.unipus-kit/edge-profile`，后续所有命令复用。

> SSO 只有扫码入口，没有可用的无头登录路径。

## 2. 找课程

```
unipus_courses
```

返回 `[{ name, instanceId, courseResourceId }]`。
- 读写类课程有数字 `courseResourceId`（目录页用它）
- 视听说类只有 `instanceId`

## 3. 盘点必修

```
unipus_scan --course "<instanceId>" [--resource <courseResourceId>]
```

产出 `state/tasks.json`：每项带 `path` / `base`（题型）/ `leafId` / `ids` / `url` / `required` / `pass`。
后续所有命令都用 `idx` 或 `leafId` 指任务，**不要自己拼 hash URL**。

## 4. 看真待办

```
unipus_status
```

返回：
```json
{ "leaves": 288, "required": 31, "passed": 31, "pendingCount": 0, "pending": [] }
```

⚠️ 判据是 **`required && pass != 1` 的交集**。`required` 和 `pass` 各自都可能是 31 条，但集合并不相同，只看任一数字会误判「全做完了」。

## 5. 抓题 → 答题 → 提交

```
unipus_open 3
```

按题型返回不同结构：

| base | 返回 | 说明 |
|---|---|---|
| `single-choice` / `multichoice` | `questions.choice[]`（stem + options + selected） | 多选按整题判分，无部分分 |
| `basic-scoop-content` | `questions.scoopContext` + `scoopValues` | 句首空必须首字母大写 |
| `short_answer` | `questions.textValues` | 主观题，通常不计入成绩 |
| `sequence` | `questions.orderItems` + 图/陈述数量 | 人物匹配/排序 |
| `text-learn` / `vocabulary` | 无题 | 靠停留时长，见 README 的「非题目类」 |

```
unipus_answer 3 --answers '{"choice":["B",["A","C"]]}'
unipus_answer 3 --answers '{"scoop":["relaxing","Amazing"]}'
unipus_answer 3 --answers '{"order":["B","D","E","C","F","A"]}'
```

返回 `{ score, correct, total, passed, canRetry }`。通过后页面出现「继续学习」，未达 60% 出现「返回修改」。

## 6. 拿不到满分时

```
unipus_grade 3
```

两路信息：

- `items[].isRight` —— 逐题对错。**只改错的那题**再交，比整题重来快。
- `judgmentResult` —— 逐选项布尔数组（多选题专用）。它与你这次提交的 `answers` **同序**，长度 = 你选中的数量。

### 多选题的通用打法

1. 把全部选项都选上提交一次（错误答案也要交，只为拿判定）
2. `unipus_grade` 读出 `judgmentResult`，得到每个选项的真值
3. 按真值提交精确集合 → 100 分

> 单选题不能这么干（选项互斥），改用 `items[].isRight` 逐题试。

## 7. 听力/视频题

```
unipus_transcribe 3
```

下载 `video` / `audio` 直链到 `state/media/`，可选转写（需本机 `python` + `faster-whisper` + `ffmpeg`）。转写结果在 `state/trans/<leafId>.txt`，格式 `起始-结束 文本`。

拿到转写后交给 LLM 对照选项作答。**人物匹配题光有转写不够** —— 还要把视频里的人脸和选项里的头像对上，这一步需要视觉模型。

## 8. 收尾

```
unipus_status
```

确认 `pendingCount === 0`。这是唯一权威判据，不要用「提交成功」或「答题小结」代替。
