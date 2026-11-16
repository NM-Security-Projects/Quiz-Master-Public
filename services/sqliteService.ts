import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { Question, DomainStat, ReviewFilter, QuestionTypeFilter, IntegrityReport } from '../types';
import type { WorkerMessage, WorkerResponse } from './sqlite.worker';

let db: Database | null = null;
let sqlPromise: Promise<SqlJsStatic> | null = null;

const getSQLInstance = async (): Promise<SqlJsStatic> => {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => sqlWasmUrl
    });
  }
  return sqlPromise;
};

const normalize = (str: any): string => {
  if (str === null || str === undefined) return "";
  return String(str).trim();
};

const findColumnName = (columns: string[], possibilities: string[]): string | undefined => {
  const cleanCols = columns.map(c => c.toLowerCase().trim());
  for (const p of possibilities) {
    const cleanP = p.toLowerCase().trim();
    const idx = cleanCols.indexOf(cleanP);
    if (idx !== -1) return columns[idx];
  }
  return undefined;
};

const getQuestionTextColumn = (columns: string[]): string => {
  return findColumnName(columns, ['Question Text', 'QuestionText', 'Question', 'text', 'body', 'content', 'description']) || 'question_text';
};

const getRefIdColumn = (columns: string[]): string | undefined => {
  return findColumnName(columns, ['Source', 'Y', 'RefID', 'ReferenceID', 'Reference_ID', 'Source_ID', 'Code', 'Label', 'QID', 'ID', 'Key']);
};

const getTableName = (databaseInstance: Database): string => {
  const result = databaseInstance.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'");
  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0] as string; 
  }
  throw new Error("No tables found in database");
};

export const initDatabase = async (file: File): Promise<{ bytes: Uint8Array, integrity: IntegrityReport }> => {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const SQL = await getSQLInstance();
  const tempDb = new SQL.Database(bytes);
  try {
    const tableName = getTableName(tempDb);
    const columnsResult = tempDb.exec(`PRAGMA table_info("${tableName}")`);
    const columns = columnsResult[0].values.map((v: any[]) => v[1] as string);
    const qTextCol = getQuestionTextColumn(columns);
    const refCol = getRefIdColumn(columns);
    const totalResult = tempDb.exec(`SELECT COUNT(*) FROM "${tableName}"`);
    const totalRows = totalResult[0].values[0][0] as number;
    let missingQuery = `SELECT COUNT(*) FROM "${tableName}" WHERE ("${qTextCol}" IS NULL OR TRIM("${qTextCol}") = '')`;
    if (refCol) missingQuery += ` AND ("${refCol}" IS NULL OR TRIM("${refCol}") = '')`;
    const emptyResult = tempDb.exec(missingQuery);
    const missingTextCount = emptyResult[0].values[0][0] as number;
    return { bytes, integrity: { totalRows, missingTextCount } };
  } finally {
    tempDb.close();
  }
};

export const processAndMergeDatabases = async (sources: { id: string, name: string, bytes: Uint8Array }[]): Promise<number> => {
  if (sources.length === 0) throw new Error("No sources provided");

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = async (e: MessageEvent<WorkerResponse>) => {
      const data = e.data;
      if (data.type === 'SUCCESS') {
        try {
          const SQL = await getSQLInstance();
          db = new SQL.Database(data.bytes);
          worker.terminate();
          resolve(data.count);
        } catch (err) {
          worker.terminate();
          reject(err);
        }
      } else if (data.type === 'ERROR') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };

    const message: WorkerMessage = { type: 'MERGE', payload: { sources } };
    worker.postMessage(message);
  });
};

// --- Updated Getters & Parsers ---

export interface BookStructure {
  book: string;
  chapters: string[];
}

// Strict 3-Part ID Parser
// Format: [BOOK]_[Chapter].[Question] OR [BOOK].[Chapter].[Question]
// Delimiters: _ or .
const parseRefId = (refId: string, sourceFile: string = "") => {
  const raw = normalize(refId);
  
  // Strict split by common delimiters
  const parts = raw.split(/[_\.]+/).filter(Boolean);
  
  let book = "";
  let chapter = "";
  let qLabel = "";
  let question = 0;

  if (parts.length >= 3) {
    // [0] = Book, [1] = Chapter, [2+] = Question
    book = parts[0];
    chapter = parts[1];
    // Join remaining parts for question label (e.g. 1.2 or 1)
    qLabel = parts.slice(2).join('.');
  } else if (parts.length === 2) {
    // Fallback: Book, Question (Chapter assumed 'All' or 'General')
    book = parts[0];
    chapter = "General";
    qLabel = parts[1];
  } else {
    // Fallback: Use filename as book
    book = sourceFile ? sourceFile.replace(/\.(db|sqlite|sqlite3)$/i, '') : "Uncategorized";
    chapter = "All";
    qLabel = parts[0] || "0";
  }

  // Try to parse number for sorting
  const qNum = parseInt(qLabel, 10);
  question = isNaN(qNum) ? 0 : qNum;
  
  return { book, chapter, question, qLabel };
};

