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

  const outPath = `./last-downloaded-screenshot.png`;
  await import('node:fs/promises').then((fs) => fs.writeFile(outPath, buffer));
  console.log(`Скриншот скачан и сохранён: ${outPath} (${buffer.length} байт)`);

  const metadata = await sharp(buffer).metadata();
  console.log(`Реальный размер картинки: ${metadata.width} x ${metadata.height} px`);

  // Обрезаем до верхней содержательной части — фиксированная высота в пикселях
  // ИСХОДНОГО разрешения (не пропорционально ширине!). При соотношении сторон,
  // близком к квадрату, OpenAI меньше ужимает картинку перед распознаванием —
  // а значит текст остаётся крупнее и читаемее.
  const CROP_HEIGHT = 5200; // увеличили, чтобы захватить описание целиком
  const cropHeight = Math.min(metadata.height, CROP_HEIGHT);
  const croppedBuffer = await sharp(buffer)
    .extract({ left: 0, top: 0, width: metadata.width, height: cropHeight })
    .png()
    .toBuffer();

  const croppedPath = './last-cropped-screenshot.png';
  await import('node:fs/promises').then((fs) => fs.writeFile(croppedPath, croppedBuffer));
  console.log(`Обрезанная версия (${metadata.width} x ${cropHeight}) сохранена: ${croppedPath}`);
  console.log('Открой этот файл и проверь глазами — виден ли на нём заголовок И таблица характеристик целиком.');

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

    console.log('\n--- Отправляю ОБРЕЗАННЫЙ скриншот в gpt-4o-mini ---');
    const analysis = await analyseScreenshot(croppedBuffer, 'image/png');
    console.log('--- Ответ модели ---');
    console.log(JSON.stringify(analysis, null, 2));
    console.log('(Пока НЕ записываю это в Notion — просто смотрим, что вернула модель)');
  }

  console.log('=== Готово ===\n');
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
    { "tag": "Some parts replaced (possibly non-original)", "applies": false, "evidence": "" }
  ],
  "info_tags": [],
  "flags": [],
  "notes": "1-2 предложения",
  "aiComments": "не более 5 предложений"
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

Если информация присутствует только на фотографии, заполняй только ту информацию, которая явно видна на фотографии.

Фотография может использоваться как источник информации, например, для:
- видимых царапин;
- потёртостей;
- трещин;
- повреждений;
- цвета, если цвет явно и однозначно виден;
- других характеристик, которые непосредственно и явно видны на фотографии.

Не делай выводы о свойствах, которые невозможно определить визуально.

Например:
- нельзя считать FaceID работающим только потому, что телефон выглядит целым;
- нельзя определять Battery% по внешнему виду телефона;
- нельзя определять iCloud status по внешнему виду телефона;
- нельзя определять storage только по фотографии;
- нельзя определять SIM configuration только по внешнему виду.

Если информация не видна явно — не угадывай.


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

Для Pro/Pro Max моделей начиная с 15 Pro используй соответствующий titanium-вариант цвета из реальной палитры Apple для этой модели.

Если продавец написал просто "Black", не обязательно использовать "Black" буквально.
Сверяй название с реальной палитрой Apple для конкретной модели.

Не выдумывай цвет.

Если цвет нельзя надёжно определить — используй null.


7. GRADE

Grade определяется по физическому состоянию телефона и Battery%.

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

ВАЖНО:

Если телефон физически выглядит как Grade A, но Battery% меньше допустимого значения для Grade A, необходимо выбирать категорию, в которую попадает Battery%.

Примеры:
- состояние выглядит как A, Battery 88% → Grade B;
- состояние выглядит как B, Battery 82% → Grade C.

Battery% ограничивает максимально возможный Grade, если Battery% явно указан.

Grade D применяется, если:
- экран/стекло треснуто;
- или что-то не работает.

Для Grade D Battery% не имеет значения.

Если Battery% не указан, Grade определяется по доступной информации о физическом состоянии.

Если данных недостаточно для определения Grade:
- "grade": "Not enough info"

Если физическое состояние и Battery% в объявлении противоречат правилам Grade:
- выбери Grade согласно правилам выше;
- добавь "Description is ambiguous";
- опиши несостыковку в "notes".


