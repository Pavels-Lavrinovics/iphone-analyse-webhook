import 'dotenv/config';
import express from 'express';

const { PORT = 3000, WEBHOOK_SECRET, NOTION_TOKEN, NOTION_DATA_SOURCE_ID, OPENAI_API_KEY } = process.env;

for (const [name, val] of Object.entries({ WEBHOOK_SECRET, NOTION_TOKEN, NOTION_DATA_SOURCE_ID, OPENAI_API_KEY })) {
  if (!val || val.startsWith('впиши') || val.startsWith('secret_xxx') || val.startsWith('sk-proj-xxx')) {
    console.error(`${name} не задан в .env — заполни его настоящим значением.`);
    process.exit(1);
  }
}

const NOTION_VERSION = '2025-09-03';
const NOTION_API = 'https://api.notion.com/v1';

const app = express();
app.use(express.json({ limit: '5mb' }));

// Простой эндпоинт, чтобы проверить, что сервер вообще жив —
// открой в браузере http://localhost:3000/health, должен ответить "OK"
app.get('/health', (req, res) => res.send('OK'));

app.post('/analyse', (req, res) => {
  res.status(200).send('OK');
  handleWebhook(req).catch((err) => console.error('Ошибка обработки:', err));
});

async function handleWebhook(req) {
  const secret = req.header('x-webhook-secret');
  if (secret !== WEBHOOK_SECRET) {
    console.warn('Секрет не совпал — игнорирую запрос');
    return;
  }

  const page = req.body?.data;
  if (!page) {
    console.error('В payload нет data — что-то не так со структурой запроса');
    return;
  }

  const pageId = page.id;
  const link = page.properties?.Link?.url ?? null;
  const index = page.properties?.INDEX?.unique_id?.number ?? null;
  const snapshotFile = page.properties?.['Page snapshot']?.files?.[0];
  const snapshotUrl = snapshotFile?.file?.url ?? null;

  console.log('\n=== Строка получена ===');
  console.log('page id:', pageId);
  console.log('INDEX:', index);
  console.log('Link:', link);
  console.log('Есть ли файл скриншота:', !!snapshotUrl);

  if (!snapshotUrl) {
    console.error('Нет ссылки на файл — дальше идти некуда, тут в реальном коде будет Needs review');
    return;
  }

  // Скачиваем скриншот СРАЗУ, пока ссылка не протухла
  const imgResp = await fetch(snapshotUrl);
  if (!imgResp.ok) {
    console.error(`Не удалось скачать файл: HTTP ${imgResp.status}`);
    return;
  }
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  const outPath = `./last-downloaded-screenshot.png`;
  await import('node:fs/promises').then((fs) => fs.writeFile(outPath, buffer));
  console.log(`Скриншот скачан и сохранён: ${outPath} (${buffer.length} байт)`);

  // --- Проверка дублей ---
  const adId = extractAdId(link);
  console.log('ID объявления из ссылки:', adId);

  if (!adId) {
    console.warn('Не удалось вытащить ID объявления из ссылки — ставлю Needs review вручную');
    await updateStatusAndFlags(pageId, 'Needs review', ['Description is ambiguous']);
    return;
  }

  const duplicatePageId = await findDuplicateAdId(adId, pageId);

  if (duplicatePageId) {
    console.log(`Найден дубль: ${duplicatePageId}`);
    await updateStatusAndFlags(pageId, 'Needs review', ['Possible duplicate']);
    console.log('Записал Status=Needs review, Flags=Possible duplicate. Останавливаюсь, в OpenAI не отправляю.');
  } else {
    console.log('Дублей не найдено, объявление уникально.');
    await updateStatusAndFlags(pageId, 'Processing', []);
    console.log('Записал Status=Processing.');

    console.log('\n--- Отправляю скриншот в gpt-4o-mini ---');
    const analysis = await analyseScreenshot(buffer, imgResp.headers.get('content-type') || 'image/png');
    console.log('--- Ответ модели ---');
    console.log(JSON.stringify(analysis, null, 2));
    console.log('(Пока НЕ записываю это в Notion — просто смотрим, что вернула модель)');
  }

  console.log('=== Готово ===\n');
}

