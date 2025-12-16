const express = require("express");
const db = require("../config/database");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// Get all modules (for online sync)
router.get("/", async (req, res, next) => {
  try {
    const { category, since, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT m.*, mc.name as category_name 
      FROM modules m
      LEFT JOIN module_categories mc ON m.category_id = mc.id
      WHERE m.is_active = true
    `;
    const params = [];

    if (category) {
      query += " AND m.category_id = ?";
      params.push(category);
    }

    // Get modules updated since last sync
    if (since) {
      query += " AND m.updated_at > ?";
      params.push(new Date(since));
    }

    query += " ORDER BY m.priority DESC, m.updated_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [modules] = await db.execute(query, params);

    // Get total count
    let countQuery =
      "SELECT COUNT(*) as total FROM modules WHERE is_active = true";
    const countParams = [];

    if (category) {
      countQuery += " AND category_id = ?";
      countParams.push(category);
    }
    if (since) {
      countQuery += " AND updated_at > ?";
      countParams.push(new Date(since));
    }

    const [countResult] = await db.execute(countQuery, countParams);
    const total = countResult[0].total;

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, metadata) VALUES (?, ?, 'module_view', ?)`,
      [
        req.user.id,
        req.deviceId,
        JSON.stringify({ action: "list", category, page }),
      ]
    );

    res.json({
      success: true,
      data: {
        modules,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get categories
router.get("/categories", async (req, res, next) => {
  try {
    const [categories] = await db.execute(
      "SELECT * FROM module_categories WHERE is_active = true ORDER BY sort_order"
    );
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

// Get single module
router.get("/:uuid", async (req, res, next) => {
  try {
    const [modules] = await db.execute(
      `
      SELECT m.*, mc.name as category_name
      FROM modules m
      LEFT JOIN module_categories mc ON m.category_id = mc.id
      WHERE m.uuid = ? AND m.is_active = true
    `,
      [req.params.uuid]
    );

    if (modules.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Module not found" });
    }

    const module = modules[0];

    // Get attachments
    const [attachments] = await db.execute(
      "SELECT * FROM module_attachments WHERE module_id = ?",
      [module.id]
    );
    module.attachments = attachments;

    // Log view activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type) VALUES (?, ?, 'module_view', ?, 'module')`,
      [req.user.id, req.deviceId, module.id]
    );

    res.json({ success: true, data: module });
  } catch (error) {
    next(error);
  }
});

// Download module for offline use
router.post("/:uuid/download", async (req, res, next) => {
  try {
    const [modules] = await db.execute(
      "SELECT * FROM modules WHERE uuid = ? AND is_active = true AND is_downloadable = true",
      [req.params.uuid]
    );

    if (modules.length === 0) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Module not found or not downloadable",
        });
    }

    const module = modules[0];

    // Record download
    await db.execute(
      `
      INSERT INTO downloaded_modules (user_id, module_id, device_id, downloaded_version)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        downloaded_version = VALUES(downloaded_version),
        downloaded_at = NOW()
    `,
      [req.user.id, module.id, req.deviceId || "unknown", module.version]
    );

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type) VALUES (?, ?, 'module_download', ?, 'module')`,
      [req.user.id, req.deviceId, module.id]
    );

    // Get attachments for download
    const [attachments] = await db.execute(
      "SELECT * FROM module_attachments WHERE module_id = ?",
      [module.id]
    );

    res.json({
      success: true,
      message: "Module marked for download",
      data: {
        module,
        attachments,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get updates since last sync (hybrid feature)
router.get("/sync/updates", async (req, res, next) => {
  try {
    const { lastSync } = req.query;

    let query = `
      SELECT m.uuid, m.version, m.title, m.updated_at,
             CASE WHEN dm.id IS NOT NULL THEN true ELSE false END as is_downloaded
      FROM modules m
      LEFT JOIN downloaded_modules dm ON m.id = dm.module_id 
        AND dm.user_id = ? AND dm.device_id = ?
      WHERE m.is_active = true
    `;
    const params = [req.user.id, req.deviceId || "unknown"];

    if (lastSync) {
      query += " AND m.updated_at > ?";
      params.push(new Date(lastSync));
    }

    query += " ORDER BY m.updated_at DESC";

    const [updates] = await db.execute(query, params);

    // Check which modules need update
    const modulesNeedingUpdate = updates.filter((m) => {
      if (!m.is_downloaded) return true;
      return false; // Will be handled client-side by comparing versions
    });

    res.json({
      success: true,
      data: {
        serverTime: new Date().toISOString(),
        updates: modulesNeedingUpdate,
        totalUpdates: modulesNeedingUpdate.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Mark module as completed
router.post("/:uuid/complete", async (req, res, next) => {
  try {
    const { duration } = req.body;

    const [modules] = await db.execute(
      "SELECT id FROM modules WHERE uuid = ?",
      [req.params.uuid]
    );

    if (modules.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Module not found" });
    }

    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type, duration_seconds) 
       VALUES (?, ?, 'module_complete', ?, 'module', ?)`,
      [req.user.id, req.deviceId, modules[0].id, duration || null]
    );

    res.json({ success: true, message: "Module completion recorded" });
  } catch (error) {
    next(error);
  }
});

// Admin: Create module
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      description,
      content,
      categoryId,
      thumbnailUrl,
      isDownloadable,
      priority,
    } = req.body;
    const uuid = require("uuid").v4();

    const [result] = await db.execute(
      `
      INSERT INTO modules (uuid, category_id, title, description, content, thumbnail_url, is_downloadable, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        uuid,
        categoryId || null,
        title,
        description || null,
        content,
        thumbnailUrl || null,
        isDownloadable !== false,
        priority || 0,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Module created",
      data: { id: result.insertId, uuid },
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Update module
router.put("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      description,
      content,
      categoryId,
      thumbnailUrl,
      isDownloadable,
      priority,
      isActive,
    } = req.body;

    // Increment version on update
    await db.execute(
      `
      UPDATE modules SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        content = COALESCE(?, content),
        category_id = COALESCE(?, category_id),
        thumbnail_url = COALESCE(?, thumbnail_url),
        is_downloadable = COALESCE(?, is_downloadable),
        priority = COALESCE(?, priority),
        is_active = COALESCE(?, is_active),
        version = version + 1
      WHERE uuid = ?
    `,
      [
        title,
        description,
        content,
        categoryId,
        thumbnailUrl,
        isDownloadable,
        priority,
        isActive,
        req.params.uuid,
      ]
    );

    res.json({ success: true, message: "Module updated" });
  } catch (error) {
    next(error);
  }
});

// Admin: Delete module
router.delete("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    await db.execute("UPDATE modules SET is_active = false WHERE uuid = ?", [
      req.params.uuid,
    ]);
    res.json({ success: true, message: "Module deleted" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
