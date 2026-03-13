<p align="center">
  <img src="assets/hero.png" alt="EasyOref" width="100%">
</p>

התרעות פיקוד העורף — לצ׳אט או לערוץ שלכם בטלגרם.

[English](../README.md) · [Русский](readme_ru.md)

[![LangGraph](https://img.shields.io/badge/LangGraph-agentic-blue)](https://langchain-ai.github.io/langgraphjs/)
[![LangChain](https://img.shields.io/badge/LangChain-tools-green)](https://js.langchain.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)

> [!CAUTION]
> EasyOref **לא מחליף** את ערוצי ההתרעה הרשמיים של פיקוד העורף.
> הבוט **משלים** אותם — כדי שהקרובים שלכם בחו״ל יידעו שאתם בסדר.
> תמיד פעלו לפי הנחיות פיקוד העורף!

## למה

בזמן מתקפת טילים, הקרובים שלכם בחו״ל רואים בחדשות «טילים על תל אביב».

הם לא יודעים:
- זה השכונה שלכם או 200 ק״מ משם?
- אתם בממ״ד?
- יש סיבה לדאוג?

**אין פתרון קיים בשבילם.**
אפליקציות אזעקה עם סינון לפי אזור — בשבילכם בישראל.
התרעות Cell Broadcast — בשבילכם בישראל.
EasyOref — בשביל הקרובים שלכם בחו״ל.

## מה כולל

- **4 שפות** — רוסית, אנגלית, עברית, ערבית
- **3 סוגי התרעה** — התרעה מוקדמת, צפירה, ירידה מהממ״ד
- **הודעות מותאמות** — טקסט ומדיה משלכם לכל סוג התרעה

## התקנה

### 1. התקינו Node.js

<details>
<summary>Windows</summary>

הורידו מ-[nodejs.org](https://nodejs.org/) (LTS, 22+). הריצו את ההתקנה, לחצו «Next».

</details>

<details>
<summary>macOS</summary>

```bash
brew install node
```

או הורידו מ-[nodejs.org](https://nodejs.org/).

</details>

<details>
<summary>Linux / Raspberry Pi</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

</details>

### 2. הכינו את הטלגרם

1. שלחו הודעה ל-[@BotFather](https://t.me/BotFather) → `/newbot` → העתיקו את ה**טוקן**
2. הוסיפו את הבוט לצ׳אט שלכם בטלגרם
3. העבירו הודעה מהצ׳אט ל-[@userinfobot](https://t.me/userinfobot) → העתיקו את ה-**chat ID**

### 3. מצאו את ID העיר שלכם

פתחו את [cities.json](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json), חפשו את העיר שלכם, העתיקו את המספר מ-`id`.

לדוגמה: `"id": 722` = תל אביב — דרום ויפו.

### 4. הגדרה ראשונית

```bash
npx easyoref init
```

האשף שואל שפה, טוקן, chat ID ו-ID עיר. ההגדרות נשמרות ב-`~/.easyoref/config.yaml`.

### 5. הפעלה

```bash
npx easyoref
```

**זהו.** הבוט ישלח הודעה לצ׳אט בכל התרעה של פיקוד העורף באזור שלכם.

> הבוט צריך לרוץ כל הזמן — על RPi, שרת, או מחשב שלא כבוי.
> מדריכים: [RPi](rpi.md) · [מקומי](local.md)

## איך זה עובד

EasyOref פועל בשני שכבות:

**שכבת ליבה** — תמיד פועלת, זמן תגובה <1 שניה
- בודקת את API של פיקוד העורף כל 2 שניות
- מסננת לפי ID עיר (מודע לאזורי כיפת ברזל)
- שולחת לטלגרם מיידית

**שכבת העשרה אג׳נטית** — פייפליין LangGraph לכל התרעה

```
collectAndFilter → extract → vote → [clarify → revote] → editMessage
```

1. **collectAndFilter** — אוסף פוסטים מערוצים, פילטר רעשים דטרמיניסטי, מעקב ערוצים
2. **extract** — שני שלבי LLM: פילטר זול לרלוונטיות → חילוץ מובנה יקר (מספר טילים, יירוטים, אזור פגיעה, מדינת מוצא)
3. **vote** — קונצנזוס על פני חילוצים מרובים, ניקוד ביטחון
4. **clarify** *(מותנה)* — מופעל בביטחון נמוך או טענות ממקור יחיד חשוד; LLM קורא לכלים:
   - `read_telegram_sources` — שליפה חיה מערוצי IDF/חדשות דרך MTProto
   - `alert_history` — אימות טענות מול היסטוריית פיקוד העורף
   - `resolve_area` — בדיקת קרבה לפי אזור כיפת ברזל
   - `betterstack_log` — שאילתת לוגים של פייפליין ההעשרה
5. **revote** — הרצת קונצנזוס מחדש עם נתונים מובהרים
6. **editMessage** — עריכת הודעת טלגרם in-place עם ציטוטים

LangGraph `MemorySaver` שומר מצב לפי `alertId`. Graceful degradation: `ai.enabled: false` → רק שכבת ליבה, ללא תלות ב-LLM.

## הגדרות

קובץ הגדרות: `~/.easyoref/config.yaml`. נוצר ע״י `npx easyoref init`.

רשימה מלאה: [`config.yaml.example`](../config.yaml.example).

| מפתח                     | ברירת מחדל | תיאור                                                                                         |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------------- |
| `city_ids`               | —          | **חובה.** [מצאו ID עיר](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json) |
| `telegram.bot_token`     | —          | **חובה.** טוקן מ-@BotFather                                                                   |
| `telegram.chat_id`       | —          | **חובה.** ID של הצ׳אט (מספר שלילי)                                                            |
| `language`               | `ru`       | `ru` `en` `he` `ar`                                                                           |
| `alert_types`            | הכל        | `early` `siren` `resolved`                                                                    |
| `gif_mode`               | `none`     | `funny_cats` `none`                                                                           |
| `title_override.*`       | —          | כותרת מותאמת לכל סוג התרעה                                                                    |
| `description_override.*` | —          | תיאור מותאם לכל סוג התרעה                                                                     |

## רישיון

[MIT](../LICENSE) — מיכאל קוגן, 2026
