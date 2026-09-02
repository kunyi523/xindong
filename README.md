# 后台

网站本身是纯静态的，没有这个后台也能完整使用——评分会先存在自己手机上，
等后台上线之后自动补交。这个后台只做前端做不到的两件事：
**把所有情侣的评分合并起来**，以及**让两个人共用同一张足迹地图**。

## 部署：点一下就好（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kunyi523/Date/tree/main/server)

这个按钮做的事：在**你自己的** Cloudflare 账号里建好 Worker、自动开一个 D1 数据库、
建好表、配好每次 push 自动部署。**不需要把任何密钥交给别人**，也不用装命令行工具。

点完会得到一个地址，形如 `https://xindong.你的账号.workers.dev`。
拿它这样打开网站验证一下：

```
https://kunyi523.github.io/Date/?api=https://xindong.你的账号.workers.dev
```

进设置看到「共一张地图」那一栏不再说"要先把后台跑起来"，就是通了。
之后把这个地址填进 `index.html` 里 `API` 那一段的 `base` 默认值，就不用每次带 `?api=` 了。

部署完建议换一下 IP 哈希用的盐（`wrangler.toml` 里那个 `IP_SALT`）：

```bash
npx wrangler secret put IP_SALT
```

> 这个按钮偶尔会出问题（Cloudflare 自己的 issue #14553：有时新建的仓库只有两个文件、
> Worker 停在 Hello World）。如果碰上了，用下面的命令行方式，两分钟。

## 部署：命令行

```bash
npm i -g wrangler
wrangler login

cd server
npm install
wrangler d1 create xindong                 # 把返回的 database_id 填进 wrangler.toml
npm run deploy                             # 建表 + 发布
```

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/reviews` | 交一条评分 |
| `GET` | `/places?ids=…&mbti=…` | 按地点取合并后的分数 |
| `GET` | `/cards?lat=&lon=` | 把评分高的真实地点反过来喂回抽卡 |
| `GET` | `/weather?lat=&lon=` | 代理 open-meteo，让前端只认一个域名 |
| `POST` | `/couple` | 上传"我这半张"足迹（整份覆盖，幂等） |
| `GET` | `/couple?id=&by=` | 读回对方那半张 |
| `GET` | `/sweet` | 占位，以后接模型写情话 |

`GET /places` 返回：

```json
{ "places": { "osm:node/123": {
  "n": 42, "score": 4.4,
  "match": { "n": 9, "score": 4.7 },
  "dims": { "quiet": 0.8, "pair": 0.9, "linger": 0.6, "photo": 0.7, "noqueue": 0.4 },
  "tags": [["纪念日", 12], ["第一次约会", 7]],
  "cost": "小奢侈",
  "quotes": ["靠窗那一桌可以坐很久"]
} } }
```

`match` 是「和你们 MBTI 接近的情侣」那一档：把一对情侣在 E/I、S/N、T/F、J/P
四个轴上的倾向各算一个字母（两人一致取该字母，不一致记 `?`），四个轴里至少三个
对得上才算接近。少于 3 对就不显示，避免一两条评分被当成结论。

## 自测

```bash
cd server && npm i && npm test
```

用 sql.js 在内存里冒充 D1，直接跑真正的 `worker.js`，**不需要 Cloudflare 账号**。
56 条断言，覆盖校验、去重、合并、文字过滤、两种限流、下架、MBTI 相似度、
以及两个人共享足迹的上传/读回/幂等/脏数据清洗。改完 `worker.js` 请跑一遍。

## 两个人共一张地图

`POST /couple` 是**整份覆盖**而不是逐条追加，所以同步是幂等的：重传结果一样，
断在中间也不会留下半份数据。每台设备一行，`GET` 只返回**别人**那几行，所以自己读不到自己。

`couple id` 是一串不可枚举的随机字符，知道它就等于有权限——和分享链接一样的思路。
没有账号，也就没有账号可以泄露。照片只上传缩略图，原图永远留在本机。

## 隐私与分寸

- **不做账号。** 每台设备生成一串随机 id，只用来去重和限流。
- 收上来的只有：地点标识、分数、五个布尔维度、标签、一句话、MBTI 组合、设备 id、时间。
  **没有位置、没有姓名、没有联系方式**，打卡记录和照片一律留在本机。
- 同一台设备对同一个地点只保留最新一条（`PRIMARY KEY (pid, by_id)`）。
- 一台设备一小时最多 20 条。
- 评价文字最多 60 字，去掉换行和链接。
- 要下架某条评价：`UPDATE reviews SET hidden = 1 WHERE pid = ? AND by_id = ?;`
  `hidden = 1` 的记录不再参与合并。**上线之前一定要想好谁来看这个表**——
  只要能写自由文本，就会有人写不该写的东西。

## 还没做的

- 评价文字目前只有长度和链接过滤，没有内容审核。真要开放给陌生人，得加一层
  （关键词表，或者交给一个小模型先判一遍）。
- 没有分地区。同名的连锁店在不同城市会被当成不同地点（因为 pid 用的是 OSM 的
  node/way id），这是对的；但"活动"类的 `act:火锅暖场` 是全国合并的。
- 没有短链和链接预览图，也没有「她拆开了」提醒。计划目前整份塞在 URL 里（800~1200 字符）。
- 没有分地区合并"活动"类评分（`act:火锅暖场` 是全国合并的）。
