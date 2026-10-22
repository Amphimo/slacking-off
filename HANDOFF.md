# 项目交接 / 迁移手册

> 生成于 2026-10-20。这份文档包含把「摸鱼小窗」完整迁移到新机器所需的全部信息。

## 一、这是什么

`D:/my_tools/slacking_off` —— 桌面摸鱼工具，Electron 应用：

1. **网页模式**：390×760 无边框小窗里，小红书用**桌面 UA + 窄屏响应式**（扫码登录、个人推荐、收藏/评论），浮条自动隐藏
2. **API 面板模式**（小黑盒、B站、抖音）：不走普通网页浏览 —— 小黑盒逆向 App 协议；B站走 WBI Web API；抖音用隐藏签名页借用页面 axios。三者均自绘 feed/详情/评论/互动，抖音为竖屏沉浸播放

技术栈：Electron 33 + 原生 HTML/JS（无前端框架）。依赖只有 `electron` 和 `qrcode` 两个包。

## 二、迁移步骤

```bash
# 新机器上
git clone / 拷贝整个目录（node_modules 可不拷）
npm install          # .npmrc 已配 npmmirror 国内镜像，electron 二进制自动下
npm start
```

要求：Node ≥ 18（本机 22），Windows（用了部分 Win 语义，其他平台大概率也能跑）。

**迁移登录态（可选）**：小黑盒扫码登录态存在
`%APPDATA%\slacking-off\xhh-config.json`（含 cookie / heyboxId / 昵称 / deviceId）。
B站面板不单独存账号文件，直接复用 Electron 分区 `persist:moyu_bili`（网页登录 cookie 与 API cookie 同一份），要带走 B站登录就整份拷 `%APPDATA%\slacking-off`。
把 `%APPDATA%\slacking-off` 拷到新机器同路径，两个站点的登录态都能直接带走。

## 三、目录结构与职责

```
src/
  main.js            主进程：窗口、WebContentsView 管理、IPC、老板键、fitZoom 循环
  sites.js           ★ 站点清单（url/ua/type/color/note），加站点改这里
  preload-shell.js   外壳 UI 桥（contextIsolation:true，contextBridge）
  preload-site.js    ★ 网页伪装+净化脚本（注入到各网页站点）
  preload-panel.js   面板桥（xhh + bili + douyin IPC）
  shell.html/css/js  外壳：标题栏、平台 tab、工具条
  panels/xhh.*       小黑盒面板 UI（卡片流/详情/我的/登录弹层）
  panels/bili.*      B站面板 UI（双列卡片流/播放器/详情/评论/我的/登录弹层）
  panels/douyin.*    抖音面板 UI（夜间放映厅 HUD：竖屏播放器/搜索双列/评论抽屉/账号浮层）
  xhh/sign.js        ★ App 协议签名（MD5+字母表+GF(2⁸)矩阵，2/2 官方用例通过）
  xhh/client.js      ★ API 客户端（get/post/扫码登录/全部端点封装）
  xhh/service.js     ★ 业务层（feed 聚合去重、详情、收藏、消息、点赞）
  bili/wbi.js        ★ B站 Web API query 签名（nav wbi_img + 固定混淆表）
  bili/client.js     ★ B站 HTTP 封装（走 persist:moyu_bili session.fetch，复用网页 cookie）
  bili/service.js    ★ 推荐/热门、详情、playurl、评论、点赞、收藏夹
  douyin/bridge.js   ★ 隐藏抖音页面 + window.axiosInstance 签名代理（不离线重放 a_bogus）
  douyin/service.js  ★ 推荐 cards、搜索、aweme detail、评论、直链 MP4 映射
tools/
  probe.js           网页站点适配探测器（截图+诊断+浮条选择器抓取）
  panel-smoke.js     面板渲染冒烟（断言卡片数）
  xhh-test.js        小黑盒 API 连通性测试
  bili-test.js       B站 API 匿名回归（feed/详情/播放直链/二维码生成）
vendor/heybox/       参考实现（WenfuRainbow/heybox，MIT），签名测试 fixture 在里面 —— 别删
quick-look.bat       零依赖验证脚本（Edge app 模式）
shots/               probe 输出（可删）
```

★ = 改动时需要理解协议/历史坑的文件。

## 四、API 端点备忘（全部实测）

### 小黑盒

