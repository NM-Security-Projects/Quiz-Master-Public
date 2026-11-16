import initSqlJs, { Database } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

export interface MergeSource {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export type WorkerMessage = 
  | { type: 'MERGE'; payload: { sources: MergeSource[] } };

export type WorkerResponse =
  | { type: 'SUCCESS'; count: number; bytes: Uint8Array }
  | { type: 'ERROR'; message: string };

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, payload } = e.data;

  if (type === 'MERGE') {
    const { sources } = payload;
    try {
      const SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl
      });

      const masterDb = new SQL.Database();

      masterDb.run(`
        CREATE TABLE questions (
          id TEXT PRIMARY KEY,
          source_file TEXT,
          question_text TEXT,
          refId TEXT,
          correct_answer TEXT,
          choices_json TEXT,
          explanation TEXT,
          domain TEXT,
          sub_domain TEXT,
          topic TEXT,
          chapter TEXT,
          heading TEXT,
          hint_1 TEXT, hint_2 TEXT, hint_3 TEXT
        );
      `);

      let totalImported = 0;

      const cleanAnswer = (raw: any): string => {
        if (raw === null || raw === undefined) return "";
        let str = String(raw).trim();

        // If it looks like a complex match answer (contains newlines or comma+digit), preserve it
        if (str.includes('\n') || (str.includes(',') && /\d/.test(str))) {
          return str.replace(/^"/, '').replace(/"$/, ''); // Just strip outer quotes
        }

        // Standard Single/Multi Choice Cleaning
        str = str.replace(/^(?:Option[:\s]*|Answer[:\s]*|The answer is[:\s]*)/i, '');
        str = str.replace(/[\.\)]$/, '');

        if (/^\d+$/.test(str)) {
          const num = parseInt(str, 10);
          if (num >= 1 && num <= 26) {
            return String.fromCharCode(64 + num);
          }
        }
        return str.toUpperCase();
      };

      const getChoiceKey = (colName: string): string | null => {
        const match = colName.match(/^(?:choice[ _]?)?([a-z0-9])$/i);
        if (!match) return null;
        let key = match[1].toUpperCase();
        if (/^\d$/.test(key)) {
          const num = parseInt(key, 10);
          if (num >= 1 && num <= 26) {
            return String.fromCharCode(64 + num);
          }
        }
        return key;
      };

      for (const source of sources) {
        let tempDb: Database | null = null;
        try {
          tempDb = new SQL.Database(source.bytes);
          const result = tempDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'");
          if (result.length > 0) {
            const tables = result[0].values.map(v => v[0] as string);
            let bestTable = tables[0];
            let maxScore = -1;
            for (const table of tables) {
              try {
                const colsResult = tempDb.exec(`PRAGMA table_info("${table}")`);
                const cols = colsResult[0].values.map(v => v[1] as string);
                let score = 0;
                if (cols.some(c => /Question/i.test(c))) score += 5;
                if (cols.some(c => /Answer/i.test(c))) score += 2;
                if (score > maxScore) { maxScore = score; bestTable = table; }
              } catch (e) { }
            }

            const colsResult = tempDb.exec(`PRAGMA table_info("${bestTable}")`);
            const cols = colsResult[0].values.map(v => v[1] as string);

            const findCol = (possibilities: string[]): string | undefined => {
              const cleanCols = cols.map(c => c.toLowerCase().trim());
              for (const p of possibilities) {
                const idx = cleanCols.indexOf(p.toLowerCase().trim());
                if (idx !== -1) return cols[idx];
              }
              return undefined;
            };

            const normalize = (str: any): string => (str === null || str === undefined) ? "" : String(str).trim();

            const qTextCol = findCol(['Question Text', 'QuestionText', 'Question', 'text', 'body', 'content']) || 'question_text';
            const refCol = findCol(['Source', 'Y', 'RefID', 'ReferenceID', 'Code', 'Label', 'QID', 'ID']);
            const ansCol = findCol(['CorrectAnswer(s)', 'CorrectAnswer', 'Correct Answer', 'Answer', 'Key', 'Ans']) || 'correct_answer';
            const expCol = findCol(['Explanation']) || 'explanation';
            const domCol = findCol(['Domain', 'Domains']);
            const subDomCol = findCol(['Sub-Domain', 'Sub Domain', 'Sub_Domain', 'SubDomain']);
            const topCol = findCol(['Topic Area', 'TopicArea', 'Topic']);
            const chapCol = findCol(['Chapter', 'Module']);
            const headCol = findCol(['Heading']);
            const idCol = findCol(['ID', 'id', 'pk']) || 'id';

            const dataRes = tempDb.exec(`SELECT * FROM "${bestTable}"`);
            if (dataRes.length > 0) {
              const rows = dataRes[0].values;
              const colMap: Record<string, number> = {};
              cols.forEach((c, i) => colMap[c] = i);

              masterDb.run("BEGIN TRANSACTION");
              const insertStmt = masterDb.prepare(`
                INSERT INTO questions (
                  id, source_file, question_text, refId, correct_answer, choices_json, 
                  explanation, domain, sub_domain, topic, chapter, heading, 
                  hint_1, hint_2, hint_3
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);

              for (const row of rows) {
                const rowData = (name?: string) => name && colMap[name] !== undefined ? row[colMap[name]] : null;
                const qText = normalize(rowData(qTextCol));
                const refId = normalize(rowData(refCol));

                if (!qText && !refId) continue;

                let choices: Record<string, string> = {};
                cols.forEach(colName => {
                  const key = getChoiceKey(colName);
                  if (key) {
                    const val = normalize(row[colMap[colName]]);
                    if (val) choices[key] = val;
                  }
                });
                if (!qText && Object.keys(choices).length === 0) {
                  choices = { 'A': 'Option A', 'B': 'Option B', 'C': 'Option C', 'D': 'Option D' };
                }

                const rawId = normalize(rowData(idCol)) || Math.random().toString(36).substring(2, 11);
                const uniqueId = `${source.id}_${rawId}`;
                const rawAns = rowData(ansCol);
                const cleanedAns = cleanAnswer(rawAns);

                insertStmt.run([
                  uniqueId,
                  source.name || "Unknown Source",
                  qText,
                  refId,
                  cleanedAns,
                  JSON.stringify(choices),
                  normalize(rowData(expCol)) || "No explanation.",
                  normalize(rowData(domCol)),
                  normalize(rowData(subDomCol)),
                  normalize(rowData(topCol)),
                  normalize(rowData(chapCol)),
                  normalize(rowData(headCol)),
                  normalize(rowData('hint_1')),
                  normalize(rowData('hint_2')),
                  normalize(rowData('hint_3'))
                ]);
                totalImported++;
              }
              insertStmt.free();
              masterDb.run("COMMIT");
            }
          }
        } catch (e) {
          console.error("Worker: Source Error", e);
        } finally {
          if (tempDb) tempDb.close();
        }
      }

      const exportBytes = masterDb.export();
      masterDb.close();

      self.postMessage({ type: 'SUCCESS', count: totalImported, bytes: exportBytes } as WorkerResponse);
    } catch (e: any) {
      self.postMessage({ type: 'ERROR', message: e?.message || String(e) } as WorkerResponse);
    }
  }
};
