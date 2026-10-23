/*!
 * octo-yangyu · 养鱼免单 SDK v2.0.0（套餐卡 / 期次绑 ISO 周 / 单次核销双边结算 / 100% 返还）
 *
 * ── 定位 ───────────────────────────────────────────────────────────────
 * 本版本**不是独立站点**：养鱼免单没有自己的页面、没有自己的路由、没有自己的登录。
 * 它是挂在既有联邦站页面上的**内联模块**——宿主给一个容器，SDK 往里渲染；
 * 宿主不给容器，SDK 就只当数据层用（`Octo.Yangyu.api.*`）。
 *
 * 三端共用一份：
 *   C 端   项目集合页 / 我的养鱼 / 消息          （挂 ai 站）
 *   商户端 核销台 / 任务名单 / 结算账户          （挂商户后台页）
 *   运营端 选品设计套餐卡 / 审核 / 预算水位       （挂运营后台页）
 *
 * ── 与独立站点版的关键差异 ────────────────────────────────────────────
 *   1) 身份：不签发、不存储任何令牌。身份来自 domain=.ws.hi.cn 的 cookie，
 *      服务端拿它去问主站 /api/v2/auth/me。SDK 里**没有 token 变量**——
 *      独立页面版的 `localStorage.yy_access` 是最大的安全问题来源，这里彻底不存在。
 *   2) 请求：一律 `credentials: 'include'`，路径走同源反代 `/yangyu-api/*`。
 *      **刻意不使用 Octo.api.request**：core 的 `baseUrl`（/api/v2）会拼在绝对路径前，
 *      把 `/yangyu-api/sdk/projects` 变成 `/api/v2/yangyu-api/...`；
 *      而 core 的 token 注入对 cookie 身份也没有意义。这是显式偏离，理由记录在此。
 *   3) 渲染：只操作传入容器内的 `.yy-*` 节点，**不碰 document.body、不改 URL、
 *      不注册全局滚动/路由监听**。宿主刷新页面时不需要卸载（无残留副作用）。
 *   4) 金额口径：0.7 即时返还 + 0.3 分享返还，由后端 /api/sdk/meta 下发，
 *      SDK 不硬编码比例——写死比例就等于把产品规则复制了一份到客户端，必然漂移。
 *
 * ── 契约稳定性 ────────────────────────────────────────────────────────
 * `Octo.Yangyu.api.*` 的入参与返回字段只增不改；新增能力追加方法，不改旧方法语义。
 * 后端契约版本见 `GET /api/sdk/meta` 的 `contract`，SDK 启动时可比对。
 *
 * ── 分发（铁律） ──────────────────────────────────────────────────────
 * 唯一通道：`bash tools/deploy-sdk.sh <prev-tag> --site ai --apply`。
 * 禁止手工 scp 覆盖 shared/octo-sdk/modules/（那里三层 chattr +i，且 SHA256SUMS.sdk 是登记册）。
 * 宿主页引用必须带缓存戳：`octo-yangyu.v2.0.0.js?v=TOKvNN`。
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';
  var CONTRACT = '2.0';
  var NS = 'Yangyu';

  var Octo = global.Octo;
  if (Octo && Octo[NS] && Octo[NS].__v === VERSION) return;
  if (global.__octoYangyuV2) return;
  global.__octoYangyuV2 = true;

  /* ================================================================
   * 0. 配置与请求
   * ================================================================ */

  var _cfg = {
    // 同源反代：nginx /yangyu-api/* → 本服务（服务端带前缀剥离，不依赖 proxy_pass 尾斜杠）
    base: '/yangyu-api',
    fetchImpl: null,
    timeout: 12000,
    /** 当前挂载的视图名，埋点用它区分转化漏斗（mount 时写入） */
    currentView: null,
    /** 分享归因参数名，与主站落地页一致（服务端 /meta 也会下发，这里只做首屏默认） */
    refParam: 'ref'
  };

  function configure(o) {
    o = o || {};
    if (o.base) _cfg.base = String(o.base).replace(/\/+$/, '');
    if (o.fetchImpl) _cfg.fetchImpl = o.fetchImpl;
    if (o.timeout != null) _cfg.timeout = Number(o.timeout) || _cfg.timeout;
    if (o.refParam) _cfg.refParam = String(o.refParam);
    return _cfg;
  }

  function qs(params) {
    var out = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v === null || v === undefined || v === '') continue;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return out.length ? '?' + out.join('&') : '';
  }

  function YangyuError(code, message, data) {
    var e = new Error(message || ('请求失败(' + code + ')'));
    e.name = 'YangyuError';
    e.code = code;
    e.data = data;
    return e;
  }

  /**
   * 统一请求。返回**已解信封的 data**（即 `{code:0,data:X}` 里的 X）。
   * 401 抛 code=2001，与 core 的约定一致，宿主可据此弹登录。
   */
  function http(path, opts) {
    opts = opts || {};
    var f = _cfg.fetchImpl || global.fetch;
    if (!f) return Promise.reject(YangyuError(-1, '当前环境不支持 fetch'));

    var init = {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    };
    if (opts.body !== undefined && opts.body !== null) init.body = JSON.stringify(opts.body);
    if (opts.headers) for (var k in opts.headers) init.headers[k] = opts.headers[k];

    var url = _cfg.base + path + qs(opts.query || {});
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl && _cfg.timeout > 0) {
      timer = setTimeout(function () { ctrl.abort(); }, _cfg.timeout);
      init.signal = ctrl.signal;
    }

    return f(url, init)
      .then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (text) {
          var payload = null;
          try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
          if (res.status === 401) throw YangyuError(2001, '登录状态已失效，请重新登录', payload);
          if (!res.ok) {
            throw YangyuError(
              (payload && (payload.code || res.status)) || res.status,
              (payload && (payload.message || (payload.error && payload.error.message))) || ('请求失败(' + res.status + ')'),
              payload
            );
          }
          // 后端双写信封：{code:0, ok:true, data}, 也兼容裸对象（灰度期）
          if (payload && typeof payload.code === 'number') {
            if (payload.code !== 0) throw YangyuError(payload.code, payload.message, payload.data);
            return payload.data;
          }
          if (payload && payload.data !== undefined) return payload.data;
          return payload;
        });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.name === 'AbortError') throw YangyuError(-3, '请求超时，请重试');
        throw err;
      });
  }

  /* ================================================================
   * 1. 状态（宿主可通过 state 读，不通过 state 改）
   * ================================================================ */

  var _S = {
    user: { loggedIn: false, role: null, merchantId: '' },
    counters: { unread: 0, activeCards: 0 },
    categories: [],
    rules: { refundNowRatio: 0.7, refundShareRatio: 0.3, streakDays: 5 },
    projects: [],
    mine: [],
    lastError: null
  };

  function bootstrap() {
    return http('/sdk/bootstrap').then(function (d) {
      _S.user = d.user || _S.user;
      _S.counters = d.counters || _S.counters;
      _S.categories = d.categories || [];
      _S.rules = d.rules || _S.rules;
      return d;
    });
  }

  function meta() {
    return http('/sdk/meta');
  }

  /* ================================================================
   * 2. 数据层（宿主自渲染时只用这一层）
   * ================================================================ */

  /** 项目集合页。sort: default|price_asc|price_desc|new */
  function getProjects(o) {
    o = o || {};
    return http('/sdk/projects', {
      query: {
        category: o.category,
        keyword: o.keyword,
        sort: o.sort,
        page: o.page || 1,
        pageSize: o.pageSize || 20
      }
    }).then(function (d) {
      _S.projects = (d && d.items) || [];
      return d;
    });
  }

  /** 单个项目详情 + 购买承诺摘要（确认弹层的文案真源） */
  function getProject(id) {
    return http('/sdk/projects/' + encodeURIComponent(id));
  }

  /**
   * 购买：下单 + 取支付参数，一次调用完成。
   * 服务端会生成 N 条期次（首期 = 下一个完整 ISO 周），并回 payParams。
   * @param {string} id 卡 id
   * @param {{channel?:'jsapi'|'native',openid?:string,pay?:boolean}} [o]
   */
  function purchase(id, o) {
    o = o || {};
    return http('/sdk/projects/' + encodeURIComponent(id) + '/purchase', {
      method: 'POST',
      body: { channel: o.channel || 'jsapi', openid: o.openid || '', pay: o.pay !== false }
    });
  }

  /** 我的养鱼（含 nextAction：pay/start_task/go_checkin/wait/settled/exited/refunded） */
  function getMine() {
    return http('/sdk/mine').then(function (d) {
      _S.mine = (d && d.items) || [];
      return d;
    });
  }

  function getNotices(limit) {
    return http('/sdk/notices', { query: { limit: limit || 30 } });
  }

  function readNotice(id) {
    return http('/sdk/notices/' + encodeURIComponent(id) + '/read', { method: 'POST' });
  }

  /** 商户：核销（原子端点，与独立站点版同一实现） */
  function checkin(enrollmentId) {
    return http('/api/checkin', { method: 'POST', body: { enrollmentId: enrollmentId } });
  }

  /** 商户工作台：结算账户 + 名单 */
  function getMerchantConsole() {
    return http('/sdk/merchant/console');
  }

  /** 运营工作台：待审 + 预算水位 + 欠款 + 卡单 */
  function getOpsConsole() {
    return http('/sdk/ops/console');
  }

  /** 运营：设计套餐卡（单价 / 期数 / 供应价 → 三道闸门在后端） */
  function designCard(body) {
    return http('/api/cards/design', { method: 'POST', body: body });
  }

  /** 运营：审核 */
  function reviewCard(id, approve, rejectReason) {
    return http('/api/cards/' + encodeURIComponent(id) + '/review', {
      method: 'POST',
      body: { approve: !!approve, rejectReason: rejectReason || '' }
    });
  }

  /** 运营：补期（漏一周即永久损失） */
  function extendPeriod(periodId, week) {
    return http('/api/periods/' + encodeURIComponent(periodId) + '/extend', {
      method: 'POST',
      body: { week: week }
    });
  }

  /**
   * 分享链接（第三代：谁分享绑定谁的关系）。
   *
   * 链接只带分享者自己的 ai_uid（ref 参数），**不生成邀请码**：
   *   邀请码等于在养鱼域再造一套身份，和主站账号体系必然对不齐；
   *   而 ai_uid 已经是全平台唯一身份，落地页能直接认人。
   *
   * 朋友打开链接 → 前端调 /sdk/share/bind → 绑定成功即解锁分享者**名下所有卡**。
   */
  function getShareLink(cardId) {
    return http('/sdk/share/link', { query: { cardId: cardId } });
  }

  /**
   * 绑定分享关系（被分享者侧调用，必须已登录）。
   * ref = 链接里的 ai_uid；cardId 仅用于归因来源，不影响解锁范围（解锁全部卡）。
   */
  function bindShare(ref, cardId) {
    return http('/sdk/share/bind', {
      method: 'POST',
      body: { ref: ref, cardId: cardId || null, source: 'link' }
    });
  }

  /**
   * 落地页自动绑定：URL 带 ref 或此前存过 yy_ref（游客先打开、后登录）时执行一次。
   * 失败静默——绑定失败不能挡住"逛"，用户仍可正常浏览。
   */
  function autoBind(opts) {
    opts = opts || {};
    var ref = readRefParam(opts.refParam);
    if (!ref) return Promise.resolve(null);
    return bootstrap().then(function (b) {
      if (!b || !b.user || !b.user.loggedIn) {
        // 记住 ref，登录后再绑（宿主登录成功后调 Octo.Yangyu.autoBind() 即可）
        storeRef(ref);
        return null;
      }
      return bindShare(ref, opts.cardId).then(function (r) {
        clearRef();
        track('share_bound', { ok: !!(r && r.ok), reason: (r && r.reason) || null });
        return r;
      });
    }).catch(function () { return null; });
  }

  function readRefParam(explicitName) {
    var name = explicitName || _cfg.refParam || 'ref';
    try {
      var qs = (global.location && global.location.search) || '';
      var m = new RegExp('[?&]' + name + '=([^&#]+)').exec(qs);
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { /* ignore */ }
    try { return global.sessionStorage ? global.sessionStorage.getItem('yy_ref') : null; } catch (e) { return null; }
  }

  function storeRef(ref) {
    try { if (global.sessionStorage) global.sessionStorage.setItem('yy_ref', ref); } catch (e) { /* ignore */ }
  }

  function clearRef() {
    try { if (global.sessionStorage) global.sessionStorage.removeItem('yy_ref'); } catch (e) { /* ignore */ }
  }

  /** 重读分享状态（邀请人数 / 已解锁卡数 / 我是否被别人带来） */
  function refreshShare(opts) {
    opts = opts || {};
    return http('/sdk/share/refresh', {
      method: 'POST',
      body: { ref: readRefParam(opts.refParam) || undefined, cardId: opts.cardId || undefined }
    });
  }

  /** 关系状态：只回答"我是否已被邀请 / 我邀请了几人"，不暴露对方身份 */
  function getShareChain() {
    return http('/sdk/share/chain');
  }

  /* ================================================================
   * 3. 埋点（静默，失败不影响主流程；服务端落表 sdk_event）
   * ================================================================ */
  function track(ev, payload) {
    try {
      var body = JSON.stringify({
        event_type: ev,
        view: _cfg.currentView || 'yangyu',
        sdk_version: VERSION,
        payload: payload || {}
      });
      // 端点必须与 http 层一致：_cfg.base 已含 /yangyu-api 前缀，
      // 旧实现写死了 '/api/sdk/track' → 实际请求 /yangyu-api/api/sdk/track（404，埋点全丢）。
      var url = _cfg.base + '/sdk/track';
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        http('/sdk/track', {
          method: 'POST',
          body: { event_type: ev, view: _cfg.currentView || 'yangyu', sdk_version: VERSION, payload: payload || {} }
        }).catch(function () {});
      }
    } catch (e) { /* 埋点永不影响业务 */ }
  }

  /* ================================================================
   * 4. 渲染层（可选；宿主可完全不用）
   *    只写容器内部，样式全部以 .yy- 前缀限定，不污染宿主皮肤。
   * ================================================================ */

  var CSS_ID = 'octo-yangyu-css';
  var CSS = [
    '.yy-root{--yy-accent:#e8552d;--yy-bg:#fff;--yy-sub:#f6f7f8;--yy-line:#eceef1;--yy-t1:#1a1c1e;--yy-t2:#6b7280;',
    'font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--yy-t1);}',
    '.yy-root *{box-sizing:border-box;}',
    '.yy-hd{display:flex;align-items:center;justify-content:space-between;margin:0 0 12px;}',
    '.yy-hd h3{margin:0;font-size:17px;font-weight:600;}',
    '.yy-chips{display:flex;gap:8px;overflow-x:auto;padding:2px 0 10px;-webkit-overflow-scrolling:touch;}',
    '.yy-chip{flex:0 0 auto;padding:6px 12px;border:1px solid var(--yy-line);border-radius:999px;background:var(--yy-bg);color:var(--yy-t2);font-size:13px;cursor:pointer;}',
    '.yy-chip.on{border-color:var(--yy-accent);color:var(--yy-accent);background:rgba(232,85,45,.06);font-weight:600;}',
    '.yy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}',
    '.yy-card{border:1px solid var(--yy-line);border-radius:14px;overflow:hidden;background:var(--yy-bg);display:flex;flex-direction:column;}',
    '.yy-cover{height:112px;background:var(--yy-sub) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#c9ced6;font-size:12px;}',
    '.yy-bd{padding:12px 12px 8px;flex:1;}',
    '.yy-title{font-size:15px;font-weight:600;margin:0 0 4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.yy-sub{font-size:12px;color:var(--yy-t2);margin:0 0 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.yy-price{color:var(--yy-accent);font-weight:700;font-size:18px;}',
    '.yy-price small{font-size:12px;font-weight:400;color:var(--yy-t2);margin-left:4px;}',
    '.yy-ft{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-top:1px solid var(--yy-line);gap:8px;}',
    '.yy-btn{appearance:none;border:0;border-radius:10px;padding:9px 14px;font-size:13px;font-weight:600;background:var(--yy-accent);color:#fff;cursor:pointer;}',
    '.yy-btn:disabled{opacity:.5;cursor:not-allowed;}',
    '.yy-btn.ghost{background:var(--yy-sub);color:var(--yy-t1);}',
    '.yy-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--yy-line);}',
    '.yy-row:last-child{border-bottom:0;}',
    '.yy-tag{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;background:var(--yy-sub);color:var(--yy-t2);margin-left:6px;}',
    '.yy-tag.warn{background:#fff4e5;color:#b26a00;}',
    '.yy-tag.bad{background:#fdecec;color:#c62828;}',
    '.yy-tag.ok{background:#eaf7ee;color:#1b7a3d;}',
    '.yy-empty{padding:36px 12px;text-align:center;color:var(--yy-t2);font-size:13px;}',
    '.yy-note{font-size:12px;color:var(--yy-t2);background:var(--yy-sub);border-radius:10px;padding:8px 10px;margin-top:10px;}',
    '.yy-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:2000;}',
    '.yy-sheet{background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:520px;padding:18px 16px 20px;max-height:86vh;overflow:auto;}',
    '.yy-sheet h4{margin:0 0 10px;font-size:16px;}',
    '.yy-kv{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;}',
    '.yy-kv b{font-weight:600;}',
    '.yy-check{display:flex;gap:8px;align-items:flex-start;padding:7px 0;font-size:13px;line-height:1.5;}',
    '.yy-check input{margin-top:2px;}',
    '.yy-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:9px 15px;border-radius:10px;font-size:13px;z-index:2100;max-width:80vw;}',
    '@media (prefers-color-scheme:dark){.yy-root{--yy-bg:#16181b;--yy-sub:#212429;--yy-line:#2b2f35;--yy-t1:#f2f3f5;--yy-t2:#9aa1ab;}.yy-sheet{background:#16181b;color:#f2f3f5;}}'
  ].join('');

  function injectCss(doc) {
    doc = doc || document;
    if (doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    doc.head.appendChild(s);
  }

  function money(n) {
    var v = Number(n) || 0;
    return '¥' + (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, ms) {
    var el = document.createElement('div');
    el.className = 'yy-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 2000);
  }

  var STATUS_TEXT = {
    normal: '在养中',
    pause1: '停奖 1 期',
    pause3: '停奖 3 期',
    pause2: '停奖(旧)',
    pause6: '停奖(旧)',
    exited: '已退出',
    refunded: '已退款'
  };

  var ACTION_TEXT = {
    pay: '去支付',
    start_task: '去完成今日任务',
    go_checkin: '到店核销',
    wait: '本周已结束，等下周',
    settled: '本期已全部完成',
    exited: '已退出，可重新入渔',
    refunded: '已退款'
  };

  /* ---------------- 视图：项目集合页 ---------------- */
  function viewProjects(root, opts) {
    opts = opts || {};
    var cls = opts.category || '';
    root.innerHTML = '<div class="yy-hd"><h3>' + esc(opts.title || '养鱼免单 · 项目集合') + '</h3></div>' +
      '<div class="yy-chips" data-yy-chips></div><div class="yy-grid" data-yy-grid><div class="yy-empty">加载中…</div></div>';
    function renderChips() {
      var box = root.querySelector('[data-yy-chips]');
      var all = [{ key: '', count: 0 }].concat(_S.categories || []);
      box.innerHTML = all.map(function (c) {
        var label = c.key === '' ? '全部' : c.key;
        return '<button class="yy-chip' + (cls === c.key ? ' on' : '') + '" data-cat="' + esc(c.key) + '">' +
          esc(label) + '</button>';
      }).join('');
    }

    function renderGrid() {
      var grid = root.querySelector('[data-yy-grid]');
      var items = _S.projects || [];
      if (!items.length) {
        grid.innerHTML = '<div class="yy-empty">这个分类下还没有项目，换一个看看</div>';
        return;
      }
      grid.innerHTML = items.map(function (p) {
        return '<article class="yy-card" data-id="' + esc(p.id) + '">' +
          (p.coverUrl
            ? '<div class="yy-cover" style="background-image:url(' + esc(p.coverUrl) + ')"></div>'
            : '<div class="yy-cover">' + esc(p.merchantName || '') + '</div>') +
          '<div class="yy-bd">' +
          '<p class="yy-title">' + esc(p.title) + '</p>' +
          (p.subtitle ? '<p class="yy-sub">' + esc(p.subtitle) + '</p>' : '') +
          // 集合页只给总价与期数，**不出现单价 × 返还比例**：
          // 两者相乘就是"每期返多少钱"，等于把补贴强度摆在公开位上。
          // 具体金额只在购买确认弹层展示（交易告知义务）。
          '<div><span class="yy-price">' + money(p.totalPrice) + '</span>' +
          '<small>' + p.periods + ' 期</small></div>' +
          '<div class="yy-note">' + esc(p.refundClaim || '') + '</div>' +
          '</div>' +
          '<div class="yy-ft"><span style="font-size:12px;color:var(--yy-t2)">已拼 ' + (p.soldCount || 0) + ' 人</span>' +
          '<button class="yy-btn" data-buy="' + esc(p.id) + '">立即参与</button></div>' +
          '</article>';
      }).join('');
    }

    // 事件统一由 mount 绑定并转发（见 mount 的 __yyClick 说明），视图内部不再 addEventListener
    function onClick(e) {
      var chip = e.target.closest ? e.target.closest('.yy-chip') : null;
      if (chip) {
        cls = chip.getAttribute('data-cat') || '';
        renderChips();
        load();
        return;
      }
      var buy = e.target.closest ? e.target.closest('[data-buy]') : null;
      if (buy) {
        confirmPurchase(buy.getAttribute('data-buy'), opts);
      }
    }

    function load() {
      return getProjects({ category: cls, pageSize: opts.pageSize || 20 })
        .then(function () { renderChips(); renderGrid(); })
        .catch(function (err) {
          root.querySelector('[data-yy-grid]').innerHTML =
            '<div class="yy-empty">加载失败：' + esc(err.message) + '</div>';
        });
    }

    if (!_S.categories.length) {
      bootstrap().then(load).catch(load);
    } else {
      renderChips(); load();
    }
    return { reload: load, onClick: onClick };
  }

  /* ---------------- 分享（第三代：绑定即归因） ---------------- */
  /**
   * 分享：拿链接 → 优先交给宿主（微信内必须用 JSAPI shareAppMessage，签名在宿主手里），
   * 没有宿主桥时降级为复制链接。
   *
   * 为什么 SDK 不自己跳转：微信内 H5 直接发链接会被拦，必须宿主用公众号签名
   * 调 wx.shareAppMessage。SDK 只提供 URL 与文案，不假设宿主环境。
   *
   * 链路（2026-10-21 口径）：
   *   我点分享 → 链接带我的 ai_uid → 朋友打开即绑定（不要求他买卡）
   *   → 绑定成功瞬间，我名下**所有卡**按其各自比例解锁尾款。
   */
  function openShare(cardId, opts, onDone) {
    opts = opts || {};
    track('share_click', { cardId: cardId });
    getShareLink(cardId).then(function (d) {
      if (!d || !d.ok) {
        toast(d && d.reason === 'NO_FEDERATION' ? '请先在主站登录后再分享' : '分享暂不可用，请稍后再试');
        return;
      }
      if (typeof opts.onShare === 'function') {
        // 宿主自理分享面板，建议带上 { url, title, imageUrl, cardId }
        opts.onShare({
          url: d.shareUrl,
          title: opts.shareTitle || '我在养鱼免单，一起拼一桌',
          cardId: cardId,
          ratio: d.ratio,
          pendingPeriods: d.pendingPeriods
        });
        return;
      }
      copyText(d.shareUrl).then(function (ok) {
        if (ok) {
          track('share_copied', { cardId: cardId });
          toast('链接已复制，朋友打开即绑定（你的所有卡同时解锁）');
        } else {
          toast('请手动复制：' + d.shareUrl);
        }
        if (typeof onDone === 'function') onDone();
      });
    }).catch(function (err) {
      toast(err.message || '分享链接获取失败');
    });
  }

  /** 复制：优先 Clipboard API，降级 execCommand（微信 X5 内核里 Clipboard 常不可用） */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 购买确认（合规三步勾选） ---------------- */
  function confirmPurchase(cardId, opts) {
    opts = opts || {};
    getProject(cardId).then(function (d) {
      var p = d.project, pr = d.promise;
      var mask = document.createElement('div');
      mask.className = 'yy-mask';
      mask.innerHTML = '<div class="yy-sheet">' +
        '<h4>' + esc(p.title) + '</h4>' +
        '<div class="yy-kv"><span>单价 × 期数</span><b>' + money(p.unitPrice) + ' × ' + p.periods + '</b></div>' +
        '<div class="yy-kv"><span>应付总额</span><b>' + money(pr.amount) + '</b></div>' +
        '<div class="yy-kv"><span>达标核销即返</span><b>' + money(pr.refundNow) + ' / 期</b></div>' +
        '<div class="yy-kv"><span>分享好友再返</span><b>' + money(pr.refundShare) + ' / 期</b></div>' +
        '<div class="yy-note">' + esc(pr.rule) + '</div>' +
        pr.caveat.map(function (c, i) {
          return '<label class="yy-check"><input type="checkbox" data-ack="' + i + '"><span>' + esc(c) + '</span></label>';
        }).join('') +
        '<div class="yy-ft" style="border:0;padding:14px 0 0;justify-content:flex-end">' +
        '<button class="yy-btn ghost" data-cancel>再看看</button>' +
        '<button class="yy-btn" data-pay disabled>确认参与并支付 ' + money(pr.amount) + '</button></div>' +
        '</div>';

      document.body.appendChild(mask);
      var btn = mask.querySelector('[data-pay]');
      var boxes = mask.querySelectorAll('[data-ack]');
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].addEventListener('change', function () {
          var all = true;
          for (var j = 0; j < boxes.length; j++) if (!boxes[j].checked) all = false;
          btn.disabled = !all;
        });
      }
      mask.querySelector('[data-cancel]').addEventListener('click', function () { mask.remove(); });
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = '处理中…';
        purchase(cardId, { channel: opts.channel || 'jsapi', openid: opts.openid })
          .then(function (r) {
            mask.remove();
            if (r && r.payParams) invokeWechatPay(r.payParams, opts);
            else toast('已下卡，请在「我的养鱼」查看');
            if (typeof opts.onPurchased === 'function') opts.onPurchased(r);
            track('purchase_success', { cardId: cardId, amount: pr.amount });
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = '确认参与并支付 ' + money(pr.amount);
            if (err.code === 2001) toast('请先登录后再参与');
            else toast(err.message || '下单失败');
          });
      });
    }).catch(function (err) { toast(err.message || '项目信息加载失败'); });
  }

  /** 微信 JSAPI 支付（宿主未注入 onBridge 时的默认实现） */
  function invokeWechatPay(payParams, opts) {
    if (opts && typeof opts.onPay === 'function') return opts.onPay(payParams);
    if (!global.WeixinJSBridge) { toast('请在微信内打开完成支付'); return; }
    global.WeixinJSBridge.invoke('getBrandWCPayRequest', payParams, function (res) {
      if (res && res.err_msg === 'get_brand_wcpay_request:ok') {
        toast('支付成功');
        if (opts && typeof opts.onPaid === 'function') opts.onPaid(res);
      } else {
        toast('支付未完成，可在「我的养鱼」继续');
      }
    });
  }

  /* ---------------- 视图：我的养鱼 ---------------- */
  function viewMine(root, opts) {
    opts = opts || {};
    root.innerHTML = '<div class="yy-hd"><h3>' + esc(opts.title || '我的养鱼') + '</h3></div>' +
      '<div data-yy-list><div class="yy-empty">加载中…</div></div>';

    function paint() {
      var box = root.querySelector('[data-yy-list]');
      var items = _S.mine || [];
      if (!items.length) {
        box.innerHTML = '<div class="yy-empty">还没参与项目。<br>去「项目集合」挑一个开始养鱼吧</div>';
        return;
      }
      box.innerHTML = items.map(function (m) {
        var tag = '<span class="yy-tag' + (m.status === 'exited' || m.status === 'refunded' ? ' bad' : (m.paused ? ' warn' : ' ok')) + '">' +
          esc(STATUS_TEXT[m.status] || m.status) + '</span>';
        var cur = m.current;
        // 周四之后本周已无法达标：必须明说，别让用户白做四天
        var deadline = cur
          ? (cur.closed ? '<span style="color:var(--yy-t2)">本期已关闭</span>'
            : '最晚 <b>' + esc(cur.lastStartDay) + '</b> 开始连续任务 · 核销截止 ' + esc(cur.checkinDeadline))
          : '<span style="color:var(--yy-t2)">暂无进行中的期次</span>';

        // 分享入口只在这里（持卡人才有可分享的卡）；集合页不放，避免在转化位分流。
        // 第三代口径：任何卡都能分享，不要求已成交、不要求已核销。
        var sh = m.share || {};
        var pct = Math.round((sh.ratio || 0.3) * 100);
        var shareBtn = sh.unlocked
          ? '<span class="yy-tag ok">已解锁 ' + pct + '%</span>'
          : '<button class="yy-btn ghost" data-share="' + esc(m.cardId) + '">邀请好友 · 解锁 ' + pct + '%</button>';
        var inviteLine = sh.invited
          ? '<div style="font-size:12px;color:var(--yy-t2);margin-top:3px">已绑定 ' + sh.invited + ' 位好友</div>'
          : '';

        return '<div class="yy-row"><div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">' + esc(m.title) + tag + '</div>' +
          '<div style="font-size:12px;color:var(--yy-t2);margin-top:3px">' +
          '第 ' + (cur ? cur.periodNo : '-') + '/' + m.totalPeriods + ' 期 · 已核销 ' + m.periodsDone +
          ' · 已返 ' + money(m.refunded) + '</div>' + inviteLine +
          '<div style="font-size:12px;margin-top:4px">' + deadline + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' +
          shareBtn +
          '<button class="yy-btn' + (m.nextAction === 'go_checkin' ? '' : ' ghost') + '" ' +
          (m.nextAction === 'go_checkin' || m.nextAction === 'start_task' ? '' : 'disabled') + '>' +
          esc(ACTION_TEXT[m.nextAction] || '—') + '</button>' +
          '</div></div>';
      }).join('');
    }

    function onClick(e) {
      var s = e.target.closest ? e.target.closest('[data-share]') : null;
      if (s) {
        openShare(s.getAttribute('data-share'), opts, function () {
          return getMine().then(paint);
        });
      }
    }

    getMine().then(paint).catch(function (err) {
      root.querySelector('[data-yy-list]').innerHTML =
        '<div class="yy-empty">' + (err.code === 2001 ? '请先登录' : '加载失败：' + esc(err.message)) + '</div>';
    });
    return { reload: function () { return getMine().then(paint); }, onClick: onClick };
  }

  /* ---------------- 视图：商户核销台 ---------------- */
  function viewCheckin(root, opts) {
    opts = opts || {};
    root.innerHTML = '<div class="yy-hd"><h3>' + esc(opts.title || '核销台') + '</h3></div>' +
      '<div style="display:flex;gap:8px"><input data-yy-code placeholder="扫顾客核销码或输入单号" ' +
      'style="flex:1;padding:10px;border:1px solid var(--yy-line);border-radius:10px">' +
      '<button class="yy-btn" data-yy-go>核销</button></div>' +
      '<div data-yy-out style="margin-top:12px"></div>';

    root.querySelector('[data-yy-go]').addEventListener('click', function () {
      var code = root.querySelector('[data-yy-code]').value.trim();
      var out = root.querySelector('[data-yy-out]');
      if (!code) { toast('请输入核销码'); return; }
      out.innerHTML = '<div class="yy-empty">核销中…</div>';
      checkin(code).then(function (r) {
        // 停奖期照常可用但不发钱：收银员必须看到这句话，否则会跟顾客争
        var refunded = r && r.refund && r.refund.amount > 0;
        out.innerHTML = '<div class="yy-row"><div>' +
          '<div style="font-weight:600">核销成功</div>' +
          '<div style="font-size:12px;color:var(--yy-t2)">' +
          (refunded ? '已返 ' + money(r.refund.amount) + ' 至顾客消费金'
            : (r && r.paused ? '顾客处于停奖期：服务照常，本次不返还' : '本期未达标：服务照常，本次不返还')) +
          (r && r.merchant ? ' · 本单结算 ' + money(r.merchant.payable) : '') +
          '</div></div></div>';
        root.querySelector('[data-yy-code]').value = '';
      }).catch(function (err) {
        out.innerHTML = '<div class="yy-empty">' + esc(err.message) + '</div>';
      });
    });
  }

  /* ---------------- 视图：商户工作台 ---------------- */
  function viewMerchant(root, opts) {
    opts = opts || {};
    root.innerHTML = '<div class="yy-hd"><h3>商户结算</h3></div><div data-yy-out><div class="yy-empty">加载中…</div></div>';
    getMerchantConsole().then(function (d) {
      var a = d.account || {};
      var bal = Number(a.balance) || 0;
      root.querySelector('[data-yy-out]').innerHTML =
        '<div class="yy-row"><span>账户余额</span><b style="color:' + (bal < 0 ? '#c62828' : 'inherit') + '">' +
        money(bal) + (bal < 0 ? '（欠款，下期抵扣）' : '') + '</b></div>' +
        '<div class="yy-row"><span>累计结算</span><b>' + money(a.totalSettled) + '</b></div>' +
        '<div style="margin-top:12px;font-size:13px;color:var(--yy-t2)">任务名单 ' +
        ((d.roster || []).length) + ' 人</div>' +
        (d.roster || []).slice(0, 20).map(function (r) {
          return '<div class="yy-row"><div style="font-size:13px">' + esc(r.userId || r.user_id || '') +
            '<div style="font-size:12px;color:var(--yy-t2)">' + esc(STATUS_TEXT[r.status] || r.status) + '</div></div>' +
            '<span class="yy-tag">' + esc(String(r.cardId || '').slice(0, 8)) + '</span></div>';
        }).join('');
    }).catch(function (err) {
      root.querySelector('[data-yy-out]').innerHTML = '<div class="yy-empty">' + esc(err.message) + '</div>';
    });
  }

  /* ---------------- 视图：运营工作台 ---------------- */
  function viewOps(root, opts) {
    opts = opts || {};
    root.innerHTML = '<div class="yy-hd"><h3>养鱼运营</h3></div><div data-yy-out><div class="yy-empty">加载中…</div></div>';
    getOpsConsole().then(function (d) {
      var b = d.budget || {};
      root.querySelector('[data-yy-out]').innerHTML =
        (d.budgetAlert
          ? '<div class="yy-note" style="background:#fdecec;color:#c62828">预算剩余 ' + money(b.remaining) +
            ' < 在办期次最坏敞口 ' + money(b.exposure) + '：请停售新卡（已售卡兑付不受影响）</div>'
          : '<div class="yy-note">' + b.monthKey + ' 预算剩余 ' + money(b.remaining) +
            ' / 敞口 ' + money(b.exposure) + '</div>') +
        '<div class="yy-row"><span>待审核项目</span><b>' + (d.pendingCards || []).length + '</b></div>' +
        '<div class="yy-row"><span>欠款商户</span><b>' + (d.negativeAccounts || []).length + '</b></div>' +
        '<div class="yy-row"><span>卡单退费(>30min)</span><b>' + (d.stuckRefunds || []).length + '</b></div>';
    }).catch(function (err) {
      root.querySelector('[data-yy-out]').innerHTML = '<div class="yy-empty">' + esc(err.message) + '</div>';
    });
  }

  /* ---------------- 视图：消息 ---------------- */
  function viewNotices(root, opts) {
    opts = opts || {};
    root.innerHTML = '<div class="yy-hd"><h3>消息</h3></div><div data-yy-out><div class="yy-empty">加载中…</div></div>';
    getNotices(opts.limit).then(function (d) {
      var items = (d && d.items) || [];
      var out = root.querySelector('[data-yy-out]');
      if (!items.length) { out.innerHTML = '<div class="yy-empty">暂无消息</div>'; return; }
      out.innerHTML = items.map(function (m) {
        return '<div class="yy-row" data-nid="' + esc(m.id) + '"><div style="flex:1">' +
          '<div style="font-weight:600;font-size:13px">' + esc(m.title) +
          (m.state === 'sent' ? '<span class="yy-tag warn">未读</span>' : '') + '</div>' +
          '<div style="font-size:12px;color:var(--yy-t2);margin-top:2px">' + esc(m.body) + '</div>' +
          '</div></div>';
      }).join('');
    }).catch(function (err) {
      root.querySelector('[data-yy-out]').innerHTML = '<div class="yy-empty">' + esc(err.message) + '</div>';
    });
  }

  var VIEWS = {
    projects: viewProjects,
    mine: viewMine,
    checkin: viewCheckin,
    merchant: viewMerchant,
    ops: viewOps,
    notices: viewNotices
  };

  /**
   * 内联挂载。**不接管路由、不创建页面**——宿主给它哪个容器，它就只活在哪个容器里。
   *
   * 事件只在容器上绑一次（`__yyClick`），之后靠 `__yyHandler` 转发给当前视图。
   * 为什么不在渲染函数里 addEventListener：宿主切 tab 会把同一个容器反复 mount 不同视图，
   * 每次绑一个监听，点一次会触发 N 次（表现为"买一次扣两次"），这类 bug 只在真机上偶发。
   *
   * @param {HTMLElement|string} target 容器或 id
   * @param {{view:string, [k:string]:any}} opts
   * @returns {{reload?:Function}|null}
   */
  function mount(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) { console.warn('[yangyu] mount 目标不存在:', target); return null; }
    var view = opts.view || 'projects';
    _cfg.currentView = view;

    // 同容器同视图重复 mount：直接返回已挂载实例，不重绘、不重发请求
    if (el.__yyCtl && el.__yyCtl.view === view) return el.__yyCtl.ctl;

    injectCss(document);
    el.classList.add('yy-root');
    el.setAttribute('data-yy-view', view);

    var fn = VIEWS[view];
    if (!fn) {
      el.innerHTML = '<div class="yy-empty">未知视图：' + esc(view) + '</div>';
      return null;
    }

    if (!el.__yyClick) {
      el.__yyClick = function (e) {
        if (typeof el.__yyHandler === 'function') el.__yyHandler(e);
      };
      el.addEventListener('click', el.__yyClick);
    }
    el.__yyHandler = null;

    var ctl = fn(el, opts) || {};
    el.__yyHandler = typeof ctl.onClick === 'function' ? ctl.onClick : null;
    el.__yyCtl = { view: view, ctl: ctl };
    track('view_mount', { view: view });

    // 落地自动绑定：URL 带 ref（或此前存过）且已登录时执行一次。
    // 放这里而不是启动时：宿主可能先渲染再登录，绑定逻辑要跟着"身份可用"这一刻走。
    autoBind(opts);

    return ctl;
  }

  /** 卸载：只解绑自己绑的监听，不动宿主其他东西 */
  function unmount(target) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return false;
    if (el.__yyClick) el.removeEventListener('click', el.__yyClick);
    el.__yyClick = null;
    el.__yyHandler = null;
    el.__yyCtl = null;
    el.removeAttribute('data-yy-view');
    el.innerHTML = '';
    return true;
  }

  /* ================================================================
   * 5. 导出
   * ================================================================ */

  var Yangyu = {
    __v: VERSION,
    contract: CONTRACT,
    configure: configure,
    state: _S,
    // 数据层
    bootstrap: bootstrap,
    meta: meta,
    getProjects: getProjects,
    getProject: getProject,
    purchase: purchase,
    getMine: getMine,
    getNotices: getNotices,
    readNotice: readNotice,
    checkin: checkin,
    getMerchantConsole: getMerchantConsole,
    getOpsConsole: getOpsConsole,
    designCard: designCard,
    reviewCard: reviewCard,
    extendPeriod: extendPeriod,
    // 分享（第三代：谁分享绑定谁的关系，绑定即解锁全部卡）
    getShareLink: getShareLink,
    bindShare: bindShare,
    autoBind: autoBind,
    refreshShare: refreshShare,
    getShareChain: getShareChain,
    openShare: openShare,
    // 渲染层
    mount: mount,
    unmount: unmount,
    toast: toast,
    // 低阶
    raw: http,
    track: track,
    util: { money: money, statusText: STATUS_TEXT, actionText: ACTION_TEXT }
  };

  if (Octo) Octo[NS] = Yangyu;
  // 无 core 的宿主（老页面）也能用：挂全局名，但不覆盖已有更高版本
  if (!global.OctoYangyu || !global.OctoYangyu.__v) global.OctoYangyu = Yangyu;
})(window);
