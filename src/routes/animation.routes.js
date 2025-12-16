const express = require("express");
const db = require("../config/database");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// Get all animations
router.get("/", async (req, res, next) => {
  try {
    const { type, category, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM learning_animations WHERE is_active = true";
    const params = [];

    if (type) {
      query += " AND animation_type = ?";
      params.push(type);
    }

    if (category) {
      query += " AND category = ?";
      params.push(category);
    }

    if (search) {
      query += " AND (title LIKE ? OR description LIKE ?)";
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }

    query += " ORDER BY view_count DESC, created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [animations] = await db.execute(query, params);

    // Get total count
    let countQuery =
      "SELECT COUNT(*) as total FROM learning_animations WHERE is_active = true";
    const countParams = [];
    if (type) {
      countQuery += " AND animation_type = ?";
      countParams.push(type);
    }
    if (category) {
      countQuery += " AND category = ?";
      countParams.push(category);
    }

    const [countResult] = await db.execute(countQuery, countParams);

    res.json({
      success: true,
      data: {
        animations,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countResult[0].total,
          totalPages: Math.ceil(countResult[0].total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get animation categories
router.get("/categories", async (req, res, next) => {
  try {
    const [categories] = await db.execute(
      "SELECT DISTINCT category FROM learning_animations WHERE is_active = true AND category IS NOT NULL ORDER BY category"
    );
    res.json({ success: true, data: categories.map((c) => c.category) });
  } catch (error) {
    next(error);
  }
});

// Get single animation
router.get("/:uuid", async (req, res, next) => {
  try {
    const [animations] = await db.execute(
      "SELECT * FROM learning_animations WHERE uuid = ? AND is_active = true",
      [req.params.uuid]
    );

    if (animations.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Animation not found" });
    }

    // Increment view count
    await db.execute(
      "UPDATE learning_animations SET view_count = view_count + 1 WHERE uuid = ?",
      [req.params.uuid]
    );

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type) VALUES (?, ?, 'animation_view', ?, 'animation')`,
      [req.user.id, req.deviceId, animations[0].id]
    );

    res.json({ success: true, data: animations[0] });
  } catch (error) {
    next(error);
  }
});

// Admin: Create animation
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      description,
      animationType,
      fileUrl,
      thumbnailUrl,
      durationSeconds,
      category,
      tags,
    } = req.body;
    const uuid = require("uuid").v4();

    const [result] = await db.execute(
      `
      INSERT INTO learning_animations (uuid, title, description, animation_type, file_url, thumbnail_url, duration_seconds, category, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        uuid,
        title,
        description || null,
        animationType || "2d",
        fileUrl,
        thumbnailUrl || null,
        durationSeconds || null,
        category || null,
        JSON.stringify(tags || []),
      ]
    );

    res.status(201).json({
      success: true,
      message: "Animation created",
      data: { id: result.insertId, uuid },
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Update animation
router.put("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      description,
      animationType,
      fileUrl,
      thumbnailUrl,
      durationSeconds,
      category,
      tags,
      isActive,
    } = req.body;

    await db.execute(
      `
      UPDATE learning_animations SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        animation_type = COALESCE(?, animation_type),
        file_url = COALESCE(?, file_url),
        thumbnail_url = COALESCE(?, thumbnail_url),
        duration_seconds = COALESCE(?, duration_seconds),
        category = COALESCE(?, category),
        tags = COALESCE(?, tags),
        is_active = COALESCE(?, is_active)
      WHERE uuid = ?
    `,
      [
        title,
        description,
        animationType,
        fileUrl,
        thumbnailUrl,
        durationSeconds,
        category,
        tags ? JSON.stringify(tags) : null,
        isActive,
        req.params.uuid,
      ]
    );

    res.json({ success: true, message: "Animation updated" });
  } catch (error) {
    next(error);
  }
});

// Admin: Delete animation
router.delete("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    await db.execute(
      "UPDATE learning_animations SET is_active = false WHERE uuid = ?",
      [req.params.uuid]
    );
    res.json({ success: true, message: "Animation deleted" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
