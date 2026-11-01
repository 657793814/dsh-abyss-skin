# 启动音频：槽位、素材与接线

VERMILION DAWN 的六幕仪式是**会说话的**：每一幕念一句真声台词，配一层界面音效。
**启动不再加载 `boot.mp4`，所以没有进行曲音轨，也没有“念台词时压低音乐”的混音。**

本文件写的是**实际在跑的那一套**：

```
素材   skins/vermilion/lib/assets/*.mp3
下发   GET /dsh-abyss-skin/skins/vermilion/audio/<name>.mp3   （Host: index.js，逐文件注册）
接线   runtime/skin.js → createAudio() → createRite()
配置   skins/vermilion/skin.json 的 boot.voice / boot.sfx / phases[].audio
```

> `skins/vermilion/lib/index.js` 与 `lib/splash.js` 是上游 dsh-startup-screen 的完整实现，
> 保留在这里用于追溯素材的抠取方式与原始节奏；**它们不是运行路径**，改它们不会影响启动画面。

---

## 一、语音台词 —— 6 个槽位

| 槽位 | 中文主字 | 英文副标题 | 素材 | 源素材 | 时长 | 出声时机 |
|---|---|---|---|---|---|---|
| `line-1` | 需要访问许可 | `ACCESS PERMISSION REQUIRED` | `line-1.mp3` | V1 (7.40–9.36s) | **2.00s** | 第一幕亮起、与文字渐显同时 |
| `line-2` | 身份资料确认 | `IDENTITY VERIFICATION` | `line-2.mp3` | V2 (11.29–12.45s) | **1.20s** | 第二幕（身份卡 + 等确认） |
| `line-3` | 接收访问需求 | `ACCESS REQUEST RECEIVED` | `line-3.mp3` | V4 (14.76–15.83s) | **1.11s** | 第三幕（通道接通） |
| `line-4` | 开始读取权限 | `PERMISSION READ STARTED` | `line-4.mp3` | V5 (17.11–18.29s) | **1.22s** | 第四幕（授权逐项点亮） |
| `line-5` | 读取完毕 · 核验通过 | `READ COMPLETE · VERIFIED` | `line-5.mp3` | V6 (19.71–21.41s) | **1.74s** | 第五幕（红章落下） |
| `line-6` | 欢迎访问 DeepSeek Harness | `WELCOME TO DEEPSEEK HARNESS` | `line-6.mp3` | 自制落幕词 | **3.70s** | 第六幕五星与欢迎文案亮起后 380ms |

素材来自 `52xo4-igqdo-001.aac`。**V3（13.04–14.09s）是用户名字独白，按你的要求不使用。**

`line-6` 是上游 v1.6.0 fork 沿用的自制落幕词（非原片素材）：更长的收束感，
电平与其余五句同档。原片里那句只有 0.34–0.63 秒，直接截出来会让终幕像"话没说完就跳了"。

绑定关系写在 `skin.json`：

```json
{ "id": "permission", "audio": "line-1", ... }
```

`audio` 必须是 `lib/assets` 里存在的文件名（不含扩展名），Host 只认清单内的名字，
客户端也只播清单内的名字；写错就是该幕静音，不会去拉一个不存在的路径。

---

## 二、界面音效 —— 实际接线 6 个

| # | 槽位 | 出声时机 | 素材 | 实现 |
|---|---|---|---|---|
| 1 | `cue` | 每次念台词之前的两声轻提示 | 合成（1046.5 + 1568 Hz） | `audio.cue()` |
| 2 | `tick` | 英文副标题逐字渐显，每 2 个字一记 | `sfx-tick.mp3` | 缺素材回落 1760Hz 方波 |
| 3 | `step` | 每一幕推进到下一幕 | `sfx-tick.mp3` | 同上，音量更高 |
| 4 | `confirm` | 点「申请访问 / 确认身份」或按 Enter | `sfx-tick.mp3` | 同上，最响 |
| 5 | `tickRun` | 第四幕授权清单亮起 | `sfx-ticks-run.mp3` | 整串 10 个「哒」 |
| 6 | `chime` | 终幕五星亮起 | 合成（三音和声钟） | `audio.chime()` |

`tick` / `step` / `confirm` 共用同一个「哒」，靠音量区分（0.3 : 0.6 : 0.85）。
想各用不同音效，往 `lib/assets` 里补文件再改 `createAudio()` 的槽位映射即可。

**不发声的两个上游槽位**：`sweep`（黑幕→暖白底板）与 `rise`（标识升起）属于上游
splash 的过场；本仪式没有这两个画面，所以不接。

---

## 三、时长怎么定

**不写死。** 自动幕的停留 = `max(视觉基准, 实际播报时长 + 240ms 收尾)`：