Base：`https://api.xiaoheihe.cn`。所有请求带公共参数（os_type=web, app=heybox, client_type=web, version=999.0.4, x_client_type=web, x_app=heybox_website, heybox_id, x_os_type=Windows, device_info=Chrome, device_id）+ 签名三件套（hkey/_time/nonce，签名只对 path）。

| 端点 | 方法 | 参数 | 说明 |
| --- | --- | --- | --- |
| `/bbs/app/feeds` | GET | offset(数字累加), pull, dw=800 | 推荐 feed，**匿名可用**，10条/页 |
| `/bbs/app/topic/categories` | GET | - | 板块树（5 分类 67+ 子板块，children[].topic_id，hot.desc 排序） |
| `/bbs/app/topic/feeds` | GET | topic_id, offset, limit=20 | 板块帖子，19条/页，**无 lastval** |
| `/bbs/app/link/tree` | GET | link_id, offset, limit | 帖子树：正文 + 评论组。**需登录**（匿名 show_captcha） |
| `/bbs/app/comment/sub/comments` | GET | root_comment_id, lastval | 楼中楼，10条/页，has_more+lastval 游标 |
| `/bbs/app/profile/fav/folders` | GET | - | 收藏夹列表（id/name/count/is_default） |
| `/bbs/app/profile/fav/folder/v2/links` | GET | **folder_id 必填**, offset, limit | 收藏内容，item.link 结构 |
| `/bbs/app/user/message` | GET | list_type=0, offset, limit | 消息，结果在 **result.entries**（不是 message_list！） |
| `/bbs/app/profile/award/link` | POST | body: link_id, award_type=1/0 | 帖子点赞/取消（同端点 toggle） |
| `/bbs/app/comment/support` | POST | body: comment_id, support_type=1/0 | 评论点赞/取消。**没有** /comment/up 等端点 |
| `/bbs/app/link/favour` | POST | body: link_id（收藏）/ favour_type=2, link_id, folder_id, userid（取消） | 收藏/取消**同端点**，`favour_type` 1=收藏 2=取消；取消必带默认收藏夹 folder_id |
| `/account/get_qrcode_url/` | GET | 匿名参数(app=web, heybox_id 空) | 扫码登录第一步，返回 qr_url |
| `/account/qr_state/` | GET | qr_url 里的 query 参数 | 轮询扫码状态，成功时响应 Set-Cookie 即凭证 |

数据形态坑：**正文 `link.text` 是 JSON 块数组**（`[{"type":"text","text":..},{"type":"img","url":..}]`，img 块里还有个 text 字段存本地路径须忽略），不是 HTML —— `renderRich()` 统一处理。消息字段是 `comment_a_text`(对方)/`link_title`/`user_a`/`linkid`。

### B站

Base：`https://api.bilibili.com`。推荐、播放等 WBI 接口先从 `/x/web-interface/nav` 的 `wbi_img.img_url/sub_url` 取 key，再用固定混淆表生成 `wts` + `w_rid`。写操作必须带 `csrf=bili_jct`。

| 端点 | 方法 | 参数 | 说明 |
| --- | --- | --- | --- |
| `/x/web-interface/nav` | GET | - | 登录态 + WBI key；匿名返回 `-101` 但仍给 key |
| `/x/web-interface/wbi/index/top/feed/rcmd` | GET | signed: fresh_idx/fresh_idx_1h 递增等 | 推荐流，实测 12条/页、匿名可用、递增 idx 不重复 |
| `/x/web-interface/popular` | GET | pn/ps | 热门兜底 |
| `/x/web-interface/wbi/search/type` | GET | signed: search_type=video/keyword/page/page_size=30 | 视频搜索；`result` 含 HTML 高亮标题，需 strip；`numPages` 分页 |
| `/x/web-interface/view` | GET | bvid | 标题/UP/aid/stat/pages，无签名可用 |
| `/x/player/wbi/playurl` | GET | signed: bvid/cid/qn=80/platform=html5/high_quality=1 | `durl[].url` 直链；匿名实测 720P MP4，登录后可更高质量 |
| `/x/v2/reply` | GET | type=1/oid=aid/pn/ps/sort=2 | 主评论；旧接口仍返回可刷页数据 |
| `/x/v2/reply/reply` | GET | type=1/oid/root/pn/ps | 楼中楼分页 |
| `/x/web-interface/archive/relation` | GET | bvid | 自己的 liked/favorite/coin 状态，需登录 |
| `/x/web-interface/archive/like` | POST | bvid, like=1/2, csrf | 点赞/取消 |
| `/x/v2/reply/action` | POST | oid, type=1, rpid, action=1/0, csrf | 评论点赞/取消 |
| `/x/v3/fav/folder/created/list-all` | GET | up_mid, 可带 rid+type=2 | 收藏夹；带 rid 时列表项可给 `fav_state` |
| `/x/v3/fav/resource/deal` | POST | rid=aid, type=2, add_media_ids, del_media_ids, csrf | 加/删收藏 |
| `/x/v3/fav/resource/list` | GET | media_id/pn/ps | 收藏夹内容，结果在 `data.medias` |
| `/x/passport-login/web/qrcode/generate` | GET | source=main-fe-header | 二维码 URL + `qrcode_key` |
| `/x/passport-login/web/qrcode/poll` | GET | qrcode_key | data.code: 0成功 / 86101等待 / 86090已扫 / 86038过期；成功 URL 带认证 cookie |

