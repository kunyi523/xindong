/**
 * 后台自测。不需要 Cloudflare 账号：用 sql.js 在内存里冒充 D1，
 * 直接跑真正的 worker.js，把请求打进去看返回。
 *
 *   cd server && npm i sql.js && node test.mjs
 *
 * 改了 worker.js 之后请跑一遍。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function eq(name, got, want) {
  ok(name + `  (${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

/** 内存版 D1：只实现 worker 用到的 prepare().bind().all()/run() */
function makeDB() {
  const db = new SQL.Database();
  db.run(readFileSync(join(here, 'migrations/0001_init.sql'), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async all() {
          const st = db.prepare(sql);
          st.bind(args);
          const results = [];
          while (st.step()) results.push(st.getAsObject());
          st.free();
          return { results };
        },
        async run() { db.run(sql, args); return { success: true }; },
      };
      return api;
    },
  };
}

const worker = (await import(join('file://', here, 'worker.js'))).default;

function makeCall(env) {
  return async function call(method, path, body, headers = {}) {
    const req = new Request('https://x' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await worker.fetch(req, env);
    let data = null;
    try { data = JSON.parse(await res.text()); } catch {}
    return { status: res.status, data, cors: res.headers.get('Access-Control-Allow-Origin') };
  };
}

const REVIEW = (over = {}) => ({
  pid: 'osm:node/111', name: '临江那家小馆', r: 5,
  dims: { quiet: 1, pair: 1, linger: 1 }, tags: ['纪念日'],
  cost: '小奢侈', txt: '靠窗那一桌可以坐很久', mbti: 'ENFP-ISFJ', by: 'devA1',
  ...over,
});

console.log('\n— 基本 —');
{
  const call = makeCall({ DB: makeDB() });
  const root = await call('GET', '/');
  eq('根路径可用', root.data, { ok: true, service: 'xindong' });
  ok('带 CORS 头', root.cors === '*', root.cors);
  const pre = await call('OPTIONS', '/reviews');
  ok('预检直接过', pre.status === 200, pre.status);
  const nf = await call('GET', '/nope');
  eq('未知路径 404', nf.status, 404);
}

console.log('\n— 校验：该拒的要拒 —');
{
  const call = makeCall({ DB: makeDB() });
  const bad = [
    ['伪造 pid', { pid: 'javascript:alert(1)' }],
    ['pid 为空', { pid: '' }],
    ['分数越界', { r: 9 }],
    ['分数是 0', { r: 0 }],
    ['分数不是数', { r: 'five' }],
    ['设备 id 太短', { by: 'x' }],
    ['设备 id 有怪字符', { by: 'dev;drop' }],
  ];
  for (const [name, over] of bad) {
    const res = await call('POST', '/reviews', REVIEW(over));
    ok(name + ' → 400', res.status === 400, res);
  }
  const good = await call('POST', '/reviews', REVIEW());
  eq('正常一条 → ok', good.data, { ok: true });
  const noJson = await worker.fetch(new Request('https://x/reviews', { method: 'POST', body: 'oops' }), { DB: makeDB() });
  eq('坏 JSON → 400', noJson.status, 400);
}

console.log('\n— 只留最新一条 —');
{
  const call = makeCall({ DB: makeDB() });
  await call('POST', '/reviews', REVIEW({ r: 5 }));
  await call('POST', '/reviews', REVIEW({ r: 2, txt: '改成两分' }));
  const p = await call('GET', '/places?ids=osm:node/111');
  eq('同设备同地点只算一条', p.data.places['osm:node/111'].n, 1);
  eq('留下的是最新的分数', p.data.places['osm:node/111'].score, 2);
}

console.log('\n— 合并 —');
{
  const call = makeCall({ DB: makeDB() });
  await call('POST', '/reviews', REVIEW({ by: 'devA1', r: 5 }));
  await call('POST', '/reviews', REVIEW({ by: 'devB2', r: 4, dims: { quiet: 1 }, tags: ['第一次约会', '纪念日'] }));
  await call('POST', '/reviews', REVIEW({ by: 'devC3', r: 3, dims: {}, tags: [], txt: '' }));
  const p = (await call('GET', '/places?ids=osm:node/111')).data.places['osm:node/111'];
  eq('三对情侣', p.n, 3);
  eq('平均分', p.score, 4);
  eq('维度按比例', p.dims.quiet, 0.67);
  eq('标签按次数排', p.tags[0], ['纪念日', 2]);
  ok('引用只取认真填的', p.quotes.length === 2, p.quotes);
  const none = await call('GET', '/places');
  eq('没给 ids 返回空', none.data, { places: {} });
}

console.log('\n— 文字过滤 —');
{
  const call = makeCall({ DB: makeDB() });
  await call('POST', '/reviews', REVIEW({ by: 'spam1', txt: '去 http://spam.example 领红包' }));
  await call('POST', '/reviews', REVIEW({ by: 'spam2', txt: '上 spam.com 看' }));
  await call('POST', '/reviews', REVIEW({ by: 'real1', txt: '二楼靠江那个角落能坐一下午' }));
  await call('POST', '/reviews', REVIEW({ by: 'nodim', txt: '这句话够长但什么都没勾', dims: {}, tags: [] }));
  const p = (await call('GET', '/places?ids=osm:node/111')).data.places['osm:node/111'];
  ok('链接残渣不被引用', !p.quotes.some((q) => /领红包|spam/.test(q)), p.quotes);
  ok('什么都没勾的不被引用', !p.quotes.some((q) => /什么都没勾/.test(q)), p.quotes);
  ok('真话被引用', p.quotes.includes('二楼靠江那个角落能坐一下午'), p.quotes);
  const long = await call('POST', '/reviews', REVIEW({ by: 'longtxt', txt: 'x'.repeat(200) }));
  eq('超长文字也照收（会被截断）', long.data, { ok: true });
}

console.log('\n— MBTI 匹配 —');
{
  const call = makeCall({ DB: makeDB() });
  await call('POST', '/reviews', REVIEW({ by: 'same1', r: 5, mbti: 'ENFP-ISFJ' }));
  await call('POST', '/reviews', REVIEW({ by: 'near1', r: 5, mbti: 'INFP-INFJ' }));
  await call('POST', '/reviews', REVIEW({ by: 'oppo1', r: 1, mbti: 'ESTJ-ESTP' }));
  await call('POST', '/reviews', REVIEW({ by: 'blank1', r: 1, mbti: '' }));
  const q = (await call('GET', '/places?ids=osm:node/111&mbti=ENFP-ISFJ')).data.places['osm:node/111'];
  eq('全部四对', q.n, 4);
  eq('像我们的是同款 + 相近那两对', q.match.n, 2);
  eq('像我们的平均分', q.match.score, 5);

  // 互补型的坑：ENFP+ISFJ 四个轴里三个相反，压成"共识字母"会全变成 ?，
  // 于是连另一对同样组合的都匹配不上。这条一定要守住。
  const self = (await call('GET', '/places?ids=osm:node/111&mbti=ENFP-ISFJ')).data.places['osm:node/111'];
  ok('互补型能匹配到同款（曾经的 bug）', self.match.n >= 1, self.match);

  const noMbti = (await call('GET', '/places?ids=osm:node/111')).data.places['osm:node/111'];
  eq('自己没填 MBTI 就不算匹配', noMbti.match.n, 0);
}

console.log('\n— 按 IP 限流（换 by_id 绕不过去）—');
{
  const env = { DB: makeDB(), IP_SALT: 'test' };
  const call = makeCall(env);
  const ip = { 'CF-Connecting-IP': '203.0.113.9' };
  let blocked = 0, sent = 0;
  for (let i = 0; i < 45; i++) {
    const res = await call('POST', '/reviews', REVIEW({ pid: 'osm:node/' + (200 + i), by: 'dev' + i }), ip);
    if (res.status === 429) blocked++; else sent++;
  }
  ok('40 条之后开始拦', sent === 40 && blocked === 5, { sent, blocked });
  const other = await call('POST', '/reviews', REVIEW({ pid: 'osm:node/999', by: 'devZ' }), { 'CF-Connecting-IP': '198.51.100.4' });
  eq('换个 IP 不受影响', other.data, { ok: true });
}

console.log('\n— 同一设备一小时 20 条上限 —');
{
  const env = { DB: makeDB(), IP_SALT: 'test' };
  const call = makeCall(env);
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const res = await call('POST', '/reviews', REVIEW({ pid: 'osm:node/' + (400 + i), by: 'sameDev' }),
      { 'CF-Connecting-IP': '203.0.113.' + i });   // 每次换 IP，只测设备上限
    if (res.status === 429) blocked++;
  }
  ok('设备上限也生效', blocked === 5, { blocked });
}

