'use client';

import { getToken } from '@/core/session';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import {
  IMPORT_FIELDS,
  IMPORT_KINDS,
  mappingStorageKey,
  suggestMapping,
  validateMapping,
  type ColumnMapping,
  type ImportKind,
} from '@/verticals/import/mapping';
import { chunkRows, IMPORT_CHUNK_SIZE } from '@/verticals/import/csv';

/**
 * The migration wizard (/settings/import).
 *
 * The whole file is parsed in the browser with PapaParse, so the shop sees a preview and maps the
 * Pastel columns before anything is uploaded. The parsed rows are then sent to the branch in
 * chunks. Nothing here talks to the database; every step goes through a thin route handler, and the
 * bearer token is the cashier's (never the service role key).
 *
 * F8 completes the brief's UI: the three tabs, the drag-and-drop drop zone, the 20-row preview, the
 * mapping cached in localStorage as well as in `import_mappings`, and the per-row inline edit that
 * revalidates one row through POST /api/import/revalidate.
 */

const PREVIEW_ROWS = 20;

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
  const response = await fetch(path, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

type Step = 'file' | 'map' | 'review' | 'done';

const KIND_LABELS: Record<ImportKind, string> = {
  products: 'Products',
  customers: 'Customers',
  opening_stock: 'Opening Stock',
};

export default function ImportWizard() {
  const [kind, setKind] = useState<ImportKind>('products');
  const [step, setStep] = useState<Step>('file');
  const [sourceName, setSourceName] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedRow[]>([]);
  const [editing, setEditing] = useState<{ rowId: string; data: Record<string, string> } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    skipped: number;
    journal_id: string | null;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const mappingErrors = useMemo(() => validateMapping(kind, mapping), [kind, mapping]);

  // Load the shop's cached mapping for the selected tab: localStorage first (instant, works
  // offline), then the saved table row (authoritative, survives a different browser).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cached = window.localStorage.getItem(mappingStorageKey(kind));
    if (cached) {
      try {
        setMapping(JSON.parse(cached) as ColumnMapping);
      } catch {
        /* ignore a corrupt cache */
      }
    }
    void fetch(`/api/import/mappings?kind=${kind}`, { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { mapping?: ColumnMapping } | null) => {
        if (payload?.mapping && Object.keys(payload.mapping).length > 0) {
          setMapping(payload.mapping);
        }
      })
      .catch(() => undefined);
  }, [kind]);

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
          setMapping((current) =>
            Object.keys(current).length > 0 ? current : suggestMapping(kind, parsedHeaders),
          );
          setStep('map');
        },
        error: (parseError) => setError(`could not read the file: ${parseError.message}`),
      });
    },
    [kind],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  const onSaveMapping = useCallback(async () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(mappingStorageKey(kind), JSON.stringify(mapping));
    }
    try {
      await fetch('/api/import/mappings', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ kind, mapping }),
      });
      setError(null);
    } catch {
      setError('the branch did not answer; the mapping is still saved on this device');
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
      const chunks = chunkRows(mapped, IMPORT_CHUNK_SIZE);

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
        await postJson('/api/import/chunk', {
          job_id: first.job_id,
          start_row_no: sent + 1,
          rows: chunks[i],
        });
        sent += chunks[i]!.length;
        setProgress(`staging ${sent} / ${mapped.length}`);
      }

      setProgress('validating…');
      await postJson('/api/import/revalidate', { job_id: first.job_id });
      await loadRows(first.job_id);
      setProgress(null);
      setStep('review');
    } catch (startError) {
      setProgress(null);
      setError((startError as Error).message);
    }
  }, [kind, loadRows, mapping, rows, sourceName]);

  const onSaveRow = useCallback(async () => {
    if (!jobId || !editing) return;
    try {
      await postJson('/api/import/revalidate', {
        job_id: jobId,
        row_id: editing.rowId,
        data: editing.data,
      });
      await loadRows(jobId);
      setEditing(null);
      setError(null);
    } catch (fixError) {
      setError((fixError as Error).message);
    }
  }, [editing, jobId, loadRows]);

  const onCommit = useCallback(async () => {
    if (!jobId) return;
    try {
      setProgress('committing…');
      const committed = await postJson<{
        created: number;
        updated: number;
        skipped: number;
        journal_id: string | null;
      }>('/api/import/commit', { job_id: jobId });
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

      <nav data-testid="import-tabs" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {IMPORT_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`import-tab-${option}`}
            aria-pressed={kind === option}
            onClick={() => {
              setKind(option);
              setStep('file');
              setHeaders([]);
              setRows([]);
              setStaged([]);
              setJobId(null);
              setError(null);
            }}
            style={{
              padding: '6px 12px',
              fontWeight: kind === option ? 700 : 400,
              borderBottom: kind === option ? '2px solid #333' : '2px solid transparent',
            }}
          >
            {KIND_LABELS[option]}
          </button>
        ))}
      </nav>

      {error && (
        <p data-testid="import-error" style={{ color: '#b00' }}>
          {error}
        </p>
      )}
      {progress && <p data-testid="import-progress">{progress}</p>}

      {step === 'file' && (
        <section data-testid="import-step-file">
          <p>
            Export the file from Pastel as CSV, then drop it here. It stays on this machine until you
            start.
          </p>
          <div
            data-testid="import-dropzone"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragging ? '#333' : '#bbb'}`,
              borderRadius: 8,
              padding: 24,
              textAlign: 'center',
              background: dragging ? '#f6f6f6' : 'transparent',
            }}
          >
            <p>Drag and drop a CSV here, or</p>
            <button type="button" onClick={() => fileInput.current?.click()}>
              choose a file
            </button>
            <input
              ref={fileInput}
              data-testid="import-file"
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onFile(file);
              }}
            />
          </div>
        </section>
      )}

      {step === 'map' && (
        <section data-testid="import-step-map">
          <h2>Map the columns</h2>
          <p>
            {sourceName}: {rows.length} rows, {headers.length} columns.
          </p>
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

          <h3>
            Preview (first {Math.min(PREVIEW_ROWS, rows.length)} of {rows.length} rows)
          </h3>
          <table data-testid="import-preview">
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PREVIEW_ROWS).map((row, index) => (
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
            <button
              type="button"
              onClick={() => void onSaveMapping()}
              data-testid="import-save-mapping"
            >
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
                      : row.errors
                          .map((problem) => `${problem.field}: ${problem.message}`)
                          .join('; ')}
                  </td>
                  <td>
                    <button
                      type="button"
                      data-testid={`import-edit-${row.row_no}`}
                      onClick={() =>
                        setEditing({
                          rowId: row.row_id,
                          data: Object.fromEntries(
                            IMPORT_FIELDS[kind].map((spec) => [
                              spec.field,
                              row.data[spec.field] ?? '',
                            ]),
                          ),
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {editing && (
            <section
              data-testid="import-edit-panel"
              style={{ border: '1px solid #ccc', padding: 12, marginTop: 12 }}
            >
              <h3>Fix row</h3>
              {IMPORT_FIELDS[kind].map((spec) => (
                <label key={spec.field} style={{ display: 'block', marginBottom: 6 }}>
                  {spec.label}
                  {spec.required ? ' *' : ''}{' '}
                  <input
                    data-testid={`import-edit-field-${spec.field}`}
                    value={editing.data[spec.field] ?? ''}
                    onChange={(event) =>
                      setEditing((current) =>
                        current
                          ? { ...current, data: { ...current.data, [spec.field]: event.target.value } }
                          : current,
                      )
                    }
                  />
                </label>
              ))}
              <button type="button" onClick={() => void onSaveRow()} data-testid="import-edit-save">
                Save and revalidate
              </button>{' '}
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </section>
          )}

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
