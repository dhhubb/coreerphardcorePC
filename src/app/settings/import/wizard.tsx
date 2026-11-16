'use client';

import { getToken } from '@/core/session';
import { useCallback, useMemo, useState } from 'react';
import Papa from 'papaparse';
import {
  IMPORT_FIELDS,
  IMPORT_KINDS,
  suggestMapping,
  validateMapping,
  type ColumnMapping,
  type ImportKind,
} from '@/verticals/import/mapping';
import { chunkRows } from '@/verticals/import/csv';

/**
 * The migration wizard (/settings/import).
 *
 * The whole file is parsed in the browser with PapaParse, so the shop sees a preview and maps the
 * Pastel columns before anything is uploaded. The parsed rows are then sent to the branch in
 * chunks. Nothing here talks to the database; every step goes through a thin route handler, and the
 * bearer token is the cashier's (never the service role key).
 */

interface StagedRow {
  row_id: string;
  row_no: number;
  status: 'pending' | 'valid' | 'invalid' | 'skipped' | 'committed';
  data: Record<string, string>;
  errors: Array<{ field: string; message: string }>;
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

type Step = 'file' | 'map' | 'review' | 'done';

export default function ImportWizard() {
  const [kind, setKind] = useState<ImportKind>('products');
  const [step, setStep] = useState<Step>('file');
  const [sourceName, setSourceName] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedRow[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; journal_id: string | null } | null>(null);

  const mappingErrors = useMemo(() => validateMapping(kind, mapping), [kind, mapping]);

  const onFile = useCallback(
    (file: File) => {
      setError(null);
      setSourceName(file.name);
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (parsed) => {
          const parsedHeaders = parsed.meta.fields ?? [];
          setHeaders(parsedHeaders);
          setRows(parsed.data);
          setMapping(suggestMapping(kind, parsedHeaders));
          setStep('map');
        },
        error: (parseError) => setError(`could not read the file: ${parseError.message}`),
      });
    },
    [kind],
  );

  const onSaveMapping = useCallback(async () => {
    try {
      await fetch('/api/import/mappings', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ kind, mapping }),
      });
      setError(null);
    } catch {
      setError('the branch did not answer');
    }
  }, [kind, mapping]);

  const loadRows = useCallback(async (id: string) => {
    const response = await fetch(`/api/import/jobs/${id}/rows?limit=100`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`could not load rows (${response.status})`);
    const payload = (await response.json()) as { rows: StagedRow[] };
    setStaged(payload.rows);
  }, []);

  const onStart = useCallback(async () => {
    setError(null);
    try {
      // The rows are already mapped to our fields here; the branch just stages them. They travel in
      // chunks so a 5,000-row file is not one giant request.
      const mapped = rows.map((row) => {
        const out: Record<string, string> = {};
        for (const [source, target] of Object.entries(mapping)) {
          if (target && row[source]) out[target] = row[source]!.trim();
        }
        return out;
      });
      const chunks = chunkRows(mapped);

      setProgress(`staging 0 / ${mapped.length}`);
      const first = await postJson<{ job_id: string }>('/api/import/jobs', {
        kind,
        source_name: sourceName,
        mapping,
        rows: chunks[0] ?? [],
      });
      setJobId(first.job_id);

      let sent = chunks[0]?.length ?? 0;
      for (let i = 1; i < chunks.length; i += 1) {
        await postJson(`/api/import/jobs/${first.job_id}/chunks`, {
          start_row_no: sent + 1,
          rows: chunks[i],
        });
        sent += chunks[i]!.length;
        setProgress(`staging ${sent} / ${mapped.length}`);
      }

      setProgress('validating…');
      await postJson(`/api/import/jobs/${first.job_id}/validate`, {});
      await loadRows(first.job_id);
      setProgress(null);
      setStep('review');
    } catch (startError) {
      setProgress(null);
      setError((startError as Error).message);
    }
  }, [kind, loadRows, mapping, rows, sourceName]);

  const onFixRow = useCallback(
    async (rowId: string, data: Record<string, string>) => {
      if (!jobId) return;
      try {
        await fetch(`/api/import/rows/${rowId}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ data }),
        });
        await postJson(`/api/import/jobs/${jobId}/validate`, {});
        await loadRows(jobId);
        setError(null);
      } catch (fixError) {
        setError((fixError as Error).message);
      }
    },
    [jobId, loadRows],
  );

  const onCommit = useCallback(async () => {
    if (!jobId) return;
    try {
      setProgress('committing…');
      const committed = await postJson<{
        created: number;
        updated: number;
        skipped: number;
        journal_id: string | null;
      }>(`/api/import/jobs/${jobId}/commit`, {});
      setResult(committed);
      setProgress(null);
      setStep('done');
    } catch (commitError) {
      setProgress(null);
      setError((commitError as Error).message);
    }
  }, [jobId]);

  const invalidCount = staged.filter((row) => row.status === 'invalid').length;

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 960 }}>
      <h1>Import from Pastel</h1>
      {error && <p data-testid="import-error" style={{ color: '#b00' }}>{error}</p>}
      {progress && <p data-testid="import-progress">{progress}</p>}

      {step === 'file' && (
        <section data-testid="import-step-file">
          <label>
            What are you importing?{' '}
            <select
              data-testid="import-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as ImportKind)}
            >
              {IMPORT_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <p>Export the file from Pastel as CSV, then choose it here. It stays on this machine until you start.</p>
          <input
            data-testid="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
            }}
          />
        </section>
      )}

      {step === 'map' && (
        <section data-testid="import-step-map">
          <h2>Map the columns</h2>
          <p>{sourceName}: {rows.length} rows, {headers.length} columns.</p>
          <table data-testid="import-mapping">
            <thead>
              <tr>
                <th>Pastel column</th>
                <th>Our field</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((header) => (
                <tr key={header}>
                  <td>{header}</td>
                  <td>
                    <select
                      data-testid={`import-map-${header}`}
                      value={mapping[header] ?? ''}
                      onChange={(event) =>
                        setMapping((current) => ({ ...current, [header]: event.target.value }))
                      }
                    >
                      <option value="">— ignore —</option>
                      {IMPORT_FIELDS[kind].map((spec) => (
                        <option key={spec.field} value={spec.field}>
                          {spec.label}
                          {spec.required ? ' *' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{rows[0]?.[header] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Preview</h3>
          <table data-testid="import-preview">
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((row, index) => (
                <tr key={index}>
                  {headers.map((header) => (
                    <td key={header}>{row[header] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {mappingErrors.length > 0 && (
            <ul data-testid="import-mapping-errors" style={{ color: '#b00' }}>
              {mappingErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}

          <p>
            <button type="button" onClick={() => void onSaveMapping()} data-testid="import-save-mapping">
              Save this mapping
            </button>{' '}
            <button
              type="button"
              disabled={mappingErrors.length > 0}
              onClick={() => void onStart()}
              data-testid="import-start"
            >
              Start import
            </button>
          </p>
        </section>
      )}

      {step === 'review' && (
        <section data-testid="import-step-review">
          <h2>Check the rows</h2>
          <p data-testid="import-row-summary">
            {staged.length} rows staged, {invalidCount} need fixing.
          </p>
          <table data-testid="import-rows">
            <thead>
              <tr>
                <th>Line</th>
                <th>Status</th>
                <th>Problems</th>
                <th>Fix</th>
              </tr>
            </thead>
            <tbody>
              {staged.map((row) => (
                <tr key={row.row_id} data-testid="import-row">
                  <td>{row.row_no}</td>
                  <td data-testid="import-row-status">{row.status}</td>
                  <td>
                    {row.errors.length === 0
                      ? '—'
                      : row.errors.map((problem) => `${problem.field}: ${problem.message}`).join('; ')}
                  </td>
                  <td>
                    {row.status === 'invalid' && (
                      <button
                        type="button"
                        data-testid={`import-fix-${row.row_no}`}
                        onClick={() =>
                          void onFixRow(row.row_id, {
                            ...row.data,
                            name: row.data.name || 'Imported item',
                            qty: row.data.qty || '0',
                          })
                        }
                      >
                        Fill blanks
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <button
              type="button"
              disabled={invalidCount > 0}
              onClick={() => void onCommit()}
              data-testid="import-commit"
            >
              Import these rows
            </button>
          </p>
        </section>
      )}

      {step === 'done' && result && (
        <section data-testid="import-step-done">
          <h2>Done</h2>
          <p data-testid="import-result">
            {result.created} new, {result.updated} updated, {result.skipped} skipped.
            {result.journal_id ? ` Opening stock posted (journal ${result.journal_id}).` : ''}
          </p>
        </section>
      )}
    </main>
  );
}