console.log('\n— 高分地点反哺卡池 —');
{
  const call = makeCall({ DB: makeDB() });
  await call('POST', '/reviews', REVIEW({ pid: 'osm:node/222', name: '江边那家旧书店', by: 'dev01', r: 5, txt: '二楼有个能看江的角落' }));
  await call('POST', '/reviews', REVIEW({ pid: 'osm:node/222', name: '江边那家旧书店', by: 'dev02', r: 5, txt: '待了三个小时没人赶' }));
  await call('POST', '/reviews', REVIEW({ pid: 'osm:node/333', name: '只有一对评过的', by: 'dev03', r: 5 }));
  await call('POST', '/reviews', REVIEW({ pid: 'osm:node/444', name: '分数不高的', by: 'dev04', r: 2 }));
  await call('POST', '/reviews', REVIEW({ pid: 'osm:node/444', name: '分数不高的', by: 'dev05', r: 2 }));
  const cards = (await call('GET', '/cards?lat=30.66&lon=104.06')).data.cards;
  eq('只推 n≥2 且分数≥4 的', cards.map((c) => c.title), ['江边那家旧书店']);
  ok('带评分和条数', cards[0].rating === 5 && cards[0].reviews === 2, cards[0]);
  ok('带一句评价总结', !!cards[0].summary, cards[0]);
  const noCoords = (await call('GET', '/cards')).data.cards;
  eq('没给经纬度返回空', noCoords, []);
}

