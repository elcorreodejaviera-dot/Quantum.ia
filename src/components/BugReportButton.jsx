import React from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';

// (JAV-81) Botón flotante de reporte de bug — vive en el Portal de CADA usuario. Sube capturas
// (JPG/PNG/PDF) a Convex storage, las registra (ownership) y crea el reporte.

const ACCEPT = 'image/png,image/jpeg,application/pdf';
const MAX_BYTES = 8 * 1024 * 1024;

export default function BugReportButton() {
  const [open, setOpen] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [files, setFiles] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [done, setDone] = React.useState(false);

  const genUrl = useMutation(api.bugReports.generateBugUploadUrl);
  const register = useMutation(api.bugReports.registerBugUpload);
  const report = useMutation(api.bugReports.reportBug);

  function pick(e) {
    const fs = Array.from(e.target.files || []).slice(0, 4);
    const allowed = new Set(ACCEPT.split(','));
    if (fs.some((f) => !allowed.has(f.type))) { setErr('Solo se permiten JPG, PNG o PDF.'); return; }
    if (fs.some((f) => f.size > MAX_BYTES)) { setErr('Cada archivo debe pesar ≤ 8 MB.'); return; }
    setErr(''); setFiles(fs);
  }

  async function submit() {
    if (msg.trim().length < 5) { setErr('Describe el problema (mín. 5 caracteres).'); return; }
    setBusy(true); setErr('');
    try {
      const storageIds = [];
      for (const f of files) {
        const url = await genUrl({});
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
        if (!res.ok) throw new Error('Fallo al subir la captura');
        const { storageId } = await res.json();
        await register({ storageId });
        storageIds.push(storageId);
      }
      await report({
        message: msg.trim(),
        url: typeof location !== 'undefined' ? location.pathname : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        attachments: storageIds,
      });
      setDone(true); setMsg(''); setFiles([]);
      setTimeout(() => { setOpen(false); setDone(false); }, 1400);
    } catch (e) {
      setErr(e?.message ?? 'Error al enviar el reporte');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="bugfab" onClick={() => setOpen(true)}>🐛 Reportar bug</button>
      {open && (
        <div className="bug-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <div className="bug-modal">
            {done ? (
              <p style={{ margin: '12px 0', color: 'var(--green)', fontWeight: 600 }}>✓ ¡Gracias! Reporte enviado.</p>
            ) : (<>
              <h3>Reportar un problema</h3>
              <p>Cuéntanos qué pasó. Lo revisamos y mejoramos el portal.</p>
              <textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000}
                placeholder="Describe el bug: qué hacías, qué esperabas y qué pasó…" />
              <div className="bug-attach">
                <label className="bug-attbtn">📎 Adjuntar captura
                  <input type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={pick} />
                </label>
                {files.length > 0 && <span className="bug-chip">🖼️ {files[0].name}{files.length > 1 ? ` +${files.length - 1}` : ''}</span>}
                <span className="faint" style={{ fontSize: 11 }}>JPG · PNG · PDF · máx 8 MB</span>
              </div>
              {err && <p style={{ color: 'var(--red)', fontSize: 12, margin: '6px 0 0' }}>{err}</p>}
              <div className="bug-actions">
                <button className="bug-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
                <button className="bug-primary" disabled={busy} onClick={submit}>{busy ? 'Enviando…' : 'Enviar reporte'}</button>
              </div>
            </>)}
          </div>
        </div>
      )}
      <style>{`
        .bugfab{position:fixed;right:22px;bottom:22px;z-index:40;background:var(--green);color:#04210a;border:none;
          padding:12px 18px;border-radius:999px;font-weight:800;font-size:13px;cursor:pointer;font-family:var(--font);
          box-shadow:0 8px 24px rgba(0,200,5,.30)}
        .bugfab:hover{filter:brightness(1.06)}
        .bug-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50}
        .bug-modal{background:var(--panel);border:1px solid var(--line);border-radius:16px;width:440px;max-width:92vw;padding:20px;color:var(--text);font-family:var(--font)}
        .bug-modal h3{margin:0 0 4px;font-size:16px}.bug-modal p{margin:0 0 14px;color:var(--faint);font-size:12px}
        .bug-modal textarea{width:100%;height:96px;background:var(--panel-2);border:1px solid var(--line);color:var(--text);
          border-radius:10px;padding:10px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box}
        .bug-attach{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
        .bug-attbtn{display:inline-flex;align-items:center;gap:7px;background:var(--panel-2);color:var(--text);
          border:1px dashed var(--line);border-radius:9px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer}
        .bug-attbtn:hover{border-color:var(--green);color:var(--green)}
        .bug-chip{display:inline-flex;gap:6px;background:rgba(0,200,5,.12);color:var(--green);border-radius:7px;padding:4px 9px;font-size:11px}
        .bug-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
        .bug-primary{background:var(--green);color:#04210a;border:none;padding:9px 16px;border-radius:9px;font-weight:700;cursor:pointer}
        .bug-ghost{background:transparent;color:var(--muted);border:1px solid var(--line);padding:9px 16px;border-radius:9px;cursor:pointer}
        .bug-primary:disabled,.bug-ghost:disabled{opacity:.5;cursor:not-allowed}
        .faint{color:var(--faint)}
      `}</style>
    </>
  );
}
