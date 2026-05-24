# Hadith Reference Mapping Audit

Date: 2026-05-24

## Scope

Audited the nine local JSON datasets in `takhrij-backend/hadith` using copies only.

- Originals copied to `reference-audit-20260524-170714/backup`
- Working copies copied to `reference-audit-20260524-170714/working`
- Repaired copies written to `reference-audit-20260524-170714/corrected`
- Original `hadith/*.json` files were not modified

## Current Dataset Structure

All nine files use the same core row shape:

- `id`
- `idInBook`
- `chapterId`
- `bookId`
- `arabic`
- `english.narrator`
- `english.text`

No file contains a native `reference`, `bookName`, `bookNumber`, or Sunnah.com endpoint identifier.

The backend currently falls back to generated references such as:

```txt
Sahih Bukhari 755
```

from internal `id` values when `reference` is missing. Those internal IDs are not consistently Sunnah.com reference numbers.

## Repair Method

The repair script scraped Sunnah.com collection/book pages and matched local records to Sunnah.com records using:

1. Exact normalized narrator + English text
2. Exact normalized English text
3. Exact normalized Arabic text

Only exact text matches were repaired. No references were guessed from array position or manually invented.

Added fields in repaired JSON:

- `reference`
- `sunnahReference`
- `sunnahUrl`
- `bookNumber`
- `bookName`
- `hadithInBook`
- `inBookReference`

## Repair Coverage

| Collection | Rows | Repaired | Unresolved |
|---|---:|---:|---:|
| Bukhari | 7,277 | 7,277 | 0 |
| Muslim | 7,459 | 7,368 | 91 |
| Tirmidhi | 4,053 | 4,052 | 1 |
| Nasa'i | 5,768 | 5,685 | 83 |
| Abu Dawud | 5,276 | 5,276 | 0 |
| Ibn Majah | 4,345 | 4,079 | 266 |
| Malik | 1,985 | 1,860 | 125 |
| Ahmad | 1,374 | 1,374 | 0 |
| Darimi | 3,406 | 2,433 | 973 |

Unresolved entries are listed in `unresolved-references.json`.

Duplicate canonical assignments are listed in `duplicate-canonical-references.json`. These appear to be duplicate or near-duplicate local records and should be reviewed before replacing production data.

## Example Fix

Original generated app reference:

```txt
Sahih Bukhari 755
```

Corrected mapping for the same local internal row:

```json
{
  "id": 755,
  "reference": "Sahih al-Bukhari 773",
  "sunnahReference": "bukhari:773",
  "bookNumber": 10,
  "bookName": "Call to Prayers (Adhaan)",
  "hadithInBook": "167"
}
```

The actual Sunnah.com `bukhari:755` record maps to local `id: 737`.

```json
{
  "id": 737,
  "reference": "Sahih al-Bukhari 755",
  "sunnahReference": "bukhari:755",
  "bookNumber": 10,
  "bookName": "Call to Prayers (Adhaan)",
  "hadithInBook": "149"
}
```

## Notes

- `bookId` in the local JSON should not be treated as a Sunnah.com book number.
- `id` should not be treated as a Sunnah.com hadith number for most collections.
- Some Sunnah.com pages, especially Darimi, expose Arabic-only pages or different reference styles, so those entries were only repaired when Arabic text matched exactly.
- The corrected JSON files are suitable for review, not automatic production replacement yet.