登录态策略：`BiliService` 使用 Electron `persist:moyu_bili` 的 `session.fetch`，因此网页登录、面板 API 和播放请求共享 cookie；面板扫码成功后还会把 URL 中的 `SESSDATA/bili_jct/DedeUserID` 显式写回 session。退出只清认证 cookie，不清设备 cookie。

### 抖音

Base：`https://www.douyin.com`。不要离线构造/重放 `a_bogus`、`msToken`、`uifid`：直接请求会 404 `Unsupported path(Janus)`，完整签名 URL 重放同样失败。

代理方式：`DouyinBridge` 创建 `show:false` 的隐藏 BrowserWindow，加载 `https://www.douyin.com/?recommend=1`，等待页面里的 `window.axiosInstance` 就绪。业务请求通过 `webContents.executeJavaScript()` 调用：

```js
window.axiosInstance.request({ method, url, params, withCredentials: true })
```

页面的 request interceptor 会补齐公共参数并签名。`persist:moyu_douyin` 固定桌面 Chrome UA（`DESKTOP_UA`）——默认 Electron UA 会带 `Electron/33`，更容易触发风控；Client Hints 仍由 Chromium 发送。

| 端点 | 方法 | 参数 | 说明 |
| --- | --- | --- | --- |
| `/aweme/v1/web/tab/feed/` | GET | count,refresh_index,tag_id,pull_type,video_type_select,aweme_pc_rec_raw_data,filterGids | 官方「推荐」流，返回 `aweme_list[]` |
| `/aweme/v1/web/aweme/detail/` | GET | aweme_id,request_source=600,origin_type=video_page | `aweme_detail.video.play_addr.url_list` 可直接给 `<video>`，实测 Range 206 |
| `/aweme/v1/web/general/search/single/` | GET | keyword,search_channel,offset,count | 需登录；未登录 code 2483 |
| `/aweme/v1/web/comment/list/` | GET | aweme_id,cursor,count,item_type=0 | 主评论，支持 cursor 分页 |
| `/aweme/v1/web/comment/list/reply/` | GET | **item_id**（作品 id）,comment_id,cut_version=1,cursor,count,item_type=0 | 楼中楼；Electron 下常被 bdturing 风控，见坑 25 |
| `/aweme/v1/web/user/profile/self/` | GET | publish_video_strategy_type=2,source=channel_pc_web,personal_center_strategy=1 | 登录态；未登录 code 8 |
| `/aweme/v1/web/commit/item/digg/` | POST | aweme_id,type=1/0 | 点赞 / 取消；需登录，code 8 = 未登录 |
| `/aweme/v1/web/aweme/collect/` | POST | aweme_id,action=1/0 | 收藏 / 取消；需登录，code 8 = 未登录 |

所有业务请求统一由 `service.call()` 合并 `device_platform=webapp&aid=6383&channel=channel_pc_web`——页面 axios 拦截器**不会**补这三个。`module/feed` 也能返回视频，但登录后内容会变成关注/精选，不能当推荐流用。

播放地址带 `x-expires`，过期后 error 事件触发 detail 重取。搜索/登录窗口都复用 `persist:moyu_douyin`；`showLogin()` 只是把原本隐藏的签名代理窗口显示出来。

## 五、历史坑（新环境出问题先查这里）

