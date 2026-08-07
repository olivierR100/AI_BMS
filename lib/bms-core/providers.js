'use strict';
/*
 * Couche d'adaptation multi-fournisseurs (Anthropic / OpenAI / DeepSeek / Mistral)
 *
 * Historique interne neutre, traduit par fournisseur au moment de la requête.
 *
 * Extrait verbatim du nœud « Initialize System (V12) ». Le corps reçoit le
 * contexte du nœud Node-RED : `global` (contexte global), `node` (statut et
 * journal), `env` (variables d'environnement).
 */

module.exports = function installProviders(ctx) {
    const { global, node, env } = ctx;

// ===== Multi-provider LLM adapter layer =====
// Each provider differs in endpoint, auth, message shape, and tool-call format.
// We keep a NEUTRAL internal history and translate per provider at request time:
//   neutral item: { role:'user', text }
//                 { role:'assistant', text, toolCalls:[{id,name,input}] }
//                 { role:'tool', results:[{id,name,content}] }
global.set('aiProviders', {
    // maxTokens = the output-token cap WE request. null = OMIT the param so the provider uses the
    // model's own maximum (best for providers that default to max when unset: OpenAI, Mistral).
    // Anthropic REQUIRES the param, and DeepSeek defaults LOW (4096) when unset, so those get an
    // explicit high value at the model's documented ceiling.
    anthropic: {
        label: 'Anthropic (Claude)', style: 'anthropic',
        url: 'https://api.anthropic.com/v1/messages',
        tokenParam: 'max_tokens', maxTokens: 64000, defaultModel: 'claude-sonnet-4-6',  // Sonnet/Haiku 4.x ceiling
        models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']
    },
    openai: {
        label: 'OpenAI (ChatGPT)', style: 'openai',
        url: 'https://api.openai.com/v1/chat/completions',
        tokenParam: 'max_completion_tokens', maxTokens: null, defaultModel: 'gpt-5.1',  // omit → model max
        models: ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'chatgpt-4o-latest']
    },
    deepseek: {
        // DeepSeek V4 (OpenAI-compatible). V4 supports a large output budget (set generously below);
        // truncation is still detected and a partial config is NOT applied as a safety net.
        // Thinking mode: set settings.reasoning to 'high'/'max' → reasoning_effort (see aiBuildRequest).
        // Legacy aliases deepseek-chat/deepseek-reasoner route to v4-flash and retire 2026-07-24.
        label: 'DeepSeek (V4)', style: 'openai', supportsReasoning: true,
        url: 'https://api.deepseek.com/v1/chat/completions',
        tokenParam: 'max_tokens', maxTokens: 65536, defaultModel: 'deepseek-v4-flash',
        models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']
    },
    mistral: {
        // Mistral (https://docs.mistral.ai/api) — OpenAI-compatible chat completions + tool calling.
        label: 'Mistral', style: 'openai',
        url: 'https://api.mistral.ai/v1/chat/completions',
        tokenParam: 'max_tokens', maxTokens: null, defaultModel: 'mistral-large-latest',  // omit → model max
        models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'magistral-medium-latest', 'codestral-latest']
    }
});

