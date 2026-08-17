import { db, gemini, escapeHtml } from './_lib.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { offer, audience, context, language } = await new Promise(resolve => {
            let raw = '';
            req.on('data', c => raw += c);
            req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
        });

        if (!offer) {
            return res.status(400).json({ error: 'Missing offer' });
        }

        const audienceText = audience ? `Целевая аудитория: ${audience}.` : 'Целевая аудитория: посетители вебинара.';
        const contextText = context ? `Детали оффера: ${context}.` : 'Цены и бонусы не указаны — оставь заполнители [цифра].';
        const langText = language === 'kk'
            ? 'Напиши ВЕСЬ скрипт ПОЛНОСТЬЮ НА КАЗАХСКОМ ЯЗЫКЕ (Қазақша), простым и понятным разговорным казахским. Реплики менеджера — на казахском. Не мешай с русским.'
            : 'Напиши ВЕСЬ скрипт на русском языке, простым разговорным русским.';

        const systemPrompt = `
Ты — Джордан Белфорт («Волк с Уолл-стрит»), выступающий как тренер по продажам. Ты обучаешь менеджера по системе STRAIGHT LINE (Прямая линия): напор, энергия, уверенность, чувство срочности, принцип «Always Be Closing» (ABC).

Твоя задача — написать УНИВЕРСАЛЬНЫЙ продающий скрипт, который менеджер будет читать ВСЛУХ любому клиенту. НЕ пиши под конкретного клиента: без имён, без телефонов, без личных деталей. Обращайся к клиенту нейтрально на «вы».

ОФФЕР (что продаём):
${escapeHtml(offer)}

${audienceText}

${contextText}

СТРУКТУРА СКРИПТА (обязательно в этом порядке, реплики от первого лица менеджера):
1. НАЗВАНИЕ И ОТКРЫТИЕ — интригующее представление, почему мы звоним/пишем именно сейчас, короткий контакт.
2. ВЫЯВЛЕНИЕ ПОТРЕБНОСТЕЙ — 4-5 открытых вопросов, чтобы клиент сам рассказал о боли и ситуации (вопросы под целевую аудиторию).
3. БОЛЬ И ВЫГОДА — отзеркаль то, что сказал клиент, усиль боль, покажи как наш продукт решает её.
4. ЦЕННОСТЬ ПРЕДЛОЖЕНИЯ — что конкретно клиент получит, преимущества, бонусы.
5. СРОЧНОСТЬ И ЭКСКЛЮЗИВ — ограниченное предложение, почему решать надо сейчас.
6. ОБРАБОТКА ВОЗРАЖЕНИЙ — 3 типовых возражения («дорого», «подумаю», «нет времени»), на каждое 1-2 реплики по системе Белфорта.
7. ЗАКРЫТИЕ — прямо просишь решение: выбираешь дату, время, следующий шаг.

СТИЛЬ:
- Дерзкий, уверенный, с юмором, без канцелярита и «маркетинговой воды».
- Короткие рубленые фразы. Эмоциональные акценты, усиление голоса в ключевых местах.
- ${langText}
- Не выдумывай конкретные цифры, если их нет — оставь заполнитель [цифра].

ФОРМАТ:
Каждая реплика начинается с роли в квадратных скобках: [Менеджер] или [Клиент]. Клиент отвечает коротко и скептически, как живой человек из целевой аудитории.
Объём: 25-35 реплик. Начни сразу со скрипта, без вступлений и пояснений.
`;

        const userMessage = `Составь универсальный продающий скрипт в стиле Джордана Белфорта для оффера «${escapeHtml(offer)}».`;

        let script;
        try {
            script = await gemini(systemPrompt, '', userMessage);
        } catch (err) {
            console.error('Script gen error:', err.message);
            return res.status(500).json({ error: 'Gemini API error: ' + err.message });
        }

        const { res: insRes, body } = await db('scripts', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                lead_name: String(offer).slice(0, 200) || null,
                lead_need: audience ? String(audience).slice(0, 500) : null,
                script: script
            })
        });

        if (!insRes.ok) {
            console.error('Script save error:', insRes.status, JSON.stringify(body).slice(0, 200));
        }

        const saved = (Array.isArray(body) && body[0]) || null;
        return res.status(200).json({ ok: true, id: saved ? saved.id : null, script: script });
    } catch (error) {
        console.error('Script API error:', error);
        return res.status(500).json({ error: 'Internal error: ' + error.message });
    }
}