1. **`ELECTRON_RUN_AS_NODE=1`**：宿主终端（VS Code/WorkBuddy）可能注入，electron 退化成纯 Node，`require('electron').app` 为 undefined。main.js 顶部有自愈（检测后清环境变量 spawn 重启）。
2. **webview 标签不能关 contextIsolation**：preload 修改 navigator 在隔离 world 里页面看不到 —— 必须用 `WebContentsView` + `contextIsolation: false`（网页站）。这是 v1 全线"要求下载App"的根因。
3. **`--touch-events=enabled`** 必须在 app ready 前 appendSwitch，否则移动页的手势全失效。
4. **`sec-ch-ua*` 头**比 UA 更容易暴露桌面身份，webRequest 里全删 + preload 抹 `navigator.userAgentData`。
5. **`OverlayScrollbar`** feature 防滚动条挤占视口（390 → 376 会掉出移动断点）。
6. **面板 vs 网页站的 preload 分工**：面板（自己代码）contextIsolation:true；网页站（要改页面世界）false。别搞反。
7. **preload-shell / preload-panel 的 IPC handler** 增删时要同步 main.js 三处（handle + preload + 调用）。
8. **异步 IPC 桥**：`window.panel.me()` 返回 Promise，别同步读属性（v1 详情页 bug 的教训）。
9. CSS：`#detailBody img` 全局 max-width 限宽时**必须排除头像**（`:not(.cava)`），否则头像被拉伸。
10. **测试遗留（已清理）**：早期测试收藏的帖子已用 `favour_type=2` 取消，默认收藏夹无残留。
11. **详情页 z-index 必须高于「我的」页**：`#detail` 20 < `#mePage` 30 时，从收藏/消息点开的帖子被「我的」页整个盖住，看起来像"点不开"。现为 detail 35 / mePage 30 / imgViewer 40 / loginLayer 50，动层级时看全这四个。
12. **点赞数字段**：feed 与收藏列表里 `up` 恒为 0，真实点赞数在 `link_award_num`（详情页是 `award_num`），`toCard()` 按 `likes → link_award_num → award_num → up` 取值。
13. **小红书不能照搬 xhh 的 API 面板路子**（2026-10-20 实测）：手动给首页/详情构造 X-s 请求返回 406；把网页自己发出的完整签名请求（含 X-S-Common / x-rap-param）原样重放返回 461「账号异常」；而网页自身的 homefeed、feed、comment 请求全部 200。签名、指纹头、请求体是一套整体校验且有防重放，纯 API 需要持续逆向（社区反馈算法约 45 天更新一次）。真要做只能走「隐藏真实页面 → 驱动滚动/点击 → 捕获响应 → 原生 UI」的混合方案，成本和脆弱性都高；当前网页模式已能看评论/点赞/收藏，暂不迁移。
14. **小红书必须用桌面 UA**（2026-10-20）：移动 UA 会被小红书降级成「热门视频 + 广告 + 下载 App 引导」，且没有登录入口。现为桌面 Chrome UA + 页面自带 695px 窄屏断点；`preload-site.js` 对 xhs 单独注入桌面伪装（Win32 / maxTouchPoints 0 / 删掉 touch 属性），其他站仍走 iPhone 伪装。登录弹窗固定 440px 宽，390 视口下用 `@media (max-width:460px) { [class*="login-container"] { zoom:.85 } }` 缩放。旧移动 partition 的 storage 若导致异常，用工具条重置按钮清一次。
15. **B站不要再用 m 站网页路线**（2026-10-20）：网页版推荐刷新失效，点视频会触发 App 引导并尝试打开 Microsoft Store。现改 API 面板；推荐/playurl 要 WBI 签名，写操作要 `bili_jct`。播放用 `platform=html5&high_quality=1` 取 `durl`，不要拿 DASH 自己拼流。面板请求使用 `persist:moyu_bili.session.fetch` 复用登录 cookie；图片/视频统一 `referrerpolicy="no-referrer"`，否则浏览器可能把本地来源 Referer 发给 B站 CDN。
16. **B站收藏夹 id 与网页端字段不同**：`created/list-all` 的标题字段是 `title`，不是 `name`；带 `rid` 时才有 `fav_state`。收藏写入默认选列表第一个（通常即默认夹），取消时优先删所有 `fav_state=1` 的夹。未登录 relation 返回 `-101`，按未互动处理而不是报错。
17. **B站搜索标题带 HTML 高亮**：`search/type` 返回 `<em class="keyword">...</em>`，入库前必须 strip；`duration` 是 `分:秒` 或 `时:分:秒` 字符串，feed 是秒数，`parseSeconds()` 统一。面板 `renderCards(true)` 只能追加 `cards.slice(renderedCount)`，不能每次重新追加整个数组；feed/search 还要各自按 `bvid` 去重。
18. **双列网格必须写 `grid-auto-rows:max-content`**：`#list` / `#meBody` 是有固定高度的滚动容器，Chromium 会把默认 `auto` 行拉伸到可用空间；卡片又有 `overflow:hidden`，结果封面撑高、下方标题/UP/播放量整个被裁掉，看起来像"双列后文字消失"。显式 `max-content` 后行高按内容计算。
19. **抖音签名不能离线重放**：直接 fetch/XHR 调 feed 会 404 Janus，复制页面完整签名 URL 也只成功一次，重放同样失败。当前唯一稳定路线是隐藏页面借用 `window.axiosInstance`。推荐流要用 `/aweme/v1/web/tab/feed/`（官方「推荐」页同款，返回 `aweme_list[]`）；`/aweme/v1/web/module/feed/` 也能出视频，但登录后会偏向关注/精选。切换视频时给每个 `<video>` 分配 `__epoch`，并给 `next()` 做 450ms 防抖，否则旧 media 的 `ended` 会连跳多条（双缓冲细节见坑 31）。
20. **隐藏抖音页必须拦截外部跳转和楼中楼要单独拉**：页面会尝试 `window.open`、`ms-windows-store:` / `snssdk1128:` 自定义协议，以及 `https://apps.microsoft.com` 链接引导下载客户端。只在 `will-navigate` 拦非 http 不够：子帧走 `will-frame-navigate`，https 商店链接要再在 `webRequest.onBeforeRequest` 取消。现顶层只允许 `*.douyin.com`，子帧只放行 http(s)/about/blob/data，签名窗口常驻 mute。评论默认只带少量 `reply_comment`，主评论请求要加 `reply_style=2`；楼中楼走 `/aweme/v1/web/comment/list/reply/`，按官方网页的请求用 **`item_id`**（作品 id，不是主评论的 `aweme_id`），并带 `cut_version=1`。该端点偶发被服务端挂起（匿名实测官方页面自己的请求也 pending，几分钟后自行恢复），所以 bridge 请求必须有 15s `AbortSignal` + Node 侧超时兜底，否则面板永远停在「加载中」。
21. **登录按钮要轮询、切站要暂停媒体**：抖音登录窗口和签名代理是同一个窗口，登录成功没有事件回调；面板点「登录」后必须轮询 `douyin:me`（2s 一次，5 分钟上限）来隐藏登录按钮并自动刷新推荐，否则登录成功仍显示「待登录」。切换站点只 `removeChildView` 不会暂停播放，`showSite()` 移出旧视图前要执行 `PAUSE_MEDIA_JS` 暂停所有 `video/audio`，老板键隐藏窗口时同理，否则切到小黑盒后原页面还在出声。
22. **抖音刷新不要串行等登录态、也不要先清屏**：抖音 feed 服务端本身约 2s，`refreshBtn` 里再 `await refreshIdentity()` 会多等一次 `/profile/self`。登录态检查改成 fire-and-forget，spinner 只跟随 feed；登录态由点登录后的轮询负责同步。刷新时保留旧队列和当前视频继续播，等新 feed 返回再整体替换，否则会先黑屏「正在准备抖音推荐...」再等 2 秒，体感比别家面板慢。
23. **登录成功按钮不消失的根因是公共参数**：页面 `axiosInstance` 的拦截器只补指纹参数，不补 `device_platform/aid/channel`；`user/profile/self` 缺这些（以及 `publish_video_strategy_type=2&source=channel_pc_web&personal_center_strategy=1`）会被判未登录。现在 `service.call()` 统一合并公共参数，并额外用持久分区 cookie（`sessionid/sessionid_ss/sid_tt/sid_guard`）兜底判断——登录页还没跳回抖音、接口暂时调不通时也能在 2s 轮询内隐藏登录按钮。
24. **登录后要有账号入口和退出**：抖音登录没有回调，cookie 落盘后按钮会一直隐藏，用户无法确认登录态也无法换号。现在登录后顶部改显头像按钮（加载失败回退昵称首字），点头像弹 `#accountSheet`（昵称/UID + 退出登录）。`bridge.logout()` 清 `cookies/localstorage/indexdb/cachestorage/serviceworkers` + `clearCache()` 并销毁签名页，面板退出后立即 `identity={loggedIn:false}`、隐藏账号、显示登录按钮、清 `savedFeed` 并重载匿名推荐；下次请求会重新启动干净分区的签名页。
25. **楼中楼失败不是参数问题，是 bdturing 人机验证**：`/comment/list/reply/` 在 Electron 下会返回 HTTP 200 + `Content-Length: 0`，响应头带 `x-vc-bdturing-parameters`（base64 JSON：`type=verify,subtype=text,verify_event=6131,login_status=0`）。页面里的 XHR 不会结束，直到 axios 的 `AbortSignal` 15s 超时，抛出的 `CanceledError` 只有 `__CANCEL__:true` 和 `message:"canceled"`（没有 `code`），所以旧版会原样显示 `Error: canceled`。已确认：换参数组合、带不带 `aweme_id/item_id`、换视频/评论、真实登录 cookie、普通 Chrome UA、打开视频页作 Referer 都仍被挑战；`user/profile/self` 同时是 200 登录态，说明不是登录问题。**不要尝试绕过风控**；`bridge` 现在监听该响应头，收到就立刻以 `BDTURING` 失败（约 6s）。面板按钮变「打开官方验证」：`showVerify()` 把隐藏签名页显示出来，并等页面 SDK 把刚收到的参数写进 `__VERIFY_CENTER_RUNTIME__.myOptions.verify_data`，再调用抖音自己的 `verifyCenter.autoRender` 渲染官方验证码——只把官方 UI 交给用户，不做识别、自动点击或伪造签名。官方 SDK 有时会在窗口可见后自己弹出（`window.__vc_is_render__` 为 true），所以先检查再调用；渲染全程 best-effort，失败只写日志，不阻塞窗口显示。用户完成后回到面板点「验证完成后点此重试」，成功则 `hideVerify()` 调 `closeCaptcha()` 清掉遮罩并隐藏窗口。注意挑战可能是临时的：匿名实测第一次请求触发 bdturing，隔一会儿直接重试就恢复，不一定每次都需要人工过码。评论列表自带的 `reply_comment` 预览仍可用。
26. **暂停后点击无法恢复是 pointerup + click 双触发**：`#playOverlay` 在 `#stage` 内，点它既冒泡到 stage 的 `pointerup`（`togglePlay()`），又触发 overlay 自己的 `click`（又 `togglePlay()`），播放/暂停互相抵消，看起来「点击无反应」。已删掉 overlay 的 click 监听，只保留 stage 的 pointerup 作为唯一开关；overlay 不需要阻止指针事件，事件会正常冒泡。
27. **抖音点赞/收藏写端点要 POST，且初始状态拿不到**：点赞是 `POST /aweme/v1/web/commit/item/digg/`（`aweme_id` + `type` 1/0 + `item_type`），收藏是 `POST /aweme/v1/web/aweme/collect/`（`aweme_id` + `action` 1/0 + `aweme_type`），均来自官方 web bundle；GET 会返回 `url doesn't match`，`/commit/item/collect/` 是 404 Janus，`/aweme/favorite/` 会触发 bdturing，都不要用。写接口用假 id 探测可返回 `status_code:4`（服务端拒绝）确认端点存在；未登录返回 `code 8`，`service.write()` 映射为「登录已失效，请重新登录」。detail 接口**不返回** `is_digg/is_collect`，feed 卡片只有计数（`liked/collected` 默认 false），所以面板从 false 起步、点击时乐观 ±1，失败回滚；对已点赞作品首次点击可能只是把本机状态校准成已点赞（服务端幂等），计数可能差 1。
28. **抖音 cookie 在 ≠ 已登录**：`isLoggedIn()` 只看 `sessionid/sid_tt` 等 cookie 是否存在，cookie 过期后仍返回 true。曾出现面板显示「已登录」，但点赞/收藏/搜索全部返回 code 8，点击后乐观 +1 又立刻回滚，看起来像按钮没反应。现在 `me()` 只有在 `user/profile/self` 返回 uid 时才带 `verified: true`；仅 cookie 兜底时 `verified: false`，面板显示「登录已失效」红圈头像 + 「重新登录」按钮，并**阻止点赞/收藏的乐观更新**。写接口返回 code 8 也会即时把登录标成失效并提示重新登录。判断登录态时不要把 cookie 存在当成服务端认可。
29. **状态胶囊必须自己超时清除**：2026-10-21 视觉重做后 `loadSearch()` 用 `statusText()` 显示「搜索失败」，但 `statusText()` 旧实现没有定时器，只有下一次 feed 成功才覆盖，导致搜索页顶部 toast 永久停留。现在 `statusText()` 统一 3.2s 自动清空，并用 timer token 防止旧定时器清掉新消息；`flash()` 直接复用它。以后新增提示不要绕过 `statusText()`，也不要用 `statusText()` 显示需要一直可见的加载态。
30. **打开搜索页要暂停 feed，搜索结果播放态要能回主页**：视频 `ended` 后仍会调用 `next()`/`loadMore()`，搜索页盖住舞台时后台仍在换条并触发状态/重试，表现为「页面没动但 toast 反复出现」。`openSearchPage()` 现在快照 `queue/index/playing` 并暂停当前视频，`closeSearchPage()` 恢复快照，只在原来播放时才继续播。点搜索卡后 `mode` 仍是 `search` 但 `searchPage` 已隐藏，旧 Esc 只在页面可见时生效，导致播放搜索结果后无路返回；现在顶栏状态胶囊的位置由 `syncNav()` 切换成 `#backHomeBtn`（「返回推荐」），Esc 只要 `mode === 'search'` 就调用 `closeSearchPage()`。重做视觉时还必须保留所有旧 DOM id（`stage/player/searchPage/commentSheet/accountSheet` 等），JS 直接按 id 取节点。
31. **抖音切条必须双缓冲，单 `<video>` 换 src 一定卡顿**：换 `src` 会立即清空当前帧，新地址要等下载 + 首帧解码才出画面，这段空白就是「衔接卡顿」。现在舞台是四层（`#player` / `#playerB` / `#imagePlayer` / `#poster`，CSS 只给 `opacity:0`，靠 `.on` + 内联 `zIndex` 决定谁在前），`showVideo()` 把新地址挂到闲置的 `<video>` 上先 `play()`，旧视频只 `pause()` 保留最后一帧顶在屏幕上，等 `playing` 触发 `completeSwap()` 才交叉淡入（260ms）并关掉封面兜底，所以任何时刻都至少有一层是亮的。要点：① `completeSwap()` 之后 `schedulePrime()`（默认 340ms，等淡出结束）把 `queue[index+1]` 预加载进刚让位的元素，命中时实测交接 9–24ms；② 每个元素带 `__epoch`，`playing/pause/ended/error` 全部先判 `v === activeVideo || v === pendingVideo`，否则旧事件的 `ended` 会连跳、交接被打断后会把错误的一条顶上来；③ 交接期间 `togglePlay()`/`seekFromEvent()` 直接返回，避免操作到已经让位的元素；④ 图集/首帧/出错才用 `#poster` 兜底，正常切条不显示封面。`prefers-reduced-motion` 会把过渡压成 0.001ms，等于硬切，不需要额外分支。
32. **抖音 `playUrls` 前几个地址经常直接 403**：feed/search 卡片的 `video.play_addr.url_list` 通常给 3 个地址，`v26-web-prime/v11-web-prime.douyinvod.com` 这类常返回 403（`MEDIA_ERR_SRC_NOT_SUPPORTED`），`/aweme/v1/play/` 端点会 302 到带签名的可用地址，但落点主机也会随机翻车。旧逻辑只用 `playUrls[0]`，撞墙后要等一次 `douyin:detail` IPC 往返才换地址，是切条慢的另一半原因。现在 `playUrlFor(item)` + `nextCandidate(item)` 记录 `_urlIdx/_tried`，失败就在页内直接换下一个候选（预加载阶段失败由 `handlePreloadError()` 处理，不打断当前播放），全部试过才回落到 `detail`，再不行才自动跳下一条；`completeSwap()` 成功后把可用主机记进 `goodHost`，后续条目优先选它。注意别改成固定优先某个主机：实测把 `/aweme/v1/play/` 写死成首选反而更慢，学习式偏好才稳。给默认 session 注入 `Referer: https://www.douyin.com/` 不解决问题（`webRequest` 监听器对 Media 请求没生效，403 依旧），不要往那个方向做。

