import 'dotenv/config';
import express from 'express';
import sharp from 'sharp';

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
  console.log(`Скриншот скачан (${buffer.length} байт)`);

  const metadata = await sharp(buffer).metadata();
  console.log(`Реальный размер картинки: ${metadata.width} x ${metadata.height} px`);

  // Обрезаем до верхней содержательной части — фиксированная высота в пикселях
  // ИСХОДНОГО разрешения (не пропорционально ширине!). При соотношении сторон,
  // близком к квадрату, OpenAI меньше ужимает картинку перед распознаванием —
  // а значит текст остаётся крупнее и читаемее.
  const CROP_HEIGHT = 5200;
  const cropHeight = Math.min(metadata.height, CROP_HEIGHT);
  const croppedBuffer = await sharp(buffer)
    .extract({ left: 0, top: 0, width: metadata.width, height: cropHeight })
    .png()
    .toBuffer();

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

    console.log('\n--- Отправляю ОБРЕЗАННЫЙ скриншот в gpt-5.6-luna ---');
    const analysis = await analyseScreenshot(croppedBuffer, 'image/png', 'gpt-5.6-luna');
    console.log('--- Ответ модели ---');
    console.log(JSON.stringify(analysis, null, 2));

    console.log('\n--- Записываю результат в Notion ---');
    await writeAnalysisToNotion(pageId, analysis);
    console.log('Готово: строка обновлена в Notion.');
  }

  console.log('=== Готово ===\n');
}

async function writeAnalysisToNotion(pageId, analysis) {
  const properties = {};

  const setSelect = (fieldName, value) => {
    if (value === null || value === undefined) return;
    properties[fieldName] = { select: { name: String(value) } };
  };
  const setNumber = (fieldName, value) => {
    if (value === null || value === undefined) return;
    properties[fieldName] = { number: value };
  };
  const setMultiSelect = (fieldName, values) => {
    properties[fieldName] = { multi_select: (values ?? []).map((name) => ({ name })) };
  };

  setSelect('Model', analysis.model);
  setSelect('Storage', analysis.storage);
  setSelect('Color', analysis.color);
  setSelect('Grade', analysis.grade);
  // Battery в Notion — number с percent-форматом: хранит именно то число, которое
  // положишь, и умножает на 100 при ОТОБРАЖЕНИИ. Значит 92% нужно записать как 0.92,
  // а не как 92 — иначе в таблице будет "9200%".
  if (analysis.battery_percent !== null && analysis.battery_percent !== undefined) {
    setNumber('Battery', analysis.battery_percent / 100);
  }
  setSelect('iCloud', analysis.icloud);
  setSelect('Accessories', analysis.accessories);
  setSelect('FaceID', analysis.faceid);
  setNumber('Price PLN', analysis.price_pln);
  setSelect('SIM', analysis.sim);
  setMultiSelect('Info tags', analysis.info_tags);

  // AI Notes — текстовое поле, куда переносим обоснование модели (что раньше
  // только печаталось в консоль). "AI Notes" в схеме имеет тип rich_text ("text").
  if (analysis.notes) {
    properties['AI Notes'] = { rich_text: [{ text: { content: String(analysis.notes) } }] };
  }

  // Flags и Status собираем по результату GPT (дубли уже обработаны раньше и сюда не доходят).
  const flags = analysis.flags && analysis.flags.length > 0 ? analysis.flags : ['All good'];
  setMultiSelect('Flags', flags);

  const hasIssue = flags.includes('Description is ambiguous') || flags.includes('Unsupported data');
  properties['Status'] = { status: { name: hasIssue ? 'Needs review' : 'Done' } };

  await notionRequest(`/pages/${pageId}`, 'PATCH', { properties });
}