const SYSTEM_PROMPT = `
Ты анализируешь один скриншот объявления о продаже iPhone с OLX Poland (сайт может быть на польском).
Отвечай СТРОГО в формате JSON, без markdown-обёртки и без текста до/после JSON.

Схема ответа:
{
  "model": "одно из: 15, 15 Plus, 15 Pro, 15 Pro Max, 16, 16 Plus, 16 Pro, 16 Pro Max, 17, 17 Air, 17 Pro, 17 Pro Max — или null, если модели нет в этом списке",
  "storage": "одно из: 128, 256, 512, 1TB, 2TB, NA",
  "color": "точное название цвета из палитры Apple для этой модели (см. правило ниже)",
  "grade": "одно из: S, A, B, C, D, Not enough info",
  "battery_percent": число от 0 до 100 (например 92), или null если % не указан явно в тексте — НЕ округляй и не гадай,
  "icloud": "одно из: Blocked, Unblocked, NA",
  "accessories": "одно из: Full kit, W box only, W cable, Phone only, NA",
  "faceid": "одно из: Works, Broken, NA",
  "price_pln": число (только цифра, без валюты) или null,
  "sim": "одно из: Dual SIM, Dual Sim (SIM + eSIM), Single SIM, eSIM, NA",
  "info_tags": ["массив из нуля или более: Offers delivery, Rich description, Aged OLX account, With warranty, Account with good reviews, Poor description, Too low price, Too high price, Account without reviews, Glass cracked, For parts, Needs repair, Some parts replaced (possibly non-original)"],
  "flags": ["массив из нуля или более: Description is ambiguous, Unsupported data, All good"],
  "notes": "1-2 предложения человеческим языком — почему поставлены такие flags, если они есть"
}

ПРАВИЛА:

Grade (строго по battery% и состоянию):
- S = новый, нераспакованный.
- A = 92-100% батарея, б/у но как новый, без царапин.
- B = 85-92% батарея, б/у, без крупных царапин, но заметен естественный износ.
- C = 80-85% батарея, видимые царапины/потёртости, но стекло НЕ треснуто.
- D = стекло треснуто ИЛИ что-то не работает — независимо от battery%.
- Not enough info = данных недостаточно.
Если Grade и Battery% из текста объявления не сходятся по этой таблице — всё равно проставь оба значения как есть в объявлении, но добавь flag "Description is ambiguous" и опиши несостыковку в notes. Не подгоняй одно под другое.

Color: для Pro/Pro Max моделей начиная с 15 Pro цвет — это titanium-вариант (Black/White/Natural/Blue/Desert Titanium), даже если продавец в тексте написал просто "Black" — сверяйся с реальной палитрой этой модели, а не с текстом продавца буквально.

Battery: указывай число ТОЛЬКО если % явно написан в тексте объявления. Если сказано что-то вроде "новая батарея" без цифры — оставляй null, не угадывай.

FaceID: "Works" только если явно подтверждено текстом. "Broken" только если явно сказано, что не работает. Если состояние сомнительное (сильные повреждения корпуса, но FaceID отдельно не упомянут) — ставь "NA", не делай вывод сам.

Info tags — логика:
- Rich description, если в тексте описания 3+ строки (или меньше, но покрывает большинство характеристик), иначе Poor description.
- "Some parts replaced (possibly non-original)" — если продавец пишет о замене экрана/батареи/крышки без подтверждения оригинальности детали Apple. Это НЕ то же самое, что "Needs repair"/"For parts" — сам телефон может быть в отличном состоянии.
- Не проставляй "Too low price"/"Too high price" от себя, если это не подкреплено явным основанием в тексте объявления (например продавец сам пишет "срочная продажа, отдам дёшево") — если сомневаешься, не ставь тег вообще.

Flags:
- "Unsupported data" — если на скриншоте виден iPhone, которого нет в списке моделей выше (например iPhone 14 или старше). В этом случае поле "model" оставь null, но остальные поля (storage/color/battery и т.д.) всё равно заполни по возможности — это может пригодиться человеку при ручной проверке.
- "Description is ambiguous" — если в тексте объявления есть противоречивая информация (см. также правило Grade/Battery выше).
- "All good" — если ни одна из вышеуказанных проблем не применима.
- НЕ используй флаг "Possible duplicate" — это решается отдельно, не на основе скриншота.

Если какая-то информация не упомянута в объявлении вообще — выбирай "NA", если это доступный вариант для поля, иначе оставляй поле null. Не выдумывай данные, которых нет на скриншоте.
`.trim();

async function analyseScreenshot(imageBuffer, mimeType) {
  const base64 = imageBuffer.toString('base64');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API -> ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

function extractAdId(url) {
  // Пример: .../gwarancja-CID99-ID1a5VVW.html?... -> "1a5VVW"
  // Важно: искать именно "-ID<...>.html" в конце, а не первое попавшееся "ID" —
  // иначе цепляется за случайные подстроки типа "CID99".
  const match = url.match(/-ID([A-Za-z0-9]+)\.html/);
  return match ? match[1] : null;
}

async function findDuplicateAdId(adId, currentPageId) {
  const result = await notionRequest(`/data_sources/${NOTION_DATA_SOURCE_ID}/query`, 'POST', {
    filter: {
      property: 'Link',
      url: { contains: adId },
    },
  });
  const other = (result.results ?? []).find((r) => r.id !== currentPageId);
  return other?.id ?? null;
}

async function updateStatusAndFlags(pageId, statusName, flagNames) {
  await notionRequest(`/pages/${pageId}`, 'PATCH', {
    properties: {
      'Status': { status: { name: statusName } },
      'Flags': { multi_select: flagNames.map((name) => ({ name })) },
    },
  });
}

async function notionRequest(path, method, body) {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion API ${method} ${path} -> ${resp.status}: ${text}`);
  }
  return resp.json();
}

app.listen(PORT, () => {
  console.log(`Тестовый сервер слушает на http://localhost:${PORT}`);
  console.log(`Проверка живости: http://localhost:${PORT}/health`);
});