// Build a provider-specific HTTP request from neutral history + settings.
global.set('aiBuildRequest', function(history, settings) {
    const providers = global.get('aiProviders');
    const provider = (settings && settings.provider) || 'anthropic';
    const p = providers[provider] || providers.anthropic;
    const key = (settings.keys && settings.keys[provider]) || '';
    const model = (settings.models && settings.models[provider]) || p.defaultModel;
    const buildPrompt = global.get('buildAIPrompt');
    const system = buildPrompt ? buildPrompt('tool') : 'You are a BMS automation expert.';
    const tools = global.get('aiChatTools') || [];

    if (p.style === 'anthropic') {
        const messages = history.map(m => {
            if (m.role === 'user') return { role: 'user', content: m.text };
            if (m.role === 'tool') return { role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) };
            const blocks = [];
            if (m.text) blocks.push({ type: 'text', text: m.text });
            (m.toolCalls || []).forEach(tc => blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }));
            return { role: 'assistant', content: blocks.length ? blocks : (m.text || '') };
        });
        // Prompt caching: cache the large STATIC prefix of the system prompt (everything before the
        // dynamic "CURRENT SYSTEM STATE" section) so repeated requests in a multi-pass turn reuse it
        // — big saving on Anthropic input-token cost and rate limits. (OpenAI/DeepSeek auto-cache.)
        const cut = system.indexOf('# CURRENT SYSTEM STATE');
        const systemBlocks = (cut > 200)
            ? [{ type: 'text', text: system.slice(0, cut), cache_control: { type: 'ephemeral' } }, { type: 'text', text: system.slice(cut) }]
            : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        const payload = { model, system: systemBlocks, messages, tools };
        if (p.maxTokens != null) payload[p.tokenParam] = p.maxTokens;   // null = omit -> model max
        return { url: p.url, method: 'POST',
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            payload };
    }

    // OpenAI-compatible (OpenAI + DeepSeek V4)
    const thinking = p.supportsReasoning && settings.reasoning && settings.reasoning !== 'off';
    const messages = [{ role: 'system', content: system }];
    history.forEach(m => {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        // tool messages MUST have non-null content (DeepSeek thinking-mode constraint)
        else if (m.role === 'tool') m.results.forEach(r => messages.push({ role: 'tool', tool_call_id: r.id, content: r.content || '' }));
        else {
            const am = { role: 'assistant', content: m.text || null };
            if ((m.toolCalls || []).length) am.tool_calls = m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }));
            // preserve reasoning_content across the tool round-trip (DeepSeek thinking-mode constraint)
            if (m.reasoning) am.reasoning_content = m.reasoning;
            messages.push(am);
        }
    });
    const payload = { model, messages,
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) };
    // tool_choice is REJECTED in DeepSeek thinking mode; 'auto' is the default everywhere, so we
    // only set it when NOT thinking (and could omit entirely — kept for explicitness off-thinking).
    if (!thinking) payload.tool_choice = 'auto';
    if (thinking) payload.reasoning_effort = settings.reasoning;   // 'high' | 'max'
    if (p.maxTokens != null) payload[p.tokenParam] = p.maxTokens;   // null = omit -> model max
    return { url: p.url, method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'content-type': 'application/json' },
        payload };
});

// Normalize a provider response into { ok, error, text, toolCalls:[{id,name,input}], stop:'tool'|'end' }
global.set('aiParseResponse', function(style, statusCode, body) {
    if (style === 'anthropic') {
        if (statusCode !== 200 || !body || !body.content) {
            return { ok: false, error: (body && body.error && body.error.message) || ('API error (HTTP ' + statusCode + ')') };
        }
        const text = body.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        const toolCalls = body.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
        const u = body.usage || {};
        return { ok: true, text, toolCalls, stop: body.stop_reason === 'tool_use' ? 'tool' : 'end',
            truncated: body.stop_reason === 'max_tokens',
            usage: { in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens } };
    }
    // openai-compatible
    if (statusCode !== 200 || !body || !body.choices || !body.choices[0]) {
        return { ok: false, error: (body && body.error && body.error.message) || ('API error (HTTP ' + statusCode + ')') };
    }
    const m = body.choices[0].message || {};
    const text = (m.content || '').trim();
    const toolCalls = (m.tool_calls || []).map(tc => {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* leave empty on malformed args */ }
        return { id: tc.id, name: tc.function.name, input };
    });
    const u = body.usage || {};
    return { ok: true, text, toolCalls, stop: body.choices[0].finish_reason === 'tool_calls' ? 'tool' : 'end',
        truncated: body.choices[0].finish_reason === 'length',
        reasoning: m.reasoning_content || m.reasoning,   // DeepSeek/Mistral thinking mode — preserved across tool round-trips
        // OpenAI & DeepSeek auto-cache; surface cached prompt tokens when reported
        usage: { in: u.prompt_tokens, out: u.completion_tokens, cacheRead: u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) } };
});
};
