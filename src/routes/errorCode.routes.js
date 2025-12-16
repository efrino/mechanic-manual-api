const express = require("express");
const db = require("../config/database");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// Search error codes (main feature)
router.get("/search", async (req, res, next) => {
  try {
    const { q, category, severity, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    if (!q) {
      return res
        .status(400)
        .json({ success: false, message: "Search query required" });
    }

    let query = `
      SELECT ec.*, ecc.name as category_name, ecc.code_prefix
      FROM error_codes ec
      LEFT JOIN error_code_categories ecc ON ec.category_id = ecc.id
      WHERE ec.is_active = true
      AND (
        ec.code LIKE ? 
        OR MATCH(ec.code, ec.title, ec.description, ec.possible_causes) AGAINST(? IN NATURAL LANGUAGE MODE)
      )
    `;
    const searchTerm = `%${q}%`;
    const params = [searchTerm, q];

    if (category) {
      query += " AND ec.category_id = ?";
      params.push(category);
    }

    if (severity) {
      query += " AND ec.severity = ?";
      params.push(severity);
    }

    query += " ORDER BY ec.search_count DESC, ec.code LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [errorCodes] = await db.execute(query, params);

    // Increment search count for found codes
    if (errorCodes.length > 0) {
      const ids = errorCodes.map((e) => e.id);
      await db.execute(
        `UPDATE error_codes SET search_count = search_count + 1 WHERE id IN (${ids.join(
          ","
        )})`
      );
    }

    // Log search activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, metadata) VALUES (?, ?, 'error_code_search', ?)`,
      [
        req.user.id,
        req.deviceId,
        JSON.stringify({ query: q, resultsCount: errorCodes.length }),
      ]
    );

    res.json({
      success: true,
      data: {
        errorCodes,
        query: q,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get all error codes
router.get("/", async (req, res, next) => {
  try {
    const { category, severity, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT ec.*, ecc.name as category_name, ecc.code_prefix
      FROM error_codes ec
      LEFT JOIN error_code_categories ecc ON ec.category_id = ecc.id
      WHERE ec.is_active = true
    `;
    const params = [];

    if (category) {
      query += " AND ec.category_id = ?";
      params.push(category);
    }

    if (severity) {
      query += " AND ec.severity = ?";
      params.push(severity);
    }

    query += " ORDER BY ec.code LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [errorCodes] = await db.execute(query, params);

    // Get total count
    let countQuery =
      "SELECT COUNT(*) as total FROM error_codes WHERE is_active = true";
    const countParams = [];
    if (category) {
      countQuery += " AND category_id = ?";
      countParams.push(category);
    }
    if (severity) {
      countQuery += " AND severity = ?";
      countParams.push(severity);
    }

    const [countResult] = await db.execute(countQuery, countParams);

    res.json({
      success: true,
      data: {
        errorCodes,
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

// Get error code categories
router.get("/categories", async (req, res, next) => {
  try {
    const [categories] = await db.execute(
      "SELECT * FROM error_code_categories ORDER BY code_prefix"
    );
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

// Get single error code by code
router.get("/code/:code", async (req, res, next) => {
  try {
    const [errorCodes] = await db.execute(
      `
      SELECT ec.*, ecc.name as category_name, ecc.code_prefix, ecc.vehicle_system
      FROM error_codes ec
      LEFT JOIN error_code_categories ecc ON ec.category_id = ecc.id
      WHERE ec.code = ? AND ec.is_active = true
    `,
      [req.params.code.toUpperCase()]
    );

    if (errorCodes.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Error code not found" });
    }

    // Increment search count
    await db.execute(
      "UPDATE error_codes SET search_count = search_count + 1 WHERE code = ?",
      [req.params.code.toUpperCase()]
    );

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type) VALUES (?, ?, 'error_code_search', ?, 'error_code')`,
      [req.user.id, req.deviceId, errorCodes[0].id]
    );

    res.json({ success: true, data: errorCodes[0] });
  } catch (error) {
    next(error);
  }
});

// Get popular error codes
router.get("/popular", async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;

    const [errorCodes] = await db.execute(
      `
      SELECT ec.code, ec.title, ec.severity, ec.search_count, ecc.name as category_name
      FROM error_codes ec
      LEFT JOIN error_code_categories ecc ON ec.category_id = ecc.id
      WHERE ec.is_active = true
      ORDER BY ec.search_count DESC
      LIMIT ?
    `,
      [parseInt(limit)]
    );

    res.json({ success: true, data: errorCodes });
  } catch (error) {
    next(error);
  }
});

// Admin: Create error code
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      code,
      title,
      description,
      possibleCauses,
      symptoms,
      diagnosticSteps,
      repairSolutions,
      severity,
      affectedVehicles,
      categoryId,
    } = req.body;

    const [result] = await db.execute(
      `
      INSERT INTO error_codes (category_id, code, title, description, possible_causes, symptoms, diagnostic_steps, repair_solutions, severity, affected_vehicles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        categoryId || null,
        code.toUpperCase(),
        title,
        description,
        possibleCauses || null,
        symptoms || null,
        diagnosticSteps || null,
        repairSolutions || null,
        severity || "medium",
        affectedVehicles || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Error code created",
      data: { id: result.insertId, code: code.toUpperCase() },
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Update error code
router.put("/:code", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      description,
      possibleCauses,
      symptoms,
      diagnosticSteps,
      repairSolutions,
      severity,
      affectedVehicles,
      categoryId,
      isActive,
    } = req.body;

    await db.execute(
      `
      UPDATE error_codes SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        possible_causes = COALESCE(?, possible_causes),
        symptoms = COALESCE(?, symptoms),
        diagnostic_steps = COALESCE(?, diagnostic_steps),
        repair_solutions = COALESCE(?, repair_solutions),
        severity = COALESCE(?, severity),
        affected_vehicles = COALESCE(?, affected_vehicles),
        category_id = COALESCE(?, category_id),
        is_active = COALESCE(?, is_active)
      WHERE code = ?
    `,
      [
        title,
        description,
        possibleCauses,
        symptoms,
        diagnosticSteps,
        repairSolutions,
        severity,
        affectedVehicles,
        categoryId,
        isActive,
        req.params.code.toUpperCase(),
      ]
    );

    res.json({ success: true, message: "Error code updated" });
  } catch (error) {
    next(error);
  }
});

// Admin: Delete error code
router.delete("/:code", requireRole("admin"), async (req, res, next) => {
  try {
    await db.execute(
      "UPDATE error_codes SET is_active = false WHERE code = ?",
      [req.params.code.toUpperCase()]
    );
    res.json({ success: true, message: "Error code deleted" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
