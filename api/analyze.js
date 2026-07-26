export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { leads } = req.body;

        if (!leads || !Array.isArray(leads)) {
            return res.status(400).json({ error: 'Invalid input: expected an array of leads in the body.' });
        }

        // Limit the number of leads sent to OpenAI to avoid token limits (optional, but good practice)
        // You might want to implement a more robust batching mechanism if CSVs are very large.
        const limitedLeads = leads.slice(0, 150); 

        // We prepare the prompt for OpenAI
        const prompt = `
            Я отправляю тебе JSON-массив данных о зрителях вебинара.
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

            Данные зрителей:
            ${JSON.stringify(limitedLeads)}
        `;

        // Check if OPENAI_API_KEY is configured
        if (!process.env.OPENAI_API_KEY) {
            console.error('OPENAI_API_KEY is not set in environment variables');
            return res.status(500).json({ error: 'Server configuration error (OpenAI API key missing)' });
        }

        // Call OpenAI API using native fetch
        const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini', // Using gpt-4o-mini for speed and cost-efficiency
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert sales analyst assistant. You strictly output raw JSON arrays without markdown wrappers.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.1
            })
        });

        if (!openAiResponse.ok) {
            const errorText = await openAiResponse.text();
            console.error('OpenAI Error:', openAiResponse.status, errorText);
            throw new Error(`OpenAI API error: ${openAiResponse.statusText}`);
        }

        const data = await openAiResponse.json();
        
        let aiResult = data.choices[0].message.content.trim();
        
        // Safety: sometimes OpenAI still wraps in ```json ... ``` despite instructions
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
