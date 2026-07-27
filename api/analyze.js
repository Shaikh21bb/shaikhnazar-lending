export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { leads, pdfText } = req.body;

        if (!leads && !pdfText) {
            return res.status(400).json({ error: 'Invalid input: expected "leads" array or "pdfText" string.' });
        }

        // We prepare the prompt for Google Gemini
        const promptText = `
            Ты — эксперт-аналитик по продажам. Я отправляю тебе данные о зрителях вебинара (либо в виде JSON массива, либо в виде прикрепленного PDF файла).
            Твоя задача — проанализировать их и вернуть только "теплых" лидов в формате валидного JSON-массива.
            
            Критерии "теплого" лида:
            1. Зритель посмотрел более 70% вебинара (если указано время или процент в полях вроде "watchTime", "прогресс", "время просмотра" и т.д.).
            2. Зритель НЕ совершил покупку (ищи поля "buy", "купил", "покупка", "статус" со значением false, "нет", "0", пустые и т.д.).
            
            Верни ТОЛЬКО JSON-массив объектов. Без форматирования markdown (без \`\`\`json), просто чистый массив.
            Каждый объект должен иметь такую структуру:
            {
                "name": "Имя зрителя",
                "contact": "Email или телефон",
                "watchTime": "Время или % просмотра"
            }
            
            Если подходящих лидов нет, верни пустой массив [].
        `;

        let finalPrompt = promptText;

        let parts = [];

        if (pdfText) {
            // Document text extracted from frontend
            const limitedText = pdfText.substring(0, 30000); // Prevent exceeding token limits wildly
            finalPrompt += `\n\nДанные из PDF:\n${limitedText}`;
            parts = [{ text: finalPrompt }];
        } else if (leads) {
            // Limit the number of leads sent to Gemini to avoid token limits
            const limitedLeads = leads.slice(0, 150); 
            finalPrompt += `\n\nДанные зрителей:\n${JSON.stringify(limitedLeads)}`;
            parts = [{ text: finalPrompt }];
        }

        // Check if GEMINI_API_KEY is configured
        if (!process.env.GEMINI_API_KEY) {
            console.error('GEMINI_API_KEY is not set in environment variables');
            return res.status(500).json({ error: 'Server configuration error (Gemini API key missing)' });
        }

        // Call Google Gemini API using native fetch
        let geminiResponse;
        const modelsToTry = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-2.0-flash', 'gemini-pro', 'gemini-1.5-pro'];
        let lastErrorText = "";

        for (const modelName of modelsToTry) {
            geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: parts
                    }],
                    generationConfig: {
                        temperature: 0.1
                    }
                })
            });

            if (geminiResponse.ok) {
                break; // Success!
            } else {
                lastErrorText = await geminiResponse.text();
                console.error(`Model ${modelName} failed:`, geminiResponse.status, lastErrorText);
            }
        }

        if (!geminiResponse || !geminiResponse.ok) {
            return res.status(500).json({ error: 'Gemini API Error', details: lastErrorText });
        }

        const data = await geminiResponse.json();
        
        // Extract text from Gemini response
        let aiResult = "";
        try {
            aiResult = data.candidates[0].content.parts[0].text.trim();
        } catch (e) {
            console.error("Unexpected Gemini response structure:", data);
            return res.status(500).json({ error: 'Unexpected response from Gemini' });
        }
        
        // Safety: sometimes AI still wraps in ```json ... ``` despite instructions
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
