import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { canAccessObject, getObjectAclPolicy, ObjectPermission } from "../lib/objectAcl";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * Requires admin or supervisor authentication.
 * Only image uploads are permitted (max 5 MB).
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post(
  "/storage/uploads/request-url",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole("global_admin", "admin", "supervisor"),
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    const { name, size, contentType } = parsed.data;

    if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
      res.status(400).json({ error: "Only image uploads are permitted (jpeg, png, gif, webp, avif, svg)" });
      return;
    }

    if (size > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: "File size exceeds the 5 MB limit" });
      return;
    }

    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * POST /storage/uploads/publish
 *
 * Mark an uploaded object as publicly readable.
 * Must be called after the client completes the GCS presigned PUT upload.
 * Requires the same auth as request-url (admin/supervisor).
 */
router.post(
  "/storage/uploads/publish",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole("global_admin", "admin", "supervisor"),
  async (req: Request, res: Response) => {
    const { objectPath } = req.body as { objectPath?: string };
    if (!objectPath || typeof objectPath !== "string" || !objectPath.startsWith("/objects/")) {
      res.status(400).json({ error: "Invalid objectPath" });
      return;
    }

    try {
      await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
        owner: "admin",
        visibility: "public",
      });
      res.json({ ok: true });
    } catch (error) {
      req.log.warn({ err: error }, "Could not set public ACL on uploaded object");
      res.json({ ok: false });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve private object entities.
 * Objects marked visibility:"public" via /storage/uploads/publish are served
 * to anyone (no auth required). All other objects require authenticated access.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const aclPolicy = await getObjectAclPolicy(objectFile);
    const isPublic = aclPolicy?.visibility === "public";

    if (!isPublic) {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const canAccess = await canAccessObject({
        userId: undefined,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canAccess) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