```js
var spoke = audio.say(phase.audio)          // Promise<这一句实际播了多久>
spoke.then(function (spoken) {
  var target = Math.max(duration, (spoken || 0) + 240)
  timer(confirm, Math.max(0, target - (spoken || 0)))
})
```

素材播多长，这一幕就停多久；台词短也不会干等。
`duration` 从 `skin.json` 来（第三幕 2200 / 第四幕 3200 / 第五幕 2800 / 第六幕 3200）。

**用户点得快也不掐断语音**：台词进队列顺序播，只有 Esc / 跳过 / 揭幕才真的 `stop()`。

---

## 四、混音

- VERMILION 不加载启动片，因此没有进行曲音轨，也没有“台词时压低音乐”的混音。
- 台词本身按 `boot.voice.volume`（默认 0.95）播放，`line-*.mp3` 峰值 −6.9 ~ −9.0 dBFS。
- `boot.voice.lead`（默认 240ms）是提示音与开口之间的留白；终幕改成 380ms，给和声钟留余韵。
- 音效按 `boot.sfx.volume`（默认 0.5）播放，和台词各走各的 WebAudio 增益。

---

## 五、素材清单

```
skins/vermilion/lib/assets/
├─ line-1.mp3          40.3 KB   V1  需要访问许可
├─ line-2.mp3          24.5 KB   V2  身份资料确认
├─ line-3.mp3          23.0 KB   V4  接收访问需求
├─ line-4.mp3          25.0 KB   V5  开始读取权限
├─ line-5.mp3          35.2 KB   V6  读取完毕 · 核验通过
├─ line-6.mp3          88.2 KB   自制落幕词（3.70s）
├─ sfx-tick.mp3         2.1 KB   单声「哒」（41ms）
└─ sfx-ticks-run.mp3   10.2 KB   整串 10 个「哒」，每 45ms 一个
```

Host 启动时扫描这个目录（正则 `^[a-z0-9][a-z0-9._-]*\.mp3$`），
为每个文件注册一条**精确路径**路由；没有目录列表、没有通配、没有 `..` 可乘。
响应带 `Content-Type: audio/mpeg`、`Content-Length`、Range 与 ETag。

前 5 段真声素材的 40–120Hz 能量在 −25 ~ −34 dB（片尾配乐是 −1.3 dB），
**素材本身干净，没有配乐底**。

---

## 六、拿不到怎么办

三层降级，任何一层都不会把动画卡住：

1. **素材 404 / 解码失败** → 人声该幕按 0ms 处理（停留退回 `duration`）；音效换成合成音。
2. **AudioContext 被浏览器策略挂起** → 先等 800ms，同时挂一次性 `pointerdown` / `keydown`
   补解锁；解锁成功就从当前这句接着播，失败就当静音继续走。
3. **整个播放出错** → `playBuffer` 有 `duration + 1200ms` 的看门狗，Promise 一定会有结果。

---

## 七、相关设置项

| 设置项 | 作用 |
|---|---|
| `boot.sound` | **总开关**。`false` 同时关掉台词和音效 |
| `boot.volume` | 旧启动片的音量；VERMILION 没有视频后不再使用 |
| `boot.voice.enabled` | 只关台词，保留音效 |
| `boot.voice.volume` | 台词音量（默认 0.95） |
| `boot.voice.cue` | 念台词前的提示音开关 |
| `boot.voice.lead` | 提示音后留多久再开口（默认 240ms，0–1200ms） |
| `boot.sfx.enabled` / `boot.sfx.volume` | 界面音效开关与音量（默认 0.5） |
| `phases[].audio` | 该幕念哪个素材；留空 = 这一幕不配音 |

都写在 `~/.dsh/dsh-abyss-skin.json` 的 `skins.vermilion.boot` 下，例如：

```json
{
  "active": "vermilion",
  "skins": {
    "vermilion": {
      "boot": {
        "voice": { "enabled": true, "volume": 0.95, "cue": true, "lead": 240 },
        "sfx": { "enabled": true, "volume": 0.5 }
      }
    }
  }
}
```

改动需要重启 DSH（Host 端启动时一次性注册路由并快照清单）。

---

## 八、自检

启动画面跑完后，浏览器控制台里：

```js
window.__DSH_ABYSS__.audioStats
// { context: 'running',
//   decoded: ['line-1', ..., 'sfx-ticks-run'],
//   played: [{ name: 'line-1', ms: 2000 }, ..., { name: 'line-6', ms: 3700 }],
//   missing: [] }
```

`played` 里的时长与上表对得上，就说明真正解码并播完了，而不是"配置看起来对"。

---

## 九、有字但故意不配音的字段

`en`（中央大字）· `log` / `logEn`（底部日志）· `btnZh` / `btnEn`（按钮）· `badge`（阶段计数）·
`brand1/2/3`、`orgZh/orgEn/orgSub`、`welcomeBox`、`footer`（品牌与页脚）。
