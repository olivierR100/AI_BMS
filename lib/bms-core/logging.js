'use strict';
/*
 * Journal des appels API pour le moniteur du dashboard
 *
 * Tampon circulaire structuré. Les clés d'API ne sont jamais journalisées.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installLogging(ctx) {
    const { global, node, env } = ctx;

// ===== API call log (structured ring buffer, ~1 MB) for the dashboard monitor =====
// Each entry: { ts, kind, summary, detail }. Expandable in the UI to show full
// request/response bodies. API KEYS ARE NEVER LOGGED (they live in headers, which
// are not recorded — only model/url/messages/status/tokens/errors).
(function () {
    const lg = global.get('aiApiLog');
    if (!Array.isArray(lg) || (lg.length && typeof lg[0] !== 'object')) global.set('aiApiLog', []);
})();
global.set('aiLogMax', 1000000);
global.set('aiLog', function(kind, summary, detail) {
    const ts = new Date().toISOString().slice(11, 19);
    let detailStr = '';
    if (detail !== undefined && detail !== null) {
        try { detailStr = (typeof detail === 'string') ? detail : JSON.stringify(detail, null, 2); }
        catch (e) { detailStr = String(detail); }
    }
    if (detailStr.length > 24000) detailStr = detailStr.slice(0, 24000) + '\n…[truncated, ' + detailStr.length + ' chars]';
    const buf = global.get('aiApiLog') || [];
    buf.push({ ts: ts, kind: kind, summary: summary, detail: detailStr });
    let total = buf.reduce(function(s, e) { return s + e.summary.length + e.detail.length + 40; }, 0);
    const max = global.get('aiLogMax') || 1000000;
    while (total > max && buf.length > 1) { const r = buf.shift(); total -= (r.summary.length + r.detail.length + 40); }
    global.set('aiApiLog', buf);
    return buf;
});
// Size-bounded copy of a request payload for logging (long content fields truncated).
global.set('aiLogTrim', function(payload) {
    const trunc = function(s) { return (typeof s === 'string' && s.length > 1500) ? s.slice(0, 1500) + ' …[' + s.length + ' chars]' : s; };
    const clone = { model: payload.model };
    ['max_tokens', 'max_completion_tokens', 'reasoning_effort', 'tool_choice', 'temperature'].forEach(function(k) {
        if (payload[k] !== undefined) clone[k] = payload[k];
    });
    if (payload.tools) clone.tools = payload.tools.map(function(t) { return t.name || (t.function && t.function.name); });
    if (payload.system) {
        const sys = Array.isArray(payload.system)
            ? payload.system.map(function(b) { return (b.cache_control ? '[cached] ' : '') + (b.text || ''); }).join('\n')
            : String(payload.system);
        clone.system = trunc(sys);
    }
    clone.messages = (payload.messages || []).map(function(m) {
        const out = { role: m.role };
        if (typeof m.content === 'string') out.content = trunc(m.content);
        else if (Array.isArray(m.content)) out.content = m.content.map(function(b) {
            const bb = Object.assign({}, b);
            if (bb.text) bb.text = trunc(bb.text);
            if (typeof bb.content === 'string') bb.content = trunc(bb.content);
            if (bb.input) bb.input = b.input;
            return bb;
        });
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.reasoning_content) out.reasoning_content = trunc(String(m.reasoning_content));   // verify thinking-mode round-trip in the log
        return out;
    });
    return clone;
});
};
