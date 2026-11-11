# userscripts

个人用户脚本，推荐用 [Violentmonkey](https://violentmonkey.github.io/) 安装。点下面的链接即可安装，之后会自动检查更新。

| 脚本 | 说明 | 安装 |
|---|---|---|
| Readline 键位 | 网页输入框里的 readline / Emacs 键：Ctrl+A E P N F B K D；Alt+F B 按词移动、Alt+D / Alt+Backspace 按词删除（中文分词）；Alt+< > 跳到开头/结尾。Ctrl+K 和 Alt 删词的内容写入剪贴板 | [install](https://raw.githubusercontent.com/Pilrymage/userscripts/main/readline-keys.user.js) |
| NotebookLM 输入框加高 | 加高输入框、提示词菜单、加宽对话区等 | [install](https://raw.githubusercontent.com/Pilrymage/userscripts/main/notebooklm-taller-input.user.js) |

## Firefox：释放 Ctrl+N

Ctrl+N（新建窗口）是 Firefox 的保留快捷键，网页拦不到。`firefox-autoconfig/` 里的文件用 autoconfig 在启动时去掉它：

- `mozilla.cfg` 复制到 Firefox 安装目录（和 `firefox.exe` 同级）
- `defaults/pref/autoconfig.js` 复制到安装目录下的 `defaults/pref/`

然后重启 Firefox。Firefox 升级覆盖安装目录后需要重新复制。

## 发布

改完脚本后调高 `@version` 再推送。Violentmonkey 根据 `@version` 判断是否有更新。
