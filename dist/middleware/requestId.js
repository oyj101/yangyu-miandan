"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUEST_ID_HEADER = void 0;
exports.requestId = requestId;
const crypto_1 = require("crypto");
exports.REQUEST_ID_HEADER = "x-request-id";
function requestId(req, res, next) {
    const id = req.headers[exports.REQUEST_ID_HEADER] || (0, crypto_1.randomUUID)();
    req.requestId = id;
    res.setHeader(exports.REQUEST_ID_HEADER, id);
    next();
}
//# sourceMappingURL=requestId.js.map