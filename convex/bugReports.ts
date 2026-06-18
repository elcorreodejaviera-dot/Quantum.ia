import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireAdmin, requireUser } from "./helpers";

// (JAV-81) Reporte de bugs: el botón vive en el Portal de CADA usuario; la gestión, en la pestaña Admin.

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);
const MAX_BYTES = 8 * 1024 * 1024;       // 8 MB por adjunto
const UPLOAD_TTL_MS = 60 * 60 * 1000;    // 1 h para consumir un upload registrado
const MAX_ATTACHMENTS = 4;
const RATE_WINDOW_MS = 60 * 60 * 1000;   // ventana de rate-limit
const RATE_MAX = 10;                      // máx reportes por usuario/hora
const MSG_MIN = 5;
const MSG_MAX = 2000;

// 1) URL de subida (cualquier usuario autenticado).
export const generateBugUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// 2) Registrar el archivo subido PROBANDO su tipo/tamaño contra la metadata de sistema (servidor,
// no se fía del cliente) y asociándolo al usuario. Si no cumple, se borra el blob.
export const registerBugUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const user = await requireUser(ctx);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) throw new Error("Archivo no encontrado");
    const contentType = meta.contentType ?? "";
    if (!ALLOWED_TYPES.has(contentType) || meta.size > MAX_BYTES) {
      await ctx.storage.delete(storageId);   // rechazar tipo/tamaño no permitido
      throw new Error("Adjunto inválido: solo JPG/PNG/PDF hasta 8 MB.");
    }
    await ctx.db.insert("bug_uploads", {
      userId: user._id, storageId, contentType, size: meta.size, createdAt: Date.now(),
    });
    return { ok: true as const };
  },
});

// 3) Crear el reporte. Solo acepta adjuntos registrados por ESTE usuario, no consumidos y dentro de TTL.
export const reportBug = mutation({
  args: {
    message: v.string(),
    url: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    attachments: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, { message, url, userAgent, attachments }) => {
    const user = await requireUser(ctx);
    const msg = message.trim();
    if (msg.length < MSG_MIN || msg.length > MSG_MAX) {
      throw new Error(`El mensaje debe tener entre ${MSG_MIN} y ${MSG_MAX} caracteres.`);
    }
    // Rate-limit: nº de reportes del usuario en la última hora.
    const since = Date.now() - RATE_WINDOW_MS;
    const recent = await ctx.db
      .query("bug_reports")
      .withIndex("by_user_created", (q) => q.eq("userId", user._id).gte("createdAt", since))
      .collect();
    if (recent.length >= RATE_MAX) {
      throw new Error("Demasiados reportes recientes. Inténtalo más tarde.");
    }

    // Validar y CONSUMIR adjuntos (ownership + no consumido + TTL).
    const ids = (attachments ?? []).slice(0, MAX_ATTACHMENTS);
    const now = Date.now();
    const validated: typeof ids = [];
    for (const storageId of ids) {
      // collect() (no .first()): si hubiera filas duplicadas para el mismo storageId (reintentos de
      // registro), elegir una VÁLIDA en vez de descartar por azar la primera.
      const candidates = await ctx.db
        .query("bug_uploads")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .collect();
      const up = candidates.find((c) =>
        c.userId === user._id && c.consumedAt === undefined && (now - c.createdAt) <= UPLOAD_TTL_MS);
      if (!up) continue;   // ajeno, inexistente, ya consumido o expirado → ignorar
      await ctx.db.patch(up._id, { consumedAt: now });
      validated.push(storageId);
    }

    const context = (url || userAgent)
      ? { url: url?.slice(0, 500), userAgent: userAgent?.slice(0, 300) }
      : undefined;
    const id = await ctx.db.insert("bug_reports", {
      userId: user._id, message: msg, status: "new", context,
      attachments: validated, createdAt: now,
    });
    return { ok: true as const, id };
  },
});

// 4) Listado para el Admin (paginado, filtro por estado). Resuelve URLs de adjuntos.
export const listBugReports = query({
  args: { status: v.optional(v.union(v.literal("new"), v.literal("in_review"), v.literal("resolved"))),
          paginationOpts: paginationOptsValidator },
  handler: async (ctx, { status, paginationOpts }) => {
    await requireAdmin(ctx);
    const result = status
      ? await ctx.db.query("bug_reports")
          .withIndex("by_status_created", (q) => q.eq("status", status))
          .order("desc").paginate(paginationOpts)
      : await ctx.db.query("bug_reports")
          .withIndex("by_created").order("desc").paginate(paginationOpts);
    const page = [];
    for (const b of result.page) {
      const u = await ctx.db.get(b.userId);
      const atts = [];
      for (const sid of b.attachments) {
        atts.push({ storageId: sid, url: await ctx.storage.getUrl(sid) });
      }
      page.push({
        id: b._id, message: b.message, status: b.status, context: b.context ?? null,
        adminNote: b.adminNote ?? null, createdAt: b.createdAt, resolvedAt: b.resolvedAt ?? null,
        userEmail: u?.email ?? null, userName: u?.name ?? null,
        attachments: atts,
      });
    }
    return { ...result, page };
  },
});

// 5) Contadores por estado (badge "N nuevos").
export const countBugReportsByStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // (JAV-85 #9) Acotado por COUNT_CAP (como el resto de queries admin); el badge muestra "N" o "N+" si
    // se alcanza el tope. Evita el .collect() ilimitado (la tabla "resolved" crece sin fin).
    const COUNT_CAP = 1000;
    const counts: Record<string, number> = { new: 0, in_review: 0, resolved: 0 };
    const capped: Record<string, boolean> = {};
    for (const status of ["new", "in_review", "resolved"] as const) {
      const rows = await ctx.db
        .query("bug_reports")
        .withIndex("by_status_created", (q) => q.eq("status", status))
        .take(COUNT_CAP);
      counts[status] = rows.length;
      capped[status] = rows.length === COUNT_CAP;
    }
    return { ...counts, capped };
  },
});

// 6) Cambiar estado (Admin).
export const setBugStatus = mutation({
  args: {
    id: v.id("bug_reports"),
    status: v.union(v.literal("new"), v.literal("in_review"), v.literal("resolved")),
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, adminNote }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Reporte no encontrado");
    const patch: Record<string, unknown> = { status };
    if (adminNote !== undefined) patch.adminNote = adminNote.slice(0, 1000);
    // (JAV-85 #10b) Preservar histórico: fijar resolvedAt solo al resolver por 1ª vez; NO borrarlo al
    // reabrir (in_review/new) ni pisarlo al re-resolver.
    if (status === "resolved" && existing.resolvedAt == null) patch.resolvedAt = Date.now();
    await ctx.db.patch(id, patch);
    return { ok: true as const };
  },
});