8. BATTERY

Перед заполнением battery_percent проверь:
- заголовок;
- таблицу характеристик;
- DESCRIPTION.

Указывай battery_percent только если Battery% явно указан.

Не:
- округляй;
- вычисляй;
- оценивай;
- угадывай Battery%.

Если написано "новая батарея", но процент не указан:
- "battery_percent": null

Если Battery% указан только на фотографии, его можно использовать только если процент явно и однозначно виден на фотографии.


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

"price_pln" = цена основного объявления в PLN.

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

Если SIM configuration не указана:
- "sim": "NA"

Не угадывай SIM configuration.


14. INFO TAGS — ОБЯЗАТЕЛЬНЫЙ ПОШАГОВЫЙ ПРОХОД (CHECKLIST)

ВАЖНО: не пытайся сразу решить, какие теги применимы. Сначала заполни "info_tags_checklist" —
пройдись ПО ОЧЕРЕДИ по КАЖДОМУ из 13 тегов ниже, для каждого явно реши applies: true/false
и укажи короткую цитату (или пересказ в несколько слов) из объявления как evidence,
подтверждающую твоё решение. Если applies: false — evidence оставь пустой строкой.
Не пропускай ни один тег из списка, даже если ответ очевидно "false".

Только ПОСЛЕ того как заполнен весь checklist, собери "info_tags" — просто список тех
tag, у которых applies: true в checklist. Значения в info_tags и info_tags_checklist
должны быть согласованы друг с другом.

Допустимые значения (ровно эти 13, по одному разу каждый в checklist):

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
- если продавец предлагает доставку.

"Aged OLX account":
- если OLX аккаунт продавца создан более 6 месяцев назад относительно сегодняшней даты.

"With warranty":
- если продавец упомянул, что товар имеет гарантию.

"Account with good reviews":
- если OLX аккаунт продавца имеет хороший рейтинг.

"Account without reviews":
- если у OLX аккаунта продавца нет отзывов.

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
- если телефон слишком повреждён для нормального использования;
- или если iCloud заблокирован.

"Needs repair":
- если телефон слишком повреждён для нормального использования;
- и его возможно отремонтировать.

"Some parts replaced (possibly non-original)":
- если продавец упомянул замену частей телефона;
- например экрана, батареи или задней крышки;
- и оригинальность заменённой детали Apple не подтверждена.

"Some parts replaced (possibly non-original)" не означает автоматически "Needs repair" или "For parts".
Телефон после замены детали может находиться в отличном состоянии.


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

"notes" должен содержать 1-2 предложения человеческим языком.

Если flags содержат:
- "Description is ambiguous" — объясни конкретную несостыковку;
- "Unsupported data" — объясни, какие данные не поддерживаются.

Если flags = ["All good"]:
- кратко укажи, что проблем при анализе не обнаружено.


17. AICOMMENTS

"aiComments" должен объяснять, почему были выбраны именно эти info_tags.

Укажи логику для каждого выбранного info_tag.

Если info_tags пустой:
- "aiComments": ""

Комментарий должен быть не более 5 предложений.

Не описывай info_tags, которые не были выбраны.

Не добавляй в aiComments информацию, не относящуюся к выбранным info_tags.


18. ПРОТИВОРЕЧИЯ МЕЖДУ ДАННЫМИ

Перед заполнением JSON внимательно сравни:
- заголовок;
- таблицу характеристик;
- DESCRIPTION;
- основную фотографию;
- информацию о продавце.

Если данные противоречат друг другу:

1. Не выдумывай правильное значение.
2. Если противоречие можно разрешить однозначно на основании конкретного правила этого prompt — используй результат этого правила.
3. Если противоречие нельзя разрешить однозначно — добавь "Description is ambiguous".
4. Опиши конкретную проблему в "notes".

Для Grade и Battery используй специальное правило Grade:
если Battery% явно указан и физическое состояние соответствует более высокой категории, но Battery% попадает в более низкую категорию, выбирай категорию Battery%.


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
- Notes содержит максимум 2 предложения.
- aiComments содержит максимум 5 предложений.
- JSON содержит только поля из указанной схемы.
- Ответ является валидным JSON.

Верни только JSON.
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