## 六、当前功能状态

| 能力 | 状态 |
| --- | --- |
| B站（API 面板）| ✅ 双列推荐/热门、关键词搜索、站内播放、详情、评论分页、楼中楼、点赞、收藏、收藏夹；复用网页登录 cookie |
| 小红书（桌面窄屏）| ✅ 扫码登录、个人推荐/收藏/评论，下载 App 浮条已净化 |
| 抖音（API 面板）| ✅ 竖屏推荐流、搜索（需登录）、双缓冲直链播放（预加载下一条 + 交叉淡入，无黑帧）、评论、点赞/收藏（含取消）；隐藏页面代理签名，登录态自动同步，账号卡可退出登录；楼中楼受 bdturing 风控时可打开官方验证窗口人工完成，再重试 |
| 小黑盒 feed | ✅ 匿名可刷，多源聚合+去重，无限滚动 |
| 小黑盒登录 | ✅ 扫码 + 磁盘持久化（跨启动） |
| 帖子详情/评论/楼中楼展开 | ✅ |
| 帖子/评论点赞 | ✅ 含取消 |
| 收藏 | ✅ 添加 / 取消 |
| 消息中心 | ✅ 只读 |
| 老板键 Ctrl+Alt+M / 置顶（默认关闭，可手动开启） / 透明度 | ✅ |

