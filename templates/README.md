# Quiz Master Question Bank Templates

This directory contains starter templates for creating custom question banks compatible with Quiz Master's **Bring Your Own Database (BYODB)** and **Book Companion Mode**.

## Files Included

1. **`Quiz Master Database_EMPTY.db`**
   * Pre-configured SQLite database schema with the optimal table layout and index structure.
   * Open this in DB Browser for SQLite or SQLiteStudio to populate your questions.

2. **`Quiz Master Questions_EMPTY.xlsx`**
   * Microsoft Excel template with formatted columns (`ID`, `Domain`, `Sub-Domain`, `Topic Area`, `Chapter`, `Heading`, `Question Text`, `Choice A`..`Choice D`, `CorrectAnswer(s)`, `Explanation`).
   * Ideal for drafting and collaborating on questions before exporting to SQLite or CSV.

3. **`Question Dump, Cleaned.csv`**
   * Example CSV export demonstrating properly formatted question rows, multiple choices, and metadata fields.

## Supported Schema Columns

| Column Name | Description | Example |
| :--- | :--- | :--- |
| `ID` | Unique question identifier | `1` or `OSG_1.1` |
| `Domain` | Broad knowledge domain | `Domain 1` |
| `Sub-Domain` | Sub-category under domain | `1.1 Professional Ethics` |
| `Topic Area` | Granular objective or topic | `1.1.1 Code of Ethics` |
| `Chapter` (Optional) | Book chapter / module reference | `Chapter 1` |
| `Heading` (Optional) | Specific section heading | `Security Governance` |
| `Question Text` | Question body | `Which principle ensures...` |
| `Choice A` .. `Choice D` | Option texts | `Confidentiality` |
| `CorrectAnswer(s)` | Single letter (`C`) or comma-separated (`A,B`) | `A` |
| `Explanation` | Deep explanation for review | `Confidentiality prevents...` |
| `hint_1` .. `hint_3` (Optional)| Progressive study hints | Domain/sub-domain hints |

## Special Question Types
* **Multi-Select:** Prefix `Question Text` with `[MULTI]` or list multiple answers in `CorrectAnswer(s)` (e.g., `A,C`).
* **Drag-and-Drop Matching:** Prefix `Question Text` with `[MATCH]`. Structure choices as adjacent pairs (`Choice A` matches with `Choice B`, `Choice C` with `Choice D`).
