import { LocalModel } from './model.mjs';
import { assessDraft, delegatePrompt, whatsappHistory } from '../lib/whatsapp-policy.mjs';

// Only new per-chat conversation context and explicit owner rules reach this
// model. It has no access to a vault, imported phone history or external tools.
export class LocalWhatsAppModel {
    constructor({ url = 'http://127.0.0.1:11434', model = '', fetchImpl = fetch } = {}) {
        this.local = new LocalModel({ url, model, fetchImpl });
    }

    async generate({ agent, text, history }) {
        const input = String(text || '').trim();
        if (!input || input.length > 8000) throw new Error('Invalid WhatsApp draft input');
        const status = await this.local.status();
        if (!status.ready) throw new Error('Local WhatsApp model unavailable');
        const messages = [
            { role: 'system', content: delegatePrompt(agent || {}) },
            ...whatsappHistory(history),
            { role: 'user', content: input }
        ];
        const openAI = this.local.protocol === 'openai';
        const response = await this.local.fetch(this.local.endpoint(openAI ? '/chat/completions' : '/api/chat'), {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(90_000),
            body: JSON.stringify(openAI
                ? { model: status.model, messages, stream: false, temperature: 0.2,
                    max_tokens: 600, response_format: { type: 'json_object' } }
                : { model: status.model, messages, stream: false, format: 'json',
                    ...(this.local.supportsThinking ? { think: false } : {}),
                    options: { temperature: 0.2, num_ctx: 8192, num_predict: 600 } })
        });
        if (!response.ok) throw new Error('Local WhatsApp model unavailable');
        const data = await response.json();
        const content = openAI ? data.choices?.[0]?.message?.content : data.message?.content;
        if (typeof content !== 'string' || content.length > 20_000) throw new Error('Invalid local WhatsApp draft');
        return { ...assessDraft(input, content, { agent }), provider: 'local' };
    }
}
