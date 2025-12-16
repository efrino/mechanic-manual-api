const express = require("express");
const db = require("../config/database");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// Get all Meca Aids
router.get("/", async (req, res, next) => {
  try {
    const { category, difficulty, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT ma.*, mac.name as category_name
      FROM meca_aids ma
      LEFT JOIN meca_aid_categories mac ON ma.category_id = mac.id
      WHERE ma.is_active = true
    `;
    const params = [];

    if (category) {
      query += " AND ma.category_id = ?";
      params.push(category);
    }

    if (difficulty) {
      query += " AND ma.difficulty_level = ?";
      params.push(difficulty);
    }

    if (search) {
      query +=
        " AND (ma.title LIKE ? OR ma.problem_description LIKE ? OR ma.symptoms LIKE ?)";
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    query += " ORDER BY ma.updated_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const [mecaAids] = await db.execute(query, params);

    // Get total count
    let countQuery =
      "SELECT COUNT(*) as total FROM meca_aids WHERE is_active = true";
    const countParams = [];

    if (category) {
      countQuery += " AND category_id = ?";
      countParams.push(category);
    }
    if (difficulty) {
      countQuery += " AND difficulty_level = ?";
      countParams.push(difficulty);
    }

    const [countResult] = await db.execute(countQuery, countParams);

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, metadata) VALUES (?, ?, 'meca_aid_access', ?)`,
      [
        req.user.id,
        req.deviceId,
        JSON.stringify({ action: "list", category, difficulty, search }),
      ]
    );

    res.json({
      success: true,
      data: {
        mecaAids,
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

// Get categories
router.get("/categories", async (req, res, next) => {
  try {
    const [categories] = await db.execute(
      "SELECT * FROM meca_aid_categories WHERE is_active = true ORDER BY sort_order"
    );
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

// Get single Meca Aid with steps
router.get("/:uuid", async (req, res, next) => {
  try {
    const [mecaAids] = await db.execute(
      `
      SELECT ma.*, mac.name as category_name
      FROM meca_aids ma
      LEFT JOIN meca_aid_categories mac ON ma.category_id = mac.id
      WHERE ma.uuid = ? AND ma.is_active = true
    `,
      [req.params.uuid]
    );

    if (mecaAids.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Meca Aid not found" });
    }

    const mecaAid = mecaAids[0];

    // Get steps
    const [steps] = await db.execute(
      "SELECT * FROM meca_aid_steps WHERE meca_aid_id = ? ORDER BY step_number",
      [mecaAid.id]
    );
    mecaAid.steps = steps;

    // Log activity
    await db.execute(
      `INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type) VALUES (?, ?, 'meca_aid_access', ?, 'meca_aid')`,
      [req.user.id, req.deviceId, mecaAid.id]
    );

    res.json({ success: true, data: mecaAid });
  } catch (error) {
    next(error);
  }
});

// Download all Meca Aids for offline (bulk download)
router.get("/download/all", async (req, res, next) => {
  try {
    const { since } = req.query;

    let query = `
      SELECT ma.*, mac.name as category_name
      FROM meca_aids ma
      LEFT JOIN meca_aid_categories mac ON ma.category_id = mac.id
      WHERE ma.is_active = true
    `;
    const params = [];

    if (since) {
      query += " AND ma.updated_at > ?";
      params.push(new Date(since));
    }

    const [mecaAids] = await db.execute(query, params);

    // Get all steps for these meca aids
    if (mecaAids.length > 0) {
      const mecaAidIds = mecaAids.map((m) => m.id);
      const [allSteps] = await db.execute(
        `SELECT * FROM meca_aid_steps WHERE meca_aid_id IN (${mecaAidIds.join(
          ","
        )}) ORDER BY meca_aid_id, step_number`
      );

      // Map steps to meca aids
      mecaAids.forEach((ma) => {
        ma.steps = allSteps.filter((s) => s.meca_aid_id === ma.id);
      });
    }

    // Get categories
    const [categories] = await db.execute(
      "SELECT * FROM meca_aid_categories WHERE is_active = true ORDER BY sort_order"
    );

    res.json({
      success: true,
      data: {
        mecaAids,
        categories,
        downloadedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Create Meca Aid
router.post("/", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      problemDescription,
      symptoms,
      causes,
      solutions,
      toolsRequired,
      difficultyLevel,
      estimatedTime,
      categoryId,
      steps,
    } = req.body;

    const uuid = require("uuid").v4();

    const [result] = await db.execute(
      `
      INSERT INTO meca_aids (uuid, category_id, title, problem_description, symptoms, causes, solutions, tools_required, difficulty_level, estimated_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        uuid,
        categoryId || null,
        title,
        problemDescription,
        symptoms || null,
        causes || null,
        solutions,
        toolsRequired || null,
        difficultyLevel || "medium",
        estimatedTime || null,
      ]
    );

    // Insert steps
    if (steps && steps.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await db.execute(
          `
          INSERT INTO meca_aid_steps (meca_aid_id, step_number, title, instruction, image_url, warning_text, tip_text)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          [
            result.insertId,
            i + 1,
            step.title || null,
            step.instruction,
            step.imageUrl || null,
            step.warningText || null,
            step.tipText || null,
          ]
        );
      }
    }

    res.status(201).json({
      success: true,
      message: "Meca Aid created",
      data: { id: result.insertId, uuid },
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Update Meca Aid
router.put("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    const {
      title,
      problemDescription,
      symptoms,
      causes,
      solutions,
      toolsRequired,
      difficultyLevel,
      estimatedTime,
      categoryId,
      isActive,
    } = req.body;

    await db.execute(
      `
      UPDATE meca_aids SET
        title = COALESCE(?, title),
        problem_description = COALESCE(?, problem_description),
        symptoms = COALESCE(?, symptoms),
        causes = COALESCE(?, causes),
        solutions = COALESCE(?, solutions),
        tools_required = COALESCE(?, tools_required),
        difficulty_level = COALESCE(?, difficulty_level),
        estimated_time = COALESCE(?, estimated_time),
        category_id = COALESCE(?, category_id),
        is_active = COALESCE(?, is_active)
      WHERE uuid = ?
    `,
      [
        title,
        problemDescription,
        symptoms,
        causes,
        solutions,
        toolsRequired,
        difficultyLevel,
        estimatedTime,
        categoryId,
        isActive,
        req.params.uuid,
      ]
    );

    res.json({ success: true, message: "Meca Aid updated" });
  } catch (error) {
    next(error);
  }
});

// Admin: Delete Meca Aid
router.delete("/:uuid", requireRole("admin"), async (req, res, next) => {
  try {
    await db.execute("UPDATE meca_aids SET is_active = false WHERE uuid = ?", [
      req.params.uuid,
    ]);
    res.json({ success: true, message: "Meca Aid deleted" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