const SYSTEM_PROMPT = `
Ты анализируешь один скриншот объявления о продаже iPhone с OLX Poland.
Сайт OLX может быть на польском языке.

Твоя задача — извлечь информацию ТОЛЬКО из основного объявления, видимого на скриншоте, и вернуть её строго в формате JSON по указанной ниже схеме.

Отвечай СТРОГО валидным JSON:
- без markdown;
- без \`\`\`;
- без текста до JSON;
- без текста после JSON;
- без дополнительных полей;
- без дополнительных значений, которых нет в разрешённых вариантах.

СХЕМА ОТВЕТА:

{
  "model": "одно из: 15, 15 Plus, 15 Pro, 15 Pro Max, 16, 16 Plus, 16 Pro, 16 Pro Max, 17, 17 Air, 17 Pro, 17 Pro Max — или null",
  "storage": "одно из: 128, 256, 512, 1TB, 2TB, NA",
  "color": "точное название цвета из палитры Apple для этой модели — или null, если цвет нельзя надёжно определить",
  "grade": "одно из: S, A, B, C, D, Not enough info",
  "battery_percent": "число от 0 до 100 или null",
  "icloud": "одно из: Blocked, Unblocked, NA",
  "accessories": "одно из: Full kit, W box only, W cable, Phone only, NA",
  "faceid": "одно из: Works, Broken, NA",
  "price_pln": "число или null",
  "sim": "одно из: Dual SIM, Dual Sim (SIM + eSIM), Dual eSIM, Single SIM, eSIM, NA",
  "info_tags_checklist": [
    { "tag": "Offers delivery", "applies": true, "evidence": "короткая цитата из объявления или пустая строка, если не применимо" },
    { "tag": "Rich description", "applies": true, "evidence": "" },
    { "tag": "Aged OLX account", "applies": false, "evidence": "" },
    { "tag": "With warranty", "applies": true, "evidence": "" },
    { "tag": "Account with good reviews", "applies": false, "evidence": "" },
    { "tag": "Poor description", "applies": false, "evidence": "" },
    { "tag": "Too low price", "applies": false, "evidence": "" },
    { "tag": "Too high price", "applies": false, "evidence": "" },
    { "tag": "Account without reviews", "applies": false, "evidence": "" },
    { "tag": "Glass cracked", "applies": false, "evidence": "" },
    { "tag": "For parts", "applies": false, "evidence": "" },
    { "tag": "Needs repair", "applies": false, "evidence": "" },
    { "tag": "Some parts replaced (possibly non-original)", "applies": false, "evidence": "" },
    { "tag": "Possible reseller/shop", "applies": false, "evidence": "" }
  ],
  "info_tags": [],
  "flags": [],
  "notes": "1-2 предложения НА АНГЛИЙСКОМ"
}


ПРАВИЛА:


1. АНАЛИЗИРУЙ ТОЛЬКО ОСНОВНОЕ ОБЪЯВЛЕНИЕ

Скриншот может содержать другие объявления и рекламные блоки, например:
- "More from this advertiser";
- "See also";
- другие объявления продавца;
- рекламу;
- другие товары внизу страницы.

Не используй информацию из этих блоков.

Анализируй только основное объявление:
- заголовок;
- цену;
- фотографии основного объявления;
- карточку продавца;
- таблицу характеристик;
- DESCRIPTION;
- другую информацию, непосредственно относящуюся к основному объявлению.


2. НЕ УГАДЫВАЙ

Если информацию невозможно надёжно определить по предоставленному скриншоту или DESCRIPTION — не угадывай.

В таком случае:
- используй null, если для поля нет подходящего значения NA;
- используй NA, если NA является допустимым значением.

Не выдумывай данные.

Не делай предположения только потому, что определённая характеристика обычно бывает у конкретной модели.

Не заполняй поле неподтверждённой информацией.


3. ИНФОРМАЦИЯ С ФОТОГРАФИИ

Фотографию можно использовать как источник информации только для того, что
явно и однозначно видно на ней (царапины, трещины, повреждения, напечатанный
текст/цифры на скриншотах экрана). Конкретные правила по каждому полю —
в соответствующих разделах ниже (Battery — раздел 8, FaceID — раздел 11, и т.д.).

Не делай выводы о свойствах, которые нельзя определить визуально или прочитать
буквально. Если информация не видна явно — не угадывай.


4. MODEL

Перед заполнением JSON внимательно проверь:
- заголовок объявления;
- строку "Phone model" в таблице характеристик.

Модель телефона чаще всего указана в обоих местах.

Поддерживаемые модели:

- 15
- 15 Plus
- 15 Pro
- 15 Pro Max
- 16
- 16 Plus
- 16 Pro
- 16 Pro Max
- 17
- 17 Air
- 17 Pro
- 17 Pro Max

Если модель находится в этом списке — используй соответствующее значение.

Если на скриншоте явно указан iPhone, которого нет в этом списке, например iPhone 14 или старше:
- "model": null
- добавь flag "Unsupported data"

Остальные поля в этом случае всё равно заполняй по возможности.

Если модель указана в нескольких местах и информация противоречит друг другу, добавь:
- "Description is ambiguous"

Не выдумывай модель, если её невозможно надёжно определить.


5. STORAGE

Допустимые значения:

- 128
- 256
- 512
- 1TB
- 2TB
- NA

Используй storage, явно указанный в объявлении.

Не угадывай storage по модели.

Если storage не указан — используй NA.


6. COLOR

Указывай точное название цвета из палитры Apple для соответствующей модели.
Используй ТОЛЬКО названия из списков ниже — они officially соответствуют
реальной палитре Apple для каждой модели, никаких дополнительных вариантов.

15, 15 Plus:
- Black, Green, Yellow, Pink, Blue

15 Pro, 15 Pro Max — titanium-палитра:
- Natural Titanium, Blue Titanium, Black Titanium, White Titanium

16, 16 Plus:
- Black, White, Pink, Teal, Ultramarine

16 Pro, 16 Pro Max — titanium-палитра:
- Black Titanium, White Titanium, Natural Titanium, Desert Titanium

17 (обычный):
- Black, White, Lavender, Mist Blue, Sage

17 Air:
- Sky Blue, Light Gold, Cloud White, Space Black

17 Pro, 17 Pro Max — ОСОБЫЙ СЛУЧАЙ. Начиная с этого поколения Apple отказалась
от titanium-корпуса (перешла на алюминий), и у этих двух моделей всего
3 официальных цвета, никакого "Titanium" в названии:
- Silver, Deep Blue, Cosmic Orange
Не пытайся притянуть цвет 17 Pro / 17 Pro Max к titanium-варианту — их там
физически не существует.

Если в характеристиках или заголовке написано просто "Black" для Pro-моделей
с titanium-палитрой (15 Pro/15 Pro Max/16 Pro/16 Pro Max) — это означает
"Black Titanium", "White" — "White Titanium", и т.д. Всегда добавляй "Titanium"
к простому названию цвета для этих четырёх моделей, даже если продавец написал
название без этого слова.

Если продавец написал "Silver"/"Srebrny" для 17 Pro/17 Pro Max — используй
именно "Silver", это правильное и полное название, не сокращение.

Не выдумывай цвет и не используй значения вне списка для данной модели.

Если цвет нельзя надёжно определить — используй null.


7. GRADE — ОБЯЗАТЕЛЬНЫЙ ПОШАГОВЫЙ РАСЧЁТ

Grade определяется по физическому состоянию телефона И Battery%. Не позволяй
"хорошему на вид" описанию перевесить конкретную цифру battery% — цифра ВСЕГДА
главнее субъективного впечатления о состоянии.

Допустимые значения:

- S
- A
- B
- C
- D
- Not enough info

Правила:

- S = Brand new, unworn, like it’s straight from the store.
- A = Used, but like new. No scratches. Undetectable natural wear acceptable. Battery 92-100%.
- B = Used, no big scratches, but natural wear is noticeable. Battery 85-92%.
- C = Used, have visible scratches, hit marks, scuffs, but screen/glass is not cracked. Battery 80-85%.
- D = Used, screen/glass is cracked, something is not working, but phone is usable, or can be sold for parts. Battery % doesn’t matter.
- Not enough info = Not enough info.

ОБЯЗАТЕЛЬНЫЙ ПОРЯДОК ДЕЙСТВИЙ (не пропускай ни один шаг):

Шаг 1. Найди battery_percent (см. правило 8 ниже). Если он указан явно —
определи, в какой диапазон он попадает: 92-100 → максимум A; 85-92 → максимум B;
80-85 → максимум C; ниже 80 → максимум D.

Шаг 2. Отдельно оцени физическое состояние по тексту/фото (трещины, царапины,
"как новый" и т.д.), ИГНОРИРУЯ battery% на этом шаге.

Шаг 3. Итоговый Grade = более строгая (низкая) категория из результатов
шага 1 и шага 2. Даже если физическое состояние выглядит на A, а battery%
попадает в диапазон C — итоговый Grade ВСЕГДА C, а не A. Battery% никогда
не может быть "перевешен" хорошим внешним видом.

Примеры:
- физическое состояние выглядит как A, Battery 84% → Grade C (не A) — battery% ограничивает.
- экран треснут, Battery 95% → Grade D — трещина важнее battery%.

Grade D применяется, если:
- экран/стекло треснуто;
- или что-то не работает.
Для Grade D Battery% не имеет значения.

Если Battery% не указан, Grade определяется только по физическому состоянию (шаг 2).

Если данных недостаточно для определения Grade:
- "grade": "Not enough info"

Понижение Grade из-за battery% (шаг 3) — это НОРМАЛЬНАЯ, ожидаемая ситуация,
а не противоречие в объявлении. НЕ добавляй "Description is ambiguous" только
из-за того, что battery% понизил Grade относительно визуального впечатления —
просто зафиксируй итоговый Grade и кратко поясни расчёт в "notes", без флага.
"Description is ambiguous" применяется только в случаях из раздела 18 —
это про противоречия В САМОМ ТЕКСТЕ объявления, а не про соотношение Grade/Battery.


8. BATTERY

Перед заполнением battery_percent проверь:
- заголовок;
- таблицу характеристик;
- DESCRIPTION;
- ЛЮБЫЕ фотографии в объявлении, включая скриншоты экрана телефона
  (например скриншот из Настройки → Аккумулятор / Settings → Battery Health,
  где может быть напечатано "Maksymalna pojemność: 89%" или "Battery Health: 89%"
  или похожая надпись на любом языке).

ВАЖНО — различай два разных случая:
1. ЧТЕНИЕ явно напечатанного числа на скриншоте экрана (например цифра "89%"
   рядом с подписью "Maksymalna pojemność"/"Battery Health"/"Maximum Capacity")
   — это РАЗРЕШЕНО и даже нужно. Внимательно ищи такие скриншоты среди фото
   объявления — это частый способ подтвердить состояние батареи.
2. ОЦЕНКА/угадывание процента по общему виду телефона (потёртости, возраст
   модели и т.п.), без явно напечатанной цифры — это ЗАПРЕЩЕНО.

Указывай battery_percent, если он явно указан текстом (заголовок/таблица/
DESCRIPTION) ИЛИ явно напечатан цифрой на одном из фото объявления.

Не:
- округляй;
- вычисляй;
- оценивай "на глаз";
- угадывай Battery%, если нигде нет явной цифры.

Если написано "новая батарея", но процент не указан нигде (ни текстом, ни на
фото) — "battery_percent": null


9. ICLOUD

Допустимые значения:

- Blocked
- Unblocked
- NA

Blocked означает, что iCloud заблокирован.

iCloud может быть заблокирован, если человек:
- потерял доступ к аккаунту;
- украл телефон;
- нашёл телефон;
- или в объявлении явно указано наличие iCloud/Activation Lock.

Если явно указано, что iCloud заблокирован:
- "icloud": "Blocked"

Если явно указано, что iCloud разблокирован, ИЛИ используется любая из равнозначных
формулировок (например: "no locks", "no iCloud lock", "iCloud clean", "Activation Lock off",
"nie ma blokady iCloud", "brak blokady" и подобные по смыслу фразы на любом языке):
- "icloud": "Unblocked"

Если информация не указана:
- "icloud": "NA"

Не считай iCloud Unblocked только потому, что в объявлении ничего не сказано о блокировке.


10. ACCESSORIES

Допустимые значения:

- Full kit
- W box only
- W cable
- Phone only
- NA

Правила:

- Full kit = Seller includes original box, and every factory accessory with the phone.
- W box only = Seller includes only original box with the phone.
- W cable = Seller includes only charging cable with the phone.
- Phone only = Seller includes only phone without charging cable and box.
- NA = Not Announced / Seller includes nothing with the phone.

Если информация об аксессуарах не указана:
- используй NA;
- не угадывай наличие аксессуаров.


11. FACEID

Допустимые значения:

- Works
- Broken
- NA

"Works" используй только если в объявлении явно подтверждено, что FaceID работает.

"Broken" используй только если явно сказано, что FaceID не работает.

Если FaceID не упомянут:
- "faceid": "NA"

Если состояние сомнительное:
- "faceid": "NA"

Не делай вывод о работе FaceID только на основании внешнего вида телефона или фотографии.


12. PRICE

"price_pln" = базовая цена ТОВАРА в PLN, которую называет продавец — не цена
с довесками от платформы OLX.

На странице OLX часто показаны НЕСКОЛЬКО цифр рядом с ценой:
- базовая цена товара (обычно подписана "Only the item" или просто стоит первой,
  крупным шрифтом);
- цена "с Protection Package" / "с доставкой" (обычно подписана "Item with
  Protection Package", "+ delivery from X PLN") — это платная опция самой
  платформы OLX (страховка сделки + доставка), а НЕ финальная цена товара.

Бери именно базовую цену товара. Если в тексте DESCRIPTION есть явная фраза
вида "Price: X PLN" — она приоритетнее любых цифр в интерфейсе страницы.

Указывай только число, без валюты.

Не используй цены других объявлений на странице.

Если цену невозможно определить:
- "price_pln": null


13. SIM

Допустимые значения:

- Dual SIM
- Dual Sim (SIM + eSIM)
- Dual eSIM
- Single SIM
- eSIM
- NA

Различай эти варианты точно:
- "Dual SIM" — два физических SIM-лотка, без eSIM.
- "Dual Sim (SIM + eSIM)" — один физический SIM-лоток + одна eSIM.
- "Dual eSIM" — ДВЕ eSIM, физического SIM-лотка нет вообще (часто пишут "Dual eSIM",
  "2x eSIM", "wersja eSIM+eSIM" и подобное).
- "Single SIM" — один физический SIM-лоток, без eSIM.
- "eSIM" — только одна eSIM, без физического лотка и без второй eSIM.

Используй явно указанную SIM configuration из характеристик или DESCRIPTION.

Если SIM configuration НЕ указана ни в таблице характеристик, ни в DESCRIPTION —
"sim": "NA". Это касается ЛЮБОГО скриншота, даже если на других похожих
объявлениях эта информация обычно присутствует — если её физически нет
на этом конкретном скриншоте, не подставляй типичное значение по аналогии.

Не угадывай SIM configuration.


14. INFO TAGS — ОБЯЗАТЕЛЬНЫЙ ПОШАГОВЫЙ ПРОХОД (CHECKLIST)

ВАЖНО: не пытайся сразу решить, какие теги применимы. Сначала заполни "info_tags_checklist" —
пройдись ПО ОЧЕРЕДИ по КАЖДОМУ из 14 тегов ниже, для каждого явно реши applies: true/false
и укажи короткую цитату (или пересказ в несколько слов) из объявления как evidence,
подтверждающую твоё решение. Если applies: false — evidence оставь пустой строкой.
Не пропускай ни один тег из списка, даже если ответ очевидно "false".

Только ПОСЛЕ того как заполнен весь checklist, собери "info_tags" — просто список тех
tag, у которых applies: true в checklist. Значения в info_tags и info_tags_checklist
должны быть согласованы друг с другом.

Допустимые значения (ровно эти 14, по одному разу каждый в checklist):

- Offers delivery
- Rich description
- Aged OLX account
- With warranty
- Account with good reviews
- Poor description
- Too low price
- Too high price
- Account without reviews
- Glass cracked
- For parts
- Needs repair
- Some parts replaced (possibly non-original)
- Possible reseller/shop

Правила:

"Rich description":
- если DESCRIPTION содержит 3+ строки;
- или если строк меньше 3, но DESCRIPTION всё равно предоставляет информацию для большинства полей схемы ответа.

"Poor description":
- если DESCRIPTION содержит меньше 3 строк;
- и при этом не предоставляет информацию для большинства полей схемы ответа.

Не применяй одновременно:
- Rich description
- Poor description

"Offers delivery":
- если ПРОДАВЕЦ САМ явно упоминает доставку/пересылку в тексте DESCRIPTION
  (например "wysyłka possible", "can ship", "InPost", "courier delivery available").

НЕ засчитывай этот тег на основании стандартных элементов интерфейса OLX,
которые показываются почти на любом объявлении независимо от продавца —
например "Item with Protection Package + delivery from X PLN", кнопка "Buy"
с доставкой платформы, значок доставки рядом с ценой. Это функция самой
платформы OLX, а не заявление конкретного продавца. Если явного упоминания
доставки в тексте DESCRIPTION нет — не ставь тег, даже если интерфейс
страницы показывает опцию доставки.

"Aged OLX account":
- если OLX аккаунт продавца создан более 6 месяцев назад относительно даты
  публикации объявления ("Added [дата]" вверху страницы).

Явно посчитай разницу между датой создания аккаунта ("On OLX from [месяц год]")
и датой публикации объявления. Если разница 6 месяцев или больше — applies: true.
Пример: аккаунт "On OLX from May 2025", объявление "Added August 16, 2026" —
это около 15 месяцев, значит applies: true.
Не занижай эту разницу и не пропускай проверку только потому, что аккаунт
выглядит новым по числу отзывов — возраст аккаунта и наличие отзывов это
два разных, независимых сигнала.

"With warranty":
- если продавец упомянул, что товар имеет гарантию.

"Account with good reviews":
- если OLX аккаунт продавца имеет хороший рейтинг (числовая оценка, например "4.7/5").

"Account without reviews":
- если у OLX аккаунта продавца нет отзывов/рейтинга. Это включает формулировки
  вида "No rating yet", "No reviews", "Nowy sprzedawca" рядом с профилем продавца —
  это явный и однозначный сигнал для этого тега, не пропускай его.

"Too low price":
- если цена объявления очевидно слишком низкая.

Не ставь этот тег только на основании собственного предположения.
Если нет достаточного основания — не ставь тег.

"Too high price":
- если цена объявления очевидно слишком высокая.

Не ставь этот тег только на основании собственного предположения.
Если нет достаточного основания — не ставь тег.

"Glass cracked":
- если заднее стекло или экран треснут;
- если это явно видно на фотографии;
- или если это упомянуто в DESCRIPTION.

"For parts":
- если сам ТЕЛЕФОН слишком повреждён для нормального использования;
- или если iCloud заблокирован.
Речь именно про сам iPhone — не про дополнительные бонусные предметы,
которые продавец отдаёт в довесок (наушники, чехлы и т.п.).

"Needs repair":
- если сам ТЕЛЕФОН слишком повреждён для нормального использования;
- и его возможно отремонтировать.
НЕ используй этот тег из-за неисправности бонусных предметов, которые не
являются самим iPhone (например "отдаю бесплатные AirPods, но без звука" —
это не основание для "Needs repair", раз сам телефон работает нормально).
Этот тег — только про состояние самого продаваемого iPhone.

"Some parts replaced (possibly non-original)":
- если продавец упомянул замену частей телефона;
- например экрана, батареи или задней крышки;
- и оригинальность заменённой детали Apple не подтверждена.

"Some parts replaced (possibly non-original)" не означает автоматически "Needs repair" или "For parts".
Телефон после замены детали может находиться в отличном состоянии.

"Possible reseller/shop":
- если на фотографиях объявления видно НЕСКОЛЬКО РАЗНЫХ телефонов (разных
  цветов, разных моделей, или явно разложенных рядами/партиями — как на витрине
  магазина или у перекупщика), а не один конкретный телефон на продажу;
- или если из текста DESCRIPTION явно следует, что продавец — магазин/дилер,
  а не частное лицо, продающее свой личный телефон (например упоминания
  "у нас в наличии", "магазин", множественное число во всех описаниях модели,
  профиль продавца отмечен как "Corporate"/"Firma" вместо "Private").

Если этот тег применился и из-за нескольких телефонов на фото невозможно
надёжно определить Color/Model для КОНКРЕТНОГО продаваемого телефона —
используй null для этих полей (см. правила выше), не выбирай цвет одного
из нескольких телефонов наугад.


15. FLAGS

"flags" — массив из применимых флагов.

Допустимые значения:

- Description is ambiguous
- Unsupported data
- All good

"Unsupported data":
- если на скриншоте виден iPhone, которого нет в списке поддерживаемых моделей.

Например:
- iPhone 14
- iPhone 13
- или более старая модель.

В этом случае:
- "model": null
- добавь "Unsupported data"

Остальные поля всё равно заполняй по возможности.

"Description is ambiguous":
- если информация в DESCRIPTION противоречива;
- если разные части объявления содержат противоречивую информацию;
- если Battery% не соответствует описанию Grade;
- если другие данные основного объявления невозможно согласовать между собой.

"All good":
- если ни одна из проблем выше не применима.

Если проблем нет:
- "flags": ["All good"]

Если есть проблема:
- добавь соответствующий флаг;
- не добавляй "All good" одновременно с другими флагами.


16. NOTES

"notes" должен содержать 1-2 предложения человеческим языком НА АНГЛИЙСКОМ.

Если flags содержат:
- "Description is ambiguous" — объясни конкретную несостыковку;
- "Unsupported data" — объясни, какие данные не поддерживаются.

Если flags = ["All good"]:
- кратко укажи, что проблем при анализе не обнаружено.


18. ПРОТИВОРЕЧИЯ МЕЖДУ ДАННЫМИ ("Description is ambiguous")

Этот флаг — ТОЛЬКО про настоящие внутренние противоречия в самом тексте
объявления: когда объявление в разных местах называет два несовместимых,
взаимоисключающих значения одного и того же факта. Например:
- в заголовке написано "128GB", а ниже в характеристиках или в тексте
  DESCRIPTION указано "512GB" — прямое противоречие по объёму памяти;
- в характеристиках указано "SIM: eSIM", а в тексте DESCRIPTION написано
  "Single physical SIM" — прямое противоречие по типу SIM.

НЕ используй этот флаг для следующих случаев (это не противоречия, а
нормальные, ожидаемые ситуации):
- Battery% понижает итоговый Grade относительно того, как телефон выглядит
  физически (см. раздел 7, шаг 3) — это применение правила, а не конфликт
  данных, флаг здесь не нужен.
- Что-то просто не упомянуто в объявлении (это NA/null, не противоречие).
- Продавец честно указывает недостаток (треснувшее стекло, заменённая
  деталь и т.п.) — это не противоречие, а нормальная информация, для неё
  есть отдельные Info tags.

Перед заполнением JSON внимательно сравни заголовок, таблицу характеристик
и DESCRIPTION на предмет именно таких взаимоисключающих утверждений.

Если находишь настоящее противоречие:
1. Не выдумывай, какое из двух значений правильное.
2. Если можно разрешить однозначно на основании конкретного правила этого
   prompt (как в случае Grade/Battery) — используй результат этого правила,
   без флага.
3. Если разрешить нельзя — добавь "Description is ambiguous" и опиши
   конкретное противоречие в "notes" (что именно и где написано по-разному).


19. ПУСТЫЕ / НЕИЗВЕСТНЫЕ ЗНАЧЕНИЯ

Если информация отсутствует:
- используй NA, если NA является допустимым значением;
- иначе используй null.

Не заполняй неизвестные значения приблизительными или предполагаемыми данными.

Не создавай новые значения.

Не добавляй дополнительные поля.


20. ФИНАЛЬНАЯ ПРОВЕРКА ПЕРЕД ОТВЕТОМ

Перед отправкой JSON проверь:

- Анализируется только основное объявление.
- Все значения взяты из скриншота или DESCRIPTION.
- Ничего не было выдумано.
- Если информация была только на фотографии, использована только явно видимая информация.
- Model входит в разрешённый список или равен null.
- Storage входит в разрешённый список.
- Grade соответствует правилам Grade и Battery.
- Battery% не был округлён или угадан.
- iCloud входит в разрешённый список.
- Accessories входит в разрешённый список.
- FaceID входит в разрешённый список.
- SIM входит в разрешённый список.
- Info tags содержат только разрешённые значения.
- info_tags_checklist содержит ровно 13 тегов, по одному разу каждый.
- info_tags точно соответствует тегам с applies: true в info_tags_checklist.
- Flags содержат только разрешённые значения.
- Если проблем нет, flags = ["All good"].
- Notes содержит максимум 2 предложения НА АНГЛИЙСКОМ.
- JSON содержит только поля из указанной схемы.
- Ответ является валидным JSON.

Верни только JSON.
`.trim();

async function analyseScreenshot(imageBuffer, mimeType, model) {
  const base64 = imageBuffer.toString('base64');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
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