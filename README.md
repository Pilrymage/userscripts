# userscripts

个人用户脚本，推荐用 [Violentmonkey](https://violentmonkey.github.io/) 安装。点下面的链接即可安装，之后会自动检查更新。

| 脚本 | 说明 | 安装 |
|---|---|---|
| Readline 键位 | 网页输入框里的 readline / Emacs 键：Ctrl+A E P N F B K D（**Ctrl+P / Ctrl+N 按视觉折行上下移动，落点对齐原生 ↑/↓**），Alt+F B 按词移动、Alt+D / Alt+Backspace 按词删除（中文分词，连续标点单独算一个停靠点）；Alt+< > 跳到开头/结尾；Ctrl+J 换行（不会触发发送）。Ctrl+K 和 Alt 删词的内容写入剪贴板 | [install](https://raw.githubusercontent.com/Pilrymage/userscripts/main/readline-keys.user.js) |
| 图片屏蔽（文字优先） | 隔绝图片与视频封面，只留原尺寸虚线框和 alt 文字。全站默认开，Alt+Shift+I 一键全开本页，点击单张恢复原图，菜单里可按站点长期开关。拦 img / picture / video poster / CSS 背景，放过行内 SVG、canvas 和 .ico 图标 | [install](https://raw.githubusercontent.com/Pilrymage/userscripts/main/text-first-images.user.js) |
| NotebookLM 输入框加高 | 加高输入框、提示词菜单、加宽对话区、右侧浮窗快速跳转历轮对话（默认常开，窗口窄于 1000px 自动收起；条目可搜索、一键拉全懒加载的更早消息）等 | [install](https://raw.githubusercontent.com/Pilrymage/userscripts/main/notebooklm-taller-input.user.js) |

## Firefox：释放 Ctrl+N

Ctrl+N（新建窗口）是 Firefox 的保留快捷键，网页拦不到。`firefox-autoconfig/` 里的文件用 autoconfig 在启动时去掉它：

- `mozilla.cfg` 复制到 Firefox 安装目录（和 `firefox.exe` 同级）
- `defaults/pref/autoconfig.js` 复制到安装目录下的 `defaults/pref/`

然后重启 Firefox。Firefox 升级覆盖安装目录后需要重新复制。

## 测试

`tests/` 里是 Readline 键位与 NotebookLM 右侧浮窗的自动化测试，用本机 Chromium 通过 CDP 跑（不需要装 playwright/puppeteer）：

```powershell
node tests\visual-line.test.mjs   # 对照：Ctrl+P/N 落点 vs 原生 ↑/↓（逐位置采样）
node tests\invariants.test.mjs    # 不变量：行首↓/行尾↑/可逆
node tests\behavior.test.mjs      # 行为：连续上下、列保持、边界、单行 input、空内容
node tests\notebooklm-jump.test.mjs  # 浮窗：列条目/搜索/跳转/懒加载拉全（mock NotebookLM DOM）
```

Firefox 没有 CDP，用页面内自测代替：

```powershell
node tests\gen-ff-selftest.mjs
& "$env:USERPROFILE\scoop\apps\firefox-esr\current\firefox.exe" --headless --profile "$env:TEMP\ff" `
  --screenshot tests\ff-report.png --window-size 900,1200 "file:///D:/github/userscripts/tests/firefox-selftest.html"
```

关键实现细节（改之前务必看）：浏览器拿不到 textarea 的内部折行信息，所以脚本把文本和排版复制到隐藏镜像里让浏览器自己折行，再在镜像坐标里算视觉行。踩过的坑都写在脚本注释里：软折行点的归属、行尾 offset 是下一行行首、空行要按行高单独推、选点要用整数像素比较。

## 发布

改完脚本后调高 `@version` 再推送。Violentmonkey 根据 `@version` 判断是否有更新。
