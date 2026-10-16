"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.created = created;
exports.page = page;
function ok(res, data, status = 200) {
    res.status(status).json({ ok: true, data });
}
function created(res, data) {
    res.status(201).json({ ok: true, data });
}
function page(res, items, total, page, pageSize) {
    res.status(200).json({ ok: true, data: { items, total, page, pageSize } });
}
//# sourceMappingURL=http.js.map