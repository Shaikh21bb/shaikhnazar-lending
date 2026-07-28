export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { leads, pdfText, managersCount } = req.body;

        if (!leads && !pdfText) {
            return res.status(400).json({ error: 'Invalid input: expected "leads" array or "pdfText" string.' });
        }

        const numManagers = parseInt(managersCount) || 1;

        const promptText = `
Ты — ведущий дата-аналитик и эксперт по оптимизации воронки продаж.

Мне нужно найти скрытое «золото» в этой базе — самых горячих целевых клиентов, которые проявили максимальный интерес, но по какой-то причине не дошли до покупки. Отдел продаж должен забрать этот список в работу в первую очередь.

Проведи глубокий анализ данных по следующим шагам:

1. ФИЛЬТРАЦИЯ (ИСКЛЮЧЕНИЕ):
   Полностью исключи из финального отчета всех клиентов, у которых в статусе стоит «Купил», «Оплачено», «Купить», «bought», «paid» или есть любые другие маркеры совершённой покупки. Они нам НЕ нужны.

2. ВЫЯВЛЕНИЕ «ГОРЯЧИХ ЛИДОВ»:
   Сформируй список потенциальных покупателей, которые:
   - НЕ купили продукт
   - Досмотрели вебинар до конца (максимальное или близкое к максимальному время нахождения в комнате / высокий процент удержания)
   - Отранжируй их по убыванию времени участия (от самых стойких к менее стойким)

3. ГЛУБОКИЙ АНАЛИЗ КАЖДОГО ЛИДА:
   Для каждого горячего лида дополнительно определи:
   - "need" (потребность): Исходя из имени, времени просмотра, контекста — предположи вероятную потребность клиента (например: "Хочет сменить профессию", "Повышение квалификации", "Интерес к онлайн-образованию", "Вероятно ищет работу").
   - "probability" (вероятность продажи): Оцени вероятность покупки — строго одно из трёх значений: "Высокая", "Средняя" или "Низкая". Основывай на времени просмотра: 90-100% = Высокая, 70-89% = Средняя, ниже = Низкая.

4. РАСПРЕДЕЛЕНИЕ ПО МЕНЕДЖЕРАМ:
   Раздели итоговый список лидов равномерно на ${numManagers} менеджер(ов).
   Менеджеры нумеруются: «Менеджер 1», «Менеджер 2» и т.д.
   Каждый лид должен быть назначен только одному менеджеру.

5. ИТОГОВЫЙ JSON:
   Верни ТОЛЬКО валидный JSON-массив. Без markdown-форматирования (без \`\`\`json). Просто чистый массив.
   Каждый объект ОБЯЗАТЕЛЬНО должен иметь следующую структуру:
   {
     "name": "Имя участника",
     "contact": "Email или телефон",
     "watchTime": "Время участия в минутах или % досмотра",
     "verdict": "Краткий аналитический вердикт (1-2 предложения)",
     "need": "Предполагаемая потребность клиента",
     "probability": "Высокая | Средняя | Низкая",
     "manager": "Менеджер 1"
   }

Если подходящих лидов нет, верни пустой массив [].
        `;

        let finalPrompt = promptText;
        let parts = [];

        if (pdfText) {
            const limitedText = pdfText.substring(0, 30000);
            finalPrompt += `\n\nДанные из PDF:\n${limitedText}`;
            parts = [{ text: finalPrompt }];
        } else if (leads) {
            const limitedLeads = leads.slice(0, 200);
            finalPrompt += `\n\nДанные зрителей:\n${JSON.stringify(limitedLeads)}`;
            parts = [{ text: finalPrompt }];
        }

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'Server configuration error (Gemini API key missing)' });
        }

        let geminiResponse;
        const modelsToTry = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-pro-latest', 'gemini-2.0-flash'];
        let lastErrorText = "";

        for (const modelName of modelsToTry) {
            geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: parts }],
                    generationConfig: { temperature: 0.1 }
                })
            });

            if (geminiResponse.ok) break;
            lastErrorText = await geminiResponse.text();
            console.error(`Model ${modelName} failed:`, geminiResponse.status, lastErrorText);
        }

        if (!geminiResponse || !geminiResponse.ok) {
            let availableModels = "Could not fetch models";
            try {
                const modelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
                if (modelsRes.ok) {
                    const modelsData = await modelsRes.json();
                    availableModels = modelsData.models
                        .filter(m => m.supportedGenerationMethods.includes("generateContent"))
                        .map(m => m.name.replace('models/', ''))
                        .join(', ');
                }
            } catch (e) { console.error("Error fetching models list", e); }
            return res.status(500).json({ error: 'Gemini API Error', details: `Ни одна модель не подошла. Доступные: ${availableModels}. Ошибка: ${lastErrorText}` });
        }

        const data = await geminiResponse.json();
        let aiResult = "";
        try {
            aiResult = data.candidates[0].content.parts[0].text.trim();
        } catch (e) {
            return res.status(500).json({ error: 'Unexpected response from Gemini' });
        }

        if (aiResult.startsWith('```json')) {
            aiResult = aiResult.replace(/^```json/, '').replace(/```$/, '').trim();
        } else if (aiResult.startsWith('```')) {
            aiResult = aiResult.replace(/^```/, '').replace(/```$/, '').trim();
        }

        const warmLeads = JSON.parse(aiResult);
        return res.status(200).json({ warmLeads });

    } catch (error) {
        console.error("API Analyze Error:", error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
