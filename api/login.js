export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Пожалуйста, введите логин и пароль.' });
    }

    // В Vercel вы добавите ссылку на опубликованный CSV файл Google Таблицы
    const sheetCsvUrl = process.env.GOOGLE_SHEET_CSV_URL;

    try {
        if (!sheetCsvUrl) {
            // Режим по умолчанию, если ссылка еще не добавлена
            if (email === 'admin' && password === 'admin') {
                return res.status(200).json({ success: true, token: 'admin_token' });
            }
            return res.status(500).json({ error: 'База данных Google Таблиц еще не подключена.' });
        }

        // Скачиваем данные из Google Таблицы
        const response = await fetch(sheetCsvUrl);
        if (!response.ok) {
            throw new Error('Failed to fetch Google Sheet');
        }
        
        const csvText = await response.text();
        
        // Простой парсинг CSV (ожидаем колонки: логин, пароль)
        const lines = csvText.split('\n');
        let isAuthenticated = false;

        for (let i = 1; i < lines.length; i++) { // Пропускаем заголовок (i=1)
            const line = lines[i].trim();
            if (!line) continue;
            
            // Разделяем по запятой
            const [sheetLogin, sheetPassword] = line.split(',').map(s => s.replace(/(^"|"$)/g, '').trim());
            
            if (sheetLogin === email && sheetPassword === password) {
                isAuthenticated = true;
                break;
            }
        }

        if (isAuthenticated) {
            return res.status(200).json({ success: true, token: 'user_token_' + Date.now(), email });
        } else {
            return res.status(401).json({ error: 'Неверный логин или пароль.' });
        }

    } catch (error) {
        console.error("Login API Error:", error);
        return res.status(500).json({ error: 'Внутренняя ошибка сервера при проверке пароля.' });
    }
}