console.log('\n— 两个人共一张地图 —');
{
  const env = { DB: makeDB(), IP_SALT: 'test' };
  const call = makeCall(env);
  const COUPLE = 'c' + 'abc123def456ghi7';
  const pin = (over = {}) => ({ sig: '2026-09-02|老街区漫步', i: 0, ymd: '2026-09-02', title: '老街区漫步', at: 1, lat: 30.66, lon: 104.06, ...over });

  eq('couple id 不合格 → 400',
    (await call('POST', '/couple', { couple: 'nope', by: 'devA1', pins: [pin()] })).status, 400);
  eq('设备 id 不合格 → 400',
    (await call('POST', '/couple', { couple: COUPLE, by: 'x', pins: [pin()] })).status, 400);

  const up = await call('POST', '/couple', { couple: COUPLE, by: 'phoneA', pins: [pin(), pin({ i: 1, title: '水边咖啡座', lat: 30.67 })] });
  ok('他那半张传上去了', up.data.ok === true, up.data);

  const mineBack = await call('GET', `/couple?id=${COUPLE}&by=phoneA`);
  eq('自己读不到自己（读的是对方）', mineBack.data.others.length, 0);

  const hers = await call('GET', `/couple?id=${COUPLE}&by=phoneB`);
  eq('她能读到他那两处', hers.data.others[0].pins.length, 2);
  eq('标题对得上', hers.data.others[0].pins[0].title, '老街区漫步');

  await call('POST', '/couple', { couple: COUPLE, by: 'phoneB', pins: [pin({ i: 0, title: '她打的那一站', lat: 31.1 })] });
  const his = await call('GET', `/couple?id=${COUPLE}&by=phoneA`);
  eq('他也能读到她那一处', his.data.others[0].pins[0].title, '她打的那一站');

  // 幂等：同一台设备重传，还是一行，不会越传越多
  await call('POST', '/couple', { couple: COUPLE, by: 'phoneA', pins: [pin()] });
  await call('POST', '/couple', { couple: COUPLE, by: 'phoneA', pins: [pin()] });
  const again = await call('GET', `/couple?id=${COUPLE}&by=phoneB`);
  eq('重传只覆盖不追加', again.data.others.length, 1);
  eq('覆盖成最新那一份', again.data.others[0].pins.length, 1);

  // 别人的 couple id 猜不到，也就读不到
  const other = await call('GET', '/couple?id=c0000000000000000&by=phoneZ');
  eq('别的 couple 读到空', other.data.others, []);

  console.log('  · 脏数据清洗');
  await call('POST', '/couple', { couple: COUPLE, by: 'phoneC', pins: [
    pin({ lat: 999, lon: 999 }),
    pin({ i: 2, title: 'x'.repeat(200) }),
    pin({ i: 3, ymd: '乱写', title: '日期乱写' }),
    pin({ i: 4, title: '图床', thumb: 'https://evil.example/x.png' }),
    pin({ i: 5, title: '正常缩略图', thumb: 'data:image/jpeg;base64,AAAA' }),
    { title: '没有 sig 的' },
  ]});
  const cleaned = (await call('GET', `/couple?id=${COUPLE}&by=phoneB`)).data.others
    .find((o) => o.by === 'phoneC').pins;
  ok('越界经纬度被丢掉', cleaned[0].lat === undefined, cleaned[0]);
  ok('标题被截断', cleaned[1].title.length === 60, cleaned[1].title.length);
  eq('乱写的日期清空', cleaned[2].ymd, '');
  ok('外链缩略图被拒', cleaned[3].thumb === undefined, cleaned[3]);
  ok('data: 缩略图留下', cleaned[4].thumb === 'data:image/jpeg;base64,AAAA', cleaned[4]);
  eq('没有 sig 的整条丢掉', cleaned.length, 5);

  const big = await call('POST', '/couple', { couple: COUPLE, by: 'phoneD', pins: [
    pin({ thumb: 'data:image/jpeg;base64,' + 'A'.repeat(110000) }),
    pin({ i: 1, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(110000) }),
    pin({ i: 2, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(110000) }),
    pin({ i: 3, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(110000) }),
  ]});
  eq('整份太大 → 413', big.status, 413);
}

console.log('\n— 下架 —');
{
  const db = makeDB();
  const call = makeCall({ DB: db });
  await call('POST', '/reviews', REVIEW({ by: 'keep', r: 5 }));
  await call('POST', '/reviews', REVIEW({ by: 'drop', r: 1, txt: '不该留的' }));
  await db.prepare('UPDATE reviews SET hidden = 1 WHERE by_id = ?').bind('drop').run();
  const p = (await call('GET', '/places?ids=osm:node/111')).data.places['osm:node/111'];
  eq('下架的不参与合并', p.n, 1);
  eq('分数只算剩下的', p.score, 5);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 条通过，${fail} 条失败\n`);
process.exit(fail ? 1 : 0);