### 抖音面板视觉规范（2026-10-21 重做）

- **方向**：夜间放映厅 + HUD。全幅视频/图集是舞台，模糊封面铺底；控制、信息、互动全部用半透明玻璃层浮在上面，不再有实心工具栏。
- **色板**：墨黑 `#05050a`、米白 `#f6f5f1`、抖音红 `#fe2c55`、亮红 `#ff4d6d`、青 `#25f4ee`、琥珀 `#ffc300`；红青作点缀，不做大面积渐变。
- **字体**：UI 用 `Segoe UI Variable Display` + `Microsoft YaHei UI`；数字/微标签用 `Bahnschrift`/`DIN Alternate`。全部系统字体，无外部资源。
- **层级**：舞台 0–10（视频双缓冲 `#player`/`#playerB` + 图集 `#imagePlayer` + 封面兜底 `#poster` 四层同位叠放，只有 `.on` 的一层可见）、顶栏 20、搜索页 40、遮罩 50、评论 60、账号 70、toast 80。评论抽屉高 68%，账号卡是顶部浮层，均支持 Esc 关闭。
- **结构**：顶栏品牌 + 状态胶囊（播放搜索结果时切换为「返回推荐」）+ 玻璃图标按钮；底部 NOW PLAYING 作者/文案/话题/音乐；右侧 40px 独立圆形玻璃按钮（赞/藏/评，计数悬在圆钮下方），「下一条」为 32px 弱化圆钮，不再使用外层大胶囊；进度条只在视频显示。搜索页为双列 3:4 封面卡；空/错/骨架状态统一。
- **响应式**：`max-width:370px` 隐藏「抖音」字标和青点、压缩顶栏按钮；393×686 与 340×684 实测无横向溢出。

