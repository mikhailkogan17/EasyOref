# EasyOref

התרעות פיקוד העורף → צ׳אט המשפחה בטלגרם.

[English](../README.md) · [Русский](readme_ru.md)

> [!CAUTION]
> EasyOref **אינו מחליף** את ערוצי ההתרעה הרשמיים של פיקוד העורף.
> הבוט **משלים** אותם — מעדכן את הקרובים שלכם בחו״ל.
> תמיד פעלו לפי הנחיות פיקוד העורף!

## למה

בזמן מתקפת טילים, הקרובים שלכם בחו״ל רואים בחדשות «טילים על נתניה».

הם לא יודעים:
- זה השכונה שלכם או 200 ק״מ משם?
- אתם בטוחים?
- יש סיבה לדאגה?

**אין פתרון קיים.**
אפליקציות אזעקה עם סינון לפי אזור — בשבילכם בישראל.
התרעות Cell Broadcast — בשבילכם בישראל.

## יכולות

- **4 שפות** — רוסית, אנגלית, עברית, ערבית
- **3 סוגי אזעקה** — התרעה מוקדמת, צפירה, ירידה ממרחב מוגן
- **הודעות מותאמות** — טקסט ומדיה משלכם לכל סוג אזעקה

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
2. הוסיפו את הבוט לצ׳אט הקבוצתי
3. העבירו הודעה מהצ׳אט ל-[@userinfobot](https://t.me/userinfobot) → העתיקו את ה-**chat ID**

### 3. מצאו את ID העיר

פתחו את [cities.json](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json), חפשו את העיר, העתיקו את המספר מ-`id`.

דוגמה: `"id": 722` = תל אביב — דרום ויפו.

### 4. הריצו את ההגדרות

```bash
npx easyoref init
```

האשף שואל שפה, טוקן, chat ID ו-ID עיר. ההגדרות נשמרות ב-`~/.easyoref/config.yaml`.

### 5. הפעילו את הבוט

```bash
npx easyoref
```

**זהו.** הבוט ישלח הודעות לצ׳אט בכל התרעה של פיקוד העורף באזור שלכם.

> הבוט צריך לרוץ כל הזמן — על RPi, שרת, או מחשב שלא כבוי.
> מדריכים: [RPi](rpi.md) · [מקומי](local.md)

## הגדרות

קובץ הגדרות: `~/.easyoref/config.yaml`. נוצר ע״י `npx easyoref init`.

רשימה מלאה: [`config.yaml.example`](../config.yaml.example).

| מפתח                     | ברירת מחדל | תיאור                                                                                         |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------------- |
| `city_ids`               | —          | **חובה.** [מצאו ID עיר](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json) |
| `telegram.bot_token`     | —          | **חובה.** טוקן מ-@BotFather                                                                   |
| `telegram.chat_id`       | —          | **חובה.** ID של הצ׳אט (מספר שלילי)                                                            |
| `language`               | `ru`       | `ru` `en` `he` `ar`                                                                           |
| `alert_types`            | הכל        | `early` `siren` `incident_over`                                                               |
| `gif_mode`               | `none`     | `funny_cats` `assertive` `pikud_haoref` `none`                                                |
| `title_override.*`       | —          | כותרת מותאמת לכל סוג אזעקה                                                                    |
| `description_override.*` | —          | תיאור מותאם לכל סוג אזעקה                                                                     |

## רישיון

[MIT](../LICENSE) — מיכאל קוגן, 2026
