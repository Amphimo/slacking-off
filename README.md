# 摸鱼小窗

一个 390×760 的桌面无边框窗口，里面跑 B站 / 抖音 / 小黑盒（API 面板）和小红书（桌面窄屏响应式）。

## 下载安装（Windows 10/11 x64）

到 GitHub 仓库的 **Releases** 页下载：

- `slacking-off-<版本>-win-x64.zip`：免安装版。解压到任意目录，运行 `slacking-off.exe`。
- `slacking-off-<版本>-win-x64-setup.exe`：安装版。可以选安装目录，会创建桌面和开始菜单快捷方式；卸载默认保留登录数据。

程序没有购买代码签名证书，首次运行可能出现「Windows 已保护你的电脑」：点「更多信息 → 仍要运行」。少数杀毒软件也可能对未签名的 Electron 程序误报；不放心可以直接拉源码自行构建：

```bash
npm install
npm run dist
```

登录态和缓存保存在 `%APPDATA%\slacking-off`，不会上传。换机器前备份这个目录即可带走登录状态。

> 目前只提供 Windows x64 构建；macOS / Linux 需要自行 `npm start`，或补 electron-builder 对应平台配置。

## 先花两分钟验证可行性

不用装任何东西，用系统自带的 Edge 先看一眼效果：

```bat
quick-look.bat https://www.xiaohongshu.com/
```

抖音、B站、小黑盒现在都走 API 面板，不用再用网页版验证。

如果某个站点已经是竖版布局，说明它可以。正式版只是把这个过程自动化 + 修掉 Edge 命令行补不上的坑。

> 注意：浏览器命令行版的 `--user-agent` 骗不过所有站点（Chromium 会额外发 `Sec-CH-UA-*` 头，比 UA 更难伪装），这是正式版必须存在的原因之一。

## 运行

```bash
npm install     # 只装 electron，约 100MB，已配好国内镜像
npm start
```

首次打开每个站点，用手机扫码登录一次，之后长期保持登录（Cookie 存在各站点独立的 partition 里）。

## 实测结论（2026-10-18，tools/probe.js 自动探测 14 个候选入口）

伪装层本身已验证生效：B站/抖音走「iPhone 移动伪装」（`platform=iPhone`、`maxTouchPoints=5`、`userAgentData` 已抹除、`pointer:coarse` 命中），小红书反过来走「桌面伪装」（`platform=Win32`、去掉 touch）。各站差异来自**产品策略**，不是伪装问题：

| 站点 | 实测入口 | 形态 | 策略 |
| --- | --- | --- | --- |
| B站 | API 面板（不再嵌 `m.bilibili.com`） | ✅ 推荐流 + 站内播放器 + 评论/点赞/收藏 | 网页版点视频会引导下载 App / 跳 Microsoft Store；面板走 WBI 签名 API，复用 `persist:moyu_bili` 登录态 |
| 小红书 | `www.xiaohongshu.com/` | ✅ 桌面版窄屏响应式（≤695px 断点） | 桌面 UA 才有扫码登录、个人推荐、收藏/评论；移动 UA 会被降级成热门流+广告+下载 App 引导。下载浮条 CSS 清除，登录弹窗 85% 缩放 |
| 抖音 | API 面板（不再缩放桌面网页） | ✅ 竖屏沉浸流 + 搜索 + 评论 + 点赞/收藏 | 借用隐藏抖音页面的 `axiosInstance` 生成 `a_bogus/msToken`，播放直链交给原生 `<video>` |
| 小黑盒 | `www.xiaoheihe.cn/` | ⚠️ 仅官网落地页 | 社区 feed 是 App 专属接口，网页路线到头，见下节 |

## API 面板（已上线）

### 小黑盒