## 七、遗留 TODO（按价值排序）

1. **评论分页**：`has_more_floors` / `total_page` 字段已有，做"加载更多评论"
2. **表情包**：`[cube_xxx]` 文本标记，可做映射表替换成图片或 emoji
3. **feed 下拉刷新手势**（现在只有右下角刷新按钮）
4. **面板增强**：抖音关注（写端点需真实登录态验证）、B站历史/稍后再看/投币；小红书仍维持网页模式（见历史坑 13/14）
5. 打包成 exe（electron-builder）+ 开机自启

## 八、验证手段（改完代码怎么确认没坏）

```bash
node --check src/**/*.js               # 语法
node tools/xhh-test.js                 # 小黑盒 API 连通（匿名）
node tools/bili-test.js                # B站 feed/搜索/详情/播放直链/二维码（匿名）
# 抖音依赖 Electron 隐藏页面，无法在纯 Node 跑；改面板后用浏览器 stub 探针或 npm start 冒烟
env -u ELECTRON_RUN_AS_NODE node -e "..." # 带登录态的业务验证（读 userData 配置）
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tools/panel-smoke.js
npm start                              # 全量冒烟
```

注意：Windows 上 Electron GUI 进程的 console.log 不进 stdout，诊断一律写文件；Electron 探针类脚本批跑要加外部 timeout（小红书页面会偶发挂起）。

## 九、日常工作日志

`.workbuddy/memory/2026-10-18.md` 与 `2026-10-20.md` 有完整的开发时间线（含每次踩坑的根因分析），迁移后遇到"为什么当时这么写"可以翻这两份。