export const getBooksAndChapters = (): BookStructure[] => {
  if (!db) return [];
  try {
    const result = db.exec(`SELECT DISTINCT refId, source_file FROM questions`);
    if (result.length === 0) return [];

    const booksMap: Record<string, Set<string>> = {};
    
    result[0].values.forEach((row: any[]) => {
      const parsed = parseRefId(row[0], row[1]);
      
      if (!booksMap[parsed.book]) booksMap[parsed.book] = new Set();
      booksMap[parsed.book].add(parsed.chapter);
    });

    return Object.entries(booksMap).map(([book, chapters]) => ({
      book,
      chapters: Array.from(chapters).sort((a,b) => {
        // Natural Sort for Chapters (AS vs 1 vs 10)
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      })
    })).sort((a,b) => {
      // Natural Sort for Books
      return a.book.localeCompare(b.book, undefined, { numeric: true, sensitivity: 'base' });
    });
  } catch (e) {
    console.error("Error getting books", e);
    return [];
  }
};

export const getDomainStats = (reviewFilter?: ReviewFilter): DomainStat[] => {
  if (!db) return [];
  try {
    let whereClause = "";
    if (reviewFilter === 'exclude') whereClause = `WHERE (LTRIM(question_text) NOT LIKE '~%')`;
    else if (reviewFilter === 'only') whereClause = `WHERE (LTRIM(question_text) LIKE '~%')`;

    const result = db.exec(`SELECT domain FROM questions ${whereClause}`);
    if (result.length === 0) return [];

    const counts: Record<string, number> = {};
    const ignoredDomains = new Set(['Assessment', 'Assessment Test', 'General Knowledge', 'General']);

    result[0].values.forEach((row: any[]) => {
      const dVal = normalize(row[0]);
      if (!dVal) {
        counts["Uncategorized"] = (counts["Uncategorized"] || 0) + 1;
      } else {
        const parts = dVal.split('|');
        parts.forEach(p => {
          const clean = p.trim();
          if (clean && !ignoredDomains.has(clean)) {
            counts[clean] = (counts[clean] || 0) + 1;
          }
        });
      }
    });

    return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch (e) {
    return [];
  }
};

export const getAvailableQuestionCount = (selectedDomains?: string[], reviewFilter?: ReviewFilter, questionType?: QuestionTypeFilter, excludeImages?: boolean): number => {
  if (!db) return 0;
  try {
    let conditions: string[] = ["1=1"];

    if (selectedDomains && selectedDomains.length > 0) {
      const includeUnc = selectedDomains.includes("Uncategorized");
      const named = selectedDomains.filter(d => d !== "Uncategorized");
      const dConds: string[] = [];
      if (includeUnc) dConds.push(`(domain IS NULL OR TRIM(domain) = '')`);
      if (named.length > 0) {
        named.forEach(d => {
          const esc = normalize(d).replace(/'/g, "''");
          dConds.push(`('|' || REPLACE(REPLACE(REPLACE(TRIM(domain), ' | ', '|'), ' |', '|'), '| ', '|') || '|') LIKE '%|${esc}|%'`);
        });
      }
      if (dConds.length > 0) conditions.push(`(${dConds.join(" OR ")})`);
    }

    if (reviewFilter === 'exclude') conditions.push(`(LTRIM(question_text) NOT LIKE '~%')`);
    else if (reviewFilter === 'only') conditions.push(`(LTRIM(question_text) LIKE '~%')`);

    if (questionType === 'match') conditions.push(`(question_text LIKE '%[MATCH]%')`);
    else if (questionType === 'multi') {
      conditions.push(`(question_text LIKE '%[MULTI]%' OR correct_answer LIKE '%,%')`);
    } else if (questionType === 'image') conditions.push(`(question_text LIKE '%[PIC]%')`);

    if (excludeImages) conditions.push(`(question_text NOT LIKE '%[PIC]%')`);

    const result = db.exec(`SELECT COUNT(*) FROM questions WHERE ${conditions.join(" AND ")}`);
    return result[0].values[0][0] as number;
  } catch (e) {
    return 0;
  }
};

export const getAbsoluteTotalCount = (): number => {
  if (!db) return 0;
  try {
    const result = db.exec(`SELECT COUNT(*) FROM questions`);
    return result[0].values[0][0] as number;
  } catch {
    return 0;
  }
};

export const getQuestions = (
  count: number, 
  selectedDomains?: string[], 
  reviewFilter?: ReviewFilter, 
  searchText?: string, 
  questionType?: QuestionTypeFilter, 
  excludeImages?: boolean, 
  book?: string, 
  chapter?: string, 
  sortRefId?: boolean,
  books?: string[],
  chapters?: string[]
): Question[] => {
  if (!db) throw new Error("Database not initialized");

  const activeBooks = books && books.length > 0 ? books : (book ? [book] : []);
  const activeChapters = chapters && chapters.length > 0 ? chapters : (chapter ? [chapter] : []);
  const isBookMode = activeBooks.length > 0;

  // -- SQL Construction --
  let conditions: string[] = [];

  if (isBookMode) {
    // Fetch broadly by book name match (strict filtering in JS)
    const bookConditions: string[] = [];
    activeBooks.forEach(b => {
      const safeBook = b.replace(/'/g, "''");
      bookConditions.push(`(refId LIKE '${safeBook}%' OR source_file LIKE '${safeBook}%')`);
    });
    if (bookConditions.length > 0) conditions.push(`(${bookConditions.join(" OR ")})`);
  } else {
    // Standard Practice Mode Logic
    if (selectedDomains && selectedDomains.length > 0) {
      const includeUnc = selectedDomains.includes("Uncategorized");
      const named = selectedDomains.filter(d => d !== "Uncategorized");
      const dConds: string[] = [];
      if (includeUnc) dConds.push(`(domain IS NULL OR TRIM(domain) = '')`);
      if (named.length > 0) {
        named.forEach(d => {
          const esc = normalize(d).replace(/'/g, "''");
          dConds.push(`('|' || REPLACE(REPLACE(REPLACE(TRIM(domain), ' | ', '|'), ' |', '|'), '| ', '|') || '|') LIKE '%|${esc}|%'`);
        });
      }
      if (dConds.length > 0) conditions.push(`(${dConds.join(" OR ")})`);
    }
  }

  // Common Filters
  if (reviewFilter === 'exclude') conditions.push(`(LTRIM(question_text) NOT LIKE '~%')`);
  else if (reviewFilter === 'only') conditions.push(`(LTRIM(question_text) LIKE '~%')`);

  if (questionType === 'match') conditions.push(`(question_text LIKE '%[MATCH]%')`);
  else if (questionType === 'multi') conditions.push(`(question_text LIKE '%[MULTI]%' OR correct_answer LIKE '%,%')`);
  else if (questionType === 'image') conditions.push(`(question_text LIKE '%[PIC]%')`);

  if (excludeImages) conditions.push(`(question_text NOT LIKE '%[PIC]%')`);

  if (searchText) {
    const safeSearch = normalize(searchText).replace(/'/g, "''");
    conditions.push(`(question_text LIKE '%${safeSearch}%')`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  
  // In Book Mode, we disable SQL sorting to sort naturally in JS.
  const orderBy = isBookMode ? "" : `ORDER BY RANDOM()`;
  const limitClause = isBookMode ? "" : `LIMIT ${count}`;
  
  const query = `SELECT * FROM questions ${whereClause} ${orderBy} ${limitClause}`;
  const result = db.exec(query);

  if (result.length === 0) return [];

  const resultColumns = result[0].columns;
  const colMap: Record<string, number> = {};
  resultColumns.forEach((c: string, i: number) => colMap[c] = i);

  let mappedQuestions = result[0].values.map((row: any[]) => {
    const rowData = (name: string) => row[colMap[name]];
    const choices = JSON.parse(rowData('choices_json') || '{}');

    return {
      id: rowData('id'),
      question_text: rowData('question_text'),
      choices,
      correct_answer: rowData('correct_answer'),
      explanation: rowData('explanation'),
      domain: rowData('domain'),
      subDomain: rowData('sub_domain'),
      topic: rowData('topic'),
      chapter: rowData('chapter'),
      heading: rowData('heading'),
      hint_1: rowData('hint_1'),
      hint_2: rowData('hint_2'),
      hint_3: rowData('hint_3'),
      refId: rowData('refId'),
      sourceFile: rowData('source_file')
    };
  });

  if (isBookMode) {
    // 1. Strict Filtering based on Parsed ID
    mappedQuestions = mappedQuestions.filter(q => {
      const parsed = parseRefId(q.refId, q.sourceFile);
      
      if (!activeBooks.includes(parsed.book)) return false;
      
      if (activeChapters.includes("All")) return true;
      return activeChapters.includes(parsed.chapter);
    });

    // 2. Strict Natural Sorting
    mappedQuestions.sort((a, b) => {
      const pA = parseRefId(a.refId, a.sourceFile);
      const pB = parseRefId(b.refId, b.sourceFile);

      // Sort by Book Name (Natural)
      const bookDiff = pA.book.localeCompare(pB.book, undefined, { numeric: true, sensitivity: 'base' });
      if (bookDiff !== 0) return bookDiff;

      // Sort by Chapter (Natural)
      const chapDiff = pA.chapter.localeCompare(pB.chapter, undefined, { numeric: true, sensitivity: 'base' });
      if (chapDiff !== 0) return chapDiff;

      // Sort by Question Number (Natural/Numeric)
      if (pA.question !== 0 && pB.question !== 0) {
        return pA.question - pB.question;
      }
      // Fallback to string comparison for labels like "1a", "1b"
      return pA.qLabel.localeCompare(pB.qLabel, undefined, { numeric: true, sensitivity: 'base' });
    });

    // 3. Apply Limit
    if (mappedQuestions.length > count) {
      mappedQuestions = mappedQuestions.slice(0, count);
    }
  }

  return mappedQuestions;
};