小黑盒社区 feed 是 App 专属接口，网页路线到官网落地页为止。现按 VSCode 插件 [WenfuRainbow/heybox](https://github.com/WenfuRainbow/heybox)（MIT）的路线走 App 协议：

- **签名**：`src/xhh/sign.js` —— MD5 + 自定义字母表 + GF(2⁸) 位变换矩阵，纯 Node crypto 零依赖；**2/2 官方测试用例通过**（U2XZI47 / 021TS00）
- **客户端**：`src/xhh/client.js` —— 公共参数伪装 web 客户端，`https://api.xiaoheihe.cn/bbs/app/*`
- **面板**：`src/panels/xhh.html/css/js` —— 本地 HTML 自绘卡片流（主进程 IPC 代理签名请求），无限滚动分页（实测 offset 分页零重复），点卡片展开全文+图片墙
- **匿名可用**：`/bbs/app/feeds` 无需登录（详情接口 `/bbs/app/link/tree` 需要，匿名调会 `show_captcha`；二期移植插件的扫码登录流程补上）
- 设备 ID 持久化在 `userData/xhh-config.json`

冒烟数据：单页 10 卡、首屏 40 图、渲染零报错。

### B站

网页版已不适合这个窗口：推荐流刷新不了、点视频会弹「下载 App」并尝试跳 Microsoft Store。现改走 B站 Web API 自绘面板：

- **签名**：`src/bili/wbi.js` —— nav 取 `wbi_img` key + 官方混淆表生成 `wts/w_rid`
- **客户端**：`src/bili/client.js` —— 主进程用 `persist:moyu_bili` 的 `session.fetch`，直接复用已有网页登录 cookie；扫码成功时解析 URL 里的 `SESSDATA / bili_jct / DedeUserID` 写回 session
- **面板**：`src/panels/bili.html/css/js` —— 双列推荐/热门 feed、顶部视频搜索、站内 `<video>` 播放、多 P 切换、评论分页、楼中楼、评论点赞、视频点赞、收藏夹
- **播放**：`/x/player/wbi/playurl` 用 `platform=html5&high_quality=1`，匿名实测拿 720P MP4，登录后由服务端给更高质量；所有图片/视频统一 `no-referrer`
- **搜索**：`/x/web-interface/wbi/search/type` 走 WBI 签名；搜索结果和推荐流共用双列卡片，可分页，取消后恢复原推荐浏览位置
- **我的**：读取收藏夹和默认收藏夹内容；退出时只清认证 cookie，保留 `buvid3` 等设备 cookie

匿名冒烟：推荐 12 卡、详情 1 集、播放 HTTP 206、关键词搜索 26 条。Electron 内登录态继承和播放需本地 `npm start` 目测。

### 抖音

抖音不能照 B站方式离线签名：直接请求 feed 会被风控，原样重放签名 URL 又失败。现采用「隐藏签名页 + 原生播放器」：

- **代理**：`src/douyin/bridge.js` 常驻一个不可见的抖音页面，复用 `persist:moyu_douyin` 登录态和页面内 `window.axiosInstance`；分区固定桌面 Chrome UA，避免默认 Electron UA 暴露 `Electron/33`
- **业务**：`src/douyin/service.js` 通过代理请求推荐 feed、视频详情、评论和搜索；推荐流用官方同款 `/aweme/v1/web/tab/feed/`（`module/feed` 登录后会变成关注/精选），响应中的 `video.play_addr.url_list` 是可直接播放的 MP4
- **面板**：`src/panels/douyin.html/css/js` —— 夜间放映厅 HUD 视觉：全幅视频 + 模糊封面背景 + 玻璃控件、顶部品牌栏、底部 NOW PLAYING 信息层、右侧独立圆形互动按钮、搜索双列卡片、评论抽屉、账号浮层；单视频竖滑、滚轮/拖拽切换、进度条、点赞/收藏（显示计数，乐观更新，失败回滚；未登录先提示登录）。切条是**双缓冲**：两个 `<video>` 交替，新地址先在闲置那层起播，旧视频保留最后一帧顶住画面，出帧后 260ms 交叉淡入，同时提前把下一条预加载进刚让位的那层，命中时几乎零等待。无外部字体/图片依赖，340px 宽仍不溢出
- **搜索**：打开搜索页会先暂停并快照当前推荐，关闭后恢复原视频与位置，避免后台 feed 继续切条/触发搜索重试；搜索卡支持 Enter/Space 打开；播放搜索结果时顶栏状态位变成「返回推荐」，Esc 同样可回主页；状态胶囊 3.2s 自动消失
- **登录**：未登录时点「登录」会显示代理窗口，扫码后无需手动刷新——面板轮询登录态，成功后自动隐藏按钮并重载推荐。登录是否有效以服务端 `user/profile/self` 返回 uid 为准；cookie 过期时头像会显示红圈并出现「重新登录」，点赞/收藏会先提示登录而不会假装成功（仅 cookie 存在不算已登录）；feed/评论可匿名，搜索需要登录态
- **账号 / 退出**：登录后顶部「登录」换成头像（头像加载失败回退昵称首字），点头像弹出账号卡（昵称 / UID）和「退出登录」；退出会清空 `persist:moyu_douyin` 的 cookies/localStorage/IndexedDB 并销毁签名页，随后匿名重载推荐
- **楼中楼**：主评论请求带 `reply_style=2`，展开回复走 `/comment/list/reply/`，作品参数按官方网页用 `item_id` + `cut_version=1`。该端点会被抖音下发 `x-vc-bdturing-parameters` 人机验证（HTTP 200 空 body，页面 XHR 一直不结束）；bridge 收到响应头就立即失败，面板改为「打开官方验证」：显示隐藏签名页，并调用页面自带的 `verifyCenter.autoRender` 弹出官方验证码，由用户本人完成，随后点「验证完成后点此重试」。不做验证码识别或自动点击；评论列表自带的 `reply_comment` 预览仍会展示。该挑战有时是临时的，隔一会儿直接重试也可能恢复
- **防导流**：代理窗口只允许在 `*.douyin.com` 内跳转，iframe 的自定义协议和微软商店链接也会被拦掉，签名页常驻静音
- **失败重试**：`play_addr.url_list` 里前几个 CDN 地址经常直接 403，播放和预加载都会按候选顺序换下一个地址（记在卡片上，并偏向本机上次成功的主机），全部失败才重新请求 detail；签名页异常时 request 自动重载一次；手动刷新不再串行等待登录态检查，旧视频会继续播到新 feed 返回

浏览器 stub 冒烟确认竖屏播放、上下切换、搜索分页、评论抽屉、楼中楼风控→官方验证窗口、刷新时旧视频保留，以及账号卡/退出登录（隐藏账号、恢复登录按钮、重载 feed）；切条衔接用隔离配置的 CDP 实例实测：连续切 3 条交接 1205ms / 1053ms / 24ms（最后一条命中预加载），全程 0 黑帧、0 控制台报错，快速连切 5 条后画面与队列条目仍然一一对应。官方验证码窗口在隔离实例中已实测能弹出「依次点击文字」官方题面；真实登录态下完成验证后重试是否直接放行需本地 `npm start` 验证。

## 其余一家的 API 面板评估（要不要跟进）

架构已经验证（签名代理 → IPC → 自绘面板），小红书技术上仍可行，但收益最低：

| 平台 | API 可行性 | 现状收益 | 结论 |
| --- | --- | --- | --- |
| 小红书 | 中：note 接口 x-s/x-s-common 签名有逆向实现，但实测有整体校验+防重放 | 桌面窄屏：扫码登录、个人推荐/收藏/评论 | 维持现状（纯 API 见 HANDOFF 历史坑 13） |

一句话：**抖音、B站都已 API 面板化，小红书等网页版哪天真用不了再迁**。迁移时每个平台一个 `src/<id>/service.js` + `src/panels/<id>.*`，套小黑盒/B站/抖音的模板即可。

已修复的关键 bug：**第一版用 `<webview>` 标签无法关闭 `contextIsolation`，preload 运行在隔离 world，对 `navigator` 的所有伪装改动页面根本看不到** —— 这就是当时四家齐刷刷让你下载 App 的原因。现改为主进程 `WebContentsView` + `contextIsolation: false`，伪装真正生效。

工具条上的「净化」按钮（三条渐短横线图标）会隐藏页面上「下载 / 打开App」类浮条，结果提示在窗口底部，手动触发避免误杀正常 UI。


## 为什么不能直接用网页版

| 问题 | 原因 | 这里的处理方式 |
| --- | --- | --- |
| 网页版是横版画布 | 站点按视口宽度决定布局 | 容器视口固定 ≤430px，强制走 mobile 断点；小红书桌面页自带 695px 窄屏断点，可直接用 |
| 改了 UA 仍被认出是桌面 | Chromium 的 User-Agent Client Hints (`Sec-CH-UA-Platform`) | 移动 UA 站点拦掉全部 `sec-ch-ua*` 头 + 抹掉 `navigator.userAgentData`；小红书走桌面 UA，保留 Client Hints 一致性 |
| 鼠标拖不动，滑不到下一个视频 | 移动页面只监听 touch 事件 | 启动时加 `--touch-events=enabled`，鼠标拖拽即成为 touch 手势 |
| `'ontouchstart' in window` 为假 | 能力检测泄露桌面身份 | `preload-site.js` 注入伪造 |
| 每次重启要重新扫码 | 共享了默认 session | 每站点独立 `persist:moyu_<id>` 分区 |
| 摸鱼被发现 | —— | `Ctrl+Alt+M` 一键隐藏窗口；工具条有不透明度按钮；拖动靠自绘标题栏 |

## 快捷键与操作

- `Ctrl + Alt + M`：隐藏 / 呼出窗口（全局生效）
- 工具条左一：后退（保留 App 内的返回语义）
- 工具条 `−` / `+`：调视口宽度。变窄 = 内容变大，也更容易让站点呆在移动断点里
- 工具条倒数第三个：窗口置顶开关（默认关闭，需要压在其他应用之上时再点开）
- 工具条倒数第二个：循环降低不透明度
- 工具条最后一个：清空当前站点登录态并重开（换号用）

## 目录

```
src/
  main.js           主进程：无边框窗口、老板键、session 隔离与 UA 注入
  preload-shell.js  外壳 UI 与主进程之间的桥
  preload-site.js   注入到每个站点里，按站点伪装成手机/桌面（关键文件）
  preload-panel.js  API 面板与主进程之间的 IPC 桥
  shell.html/css/js 自绘标题栏、平台标签、工具条、懒加载视图
  sites.js          站点清单、入口 URL、配色、UA —— 想加站点改这里
  xhh/              小黑盒协议：sign.js / client.js / service.js
  bili/             B站协议：wbi.js / client.js / service.js
  douyin/           抖音协议：bridge.js / service.js
  panels/           小黑盒、B站、抖音自绘面板
```

## 已知情况与调参

- **抖音**：已切竖屏 API 面板。首次加载会启动一个不可见签名页；搜索需要登录，点「登录」会临时显示该窗口，登录成功后面板自动同步并刷新，无需手动点刷新。
- **B站**：已切 API 面板，不再使用 `m.bilibili.com` 网页版；面板复用同一个 `persist:moyu_bili`，之前登录过就直接有登录态。
- **小红书**：桌面版窄屏响应式，打开就会弹扫码登录；登录后是个人推荐、收藏和评论。登录弹窗会自动缩到 85% 适配 390 宽。旧移动版 session 若表现异常，用工具条最后一个按钮重置。
- **小黑盒**：部分页面强登录，扫码一次即可。
- 站点清单里的 `note` 字段写了各自的坑，改 URL 或 UA 都在 `sites.js`。

## 如果这条路走不通，备选方案

1. **scrcpy 真机投屏**（推荐兜底）：`scrcpy --window-x 1490 --window-y 60 --window-width 390 --window-height 760 --always-on-top`。完美适配、支持纯 App 功能，代价是要连手机开 USB 调试，且这段时间手机被占用。适合把它做成一键脚本 `scrcpy-moyu.bat`。
2. **安卓模拟器**（MuMu / 雷电）：启动慢、占资源，但完全隔离，不占用自己的手机。
3. **混合**：常用站点走 Electron（轻、切换快），剩下只能在 App 里干的活交给 scrcpy。

三者可以共存，先跑 Electron 版，遇到硬骨头再叠 scrcpy。

## 免责声明

- 这是非官方客户端，与抖音、小红书、哔哩哔哩、小黑盒均无关联。
- 内容版权归原平台及作者所有；请遵守各平台服务条款，仅用于个人学习与自用。
- 本项目不提供验证码识别或风控绕过；遇到抖音人机验证时，需要你本人在官方验证窗口完成。
- 程序不收集或上传账号数据，登录 Cookie 只保存在本机 userData 目录；退出登录或清除站点数据即可删除。

## 许可

代码以 [MIT](LICENSE) 发布。小黑盒协议实现参考了 [WenfuRainbow/heybox](https://github.com/WenfuRainbow/heybox)（MIT），完整许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
