# unipus-kit

U校园（Unipus AI 版，`ucontent.unipus.cn` 探索平台）课程自动化工具包。**只做页面操作与判分核验，不内置答案**——题目抓成结构化 JSON 交给调用方（agent / LLM）作答，答案再注入回去。

两种入口，共用同一套 core：

- **CLI**：`unipus login / courses / scan / status / open / answer / grade / transcribe`
- **MCP server**：8 个 `unipus_*` 工具，供 Claude Desktop / Cursor / Hermes 等 agent 直接调用

## 为什么又造一个

U校园 的脚本生态不空白，但**没有一个是 MCP 形态、也没有一个暴露判分真相**。

| 项目 | 形态 | 覆盖 | 答案来源 |
|---|---|---|---|
| [uxudjs/UnipusAIAutoPlayer](https://github.com/uxudjs/UnipusAIAutoPlayer) | 油猴脚本 | 遍历目录刷时长、倍速播放 | 不答题 |
| [z5882852/unipus-tool](https://github.com/z5882852/unipus-tool) | Python（已归档） | 自动登录、刷时长 | 不答题 |
| [CXRunfree/AutoUnipus](https://github.com/CXRunfree/AutoUnipus) | Python + Playwright | 自动识别必修并作答 | 项目内置 |
| [Zzj-klwgxdz/UnipusAI](https://github.com/Zzj-klwgxdz/UnipusAI) | Rust 纯 HTTP | 刷课 + 答题，CLI/TUI | 服务端接口 |
| [yuanarcsin/unipus_auto](https://github.com/yuanarcsin/unipus_auto) | 浏览器扩展 | 多平台答题 | 平台接口 |
| **unipus-kit** | **CLI + MCP server** | **盘点 / 进度核验 / 抓题 / 注入 / 判分反解** | **调用方产出** |

本项目的差异化只有三件，但这三件都是别人没做的：

1. **MCP 接口**：agent 不用写脚本，直接调工具；换课程、换题型都是传参。
2. **判分 oracle**：提交后能读到逐题 `isRight` 与逐选项 `judgmentResult`，客观题因此可以**收敛到 100 分**，而不是「模型答对多少算多少」。
3. **全量进度核验**：一次 reload 拿到整门课数百个 leaf 的 `required`/`pass`，取交集算出真待办。工具不会告诉你「提交成功」，只会告诉你「服务端记成已完成」。

反过来，本项目的**有意不做**：不内置题库、不逆向加密接口、不伪造学习时长。答案由调用方产出，责任边界清楚。

## 设计原则

1. **零依赖**：不用 puppeteer / playwright，自带 200 行 CDP 客户端，只依赖 Node 内置模块（`WebSocket` 需要 Node ≥ 22）。
2. **判分读服务端**：提交成功 ≠ 完成。唯一权威判据是 `course_progress` 里 `required && pass==1`。
3. **不做答题**：抓题与注入分离，工具本身不含任何领域知识。

## 前置要求

| 项 | 说明 |
|---|---|
| Node.js | **≥ 22**（用全局 `WebSocket` 与 `fetch`） |
| 浏览器 | Edge 或任意 Chromium 内核（`UP_EDGE` 指定路径；默认 Windows Edge） |
| 转写（可选） | `python` + `faster-whisper` + `ffmpeg`，只影响 `transcribe` 子命令 |

## 安装

```bash
git clone https://github.com/Nairocy/unipus-kit.git
cd unipus-kit
node src/cli.mjs --help
# 或全局：npm link
```

## 快速开始

```bash
# 1. 登录：打开有头浏览器，导出二维码，用手机 App 扫
unipus login

# 2. 列课程，拿 instanceId（读写课还带 courseResourceId）
unipus courses

# 3. 盘点必修 → state/tasks.json
unipus scan --course "course-v2:xxxx+book_1+2026xxxx"

# 4. 真待办（required && pass!=1 的交集）
unipus status

# 5. 抓题（打印结构化 JSON）
unipus open 3

# 6. 交答案
unipus answer 3 --answers '{"choice":["B",["A","C"]]}'

# 7. 没满分？读判分真相，只改错的那题
unipus grade 3

# 8. 听力/视频题：下载媒体 + 转写
unipus transcribe 3
```

完整的分步说明见 [`docs/workflow.md`](docs/workflow.md)。

## MCP 接入

```json
{
  "mcpServers": {
    "unipus": {
      "command": "node",
      "args": ["/absolute/path/to/unipus-kit/src/mcp.mjs"]
    }
  }
}
```

| tool | 作用 |
|---|---|
| `unipus_login` | 打开浏览器，导出扫码二维码 png，返回绝对路径 |
| `unipus_courses` | 列课程（`name` / `instanceId` / `resourceId` / `courseId` / `classId`），并落盘 `state/courses.json` |
| `unipus_scan` | 盘点必修清单 → `state/tasks.json` |
| `unipus_status` | 全量进度 + 真待办（`required && !pass`） |
| `unipus_open` | 导航到任务并抓题（题干/选项/空位上下文/媒体直链） |
| `unipus_answer` | 注入答案 + 提交，返回分数与是否通过 |
| `unipus_grade` | 逐题 `isRight` / 逐选项 `judgmentResult` |
| `unipus_transcribe` | 下载媒体（可选 faster-whisper 转写） |

典型 agent 流程：`scan` → `status` → 逐个 `open` → LLM 出答案 → `answer` → 不过就 `grade` 改错题 → 最后再 `status` 归零。

## 关键概念

**题型（`base`）与处理方式**

| base | 形态 | 注入方式 |
|---|---|---|
| `single-choice` / `multichoice` | 选择题，多选整题判分无部分分 | 坐标点 `.option`（先 `scrollIntoView` 再重算 rect） |
| `basic-scoop-content` | 听写填空 | 原生 setter + `input`/`change`，**句首空必须首字母大写** |
| `short_answer` | 简答 | textarea，通常「不计入教程学习成绩」但仍是必修 |
| `sequence` | 人物匹配 / 排序 | react-sortable-hoc，**拖拽无效**，走 fiber 调 `onSortEnd` |
| `text-learn` / `vocabulary` | 材料 / 词卡 | 靠停留时长判定，**本工具不覆盖**，需人工 |

**判分 oracle**（`unipus_grade`）

- `items[].isRight`：逐子题对错，用来只改错的那题。
- `judgmentResult`：逐选项布尔数组，**与本次提交的 `answers` 同序，长度 = 选中数量**，不是 A–H 全量。
- 多选题的标准打法：**先全选提交一次**拿判定 → 再提交精确集合。单选题选项互斥，不能用这招。

**进度必须取交集**

`course_progress` 的 leaf 里，`strategies.required` 与 `state.pass==1` 各自都可能是 31 条，但两个集合并不相同。只看任一数字会得出「全做完了」的错误结论——必须判 `required && pass!=1`。

**提交按钮有两个**

页面里有外层 882px 宽的容器和 100px 宽的真按钮，`innerText` 都是「提 交」。取宽度 < 200 的那个。

## 限制

- **只能扫码登录**：SSO 没有可用的无头登录路径，必须有人扫一次二维码（之后登录态常驻 profile）。
- **不产生答案**：抓题与注入分离是刻意的；调用方需要自己有 LLM。
- **`text-learn` / `vocabulary` 不覆盖**：这两类按停留时长判定，没有可注入的答案，需要人工停留或后续版本支持。
- **转写依赖外部工具**：`transcribe` 需要本机 `python` + `faster-whisper` + `ffmpeg`，缺失时该子命令跳过而非报错。
- **同账号别多端并行**：跑课期间在手机端登录同一账号，网页端可能被踢回登录页。

## 免责声明

本项目仅用于学习 Chrome DevTools Protocol 自动化、MCP 协议与个人学习记录管理。使用它可能违反 U校园 用户协议及所在学校的学习纪律，由此产生的后果由使用者自负。请勿用于商业代刷或成绩作弊。
