const express = require("express");
const db = require("../config/database");

const router = express.Router();

// Full sync - get all data updates since last sync
router.get("/full", async (req, res, next) => {
  try {
    const { lastSync } = req.query;
    const sinceDate = lastSync ? new Date(lastSync) : new Date(0);

    // Get updated modules
    const [modules] = await db.execute(
      `
      SELECT m.*, mc.name as category_name
      FROM modules m
      LEFT JOIN module_categories mc ON m.category_id = mc.id
      WHERE m.is_active = true AND m.updated_at > ?
    `,
      [sinceDate]
    );

    // Get updated meca aids
    const [mecaAids] = await db.execute(
      `
      SELECT ma.*, mac.name as category_name
      FROM meca_aids ma
      LEFT JOIN meca_aid_categories mac ON ma.category_id = mac.id
      WHERE ma.is_active = true AND ma.updated_at > ?
    `,
      [sinceDate]
    );

    // Get meca aid steps for updated meca aids
    if (mecaAids.length > 0) {
      const mecaAidIds = mecaAids.map((m) => m.id);
      const [steps] = await db.execute(
        `SELECT * FROM meca_aid_steps WHERE meca_aid_id IN (${mecaAidIds.join(
          ","
        )}) ORDER BY meca_aid_id, step_number`
      );
      mecaAids.forEach((ma) => {
        ma.steps = steps.filter((s) => s.meca_aid_id === ma.id);
      });
    }

    // Get categories
    const [moduleCategories] = await db.execute(
      "SELECT * FROM module_categories WHERE is_active = true ORDER BY sort_order"
    );
    const [mecaAidCategories] = await db.execute(
      "SELECT * FROM meca_aid_categories WHERE is_active = true ORDER BY sort_order"
    );

    // Get app settings
    const [settings] = await db.execute("SELECT * FROM app_settings");
    const settingsObj = {};
    settings.forEach((s) => {
      settingsObj[s.setting_key] = s.setting_value;
    });

    // Log sync
    await db.execute(
      `
      INSERT INTO sync_logs (user_id, device_id, sync_type, items_synced)
      VALUES (?, ?, 'full', ?)
    `,
      [req.user.id, req.deviceId, modules.length + mecaAids.length]
    );

    res.json({
      success: true,
      data: {
        modules,
        mecaAids,
        moduleCategories,
        mecaAidCategories,
        settings: settingsObj,
        syncedAt: new Date().toISOString(),
        nextSyncRecommended: new Date(
          Date.now() + 60 * 60 * 1000
        ).toISOString(), // 1 hour
      },
    });
  } catch (error) {
    next(error);
  }
});

// Check for updates (lightweight)
router.get("/check", async (req, res, next) => {
  try {
    const { lastSync } = req.query;

    if (!lastSync) {
      return res.json({
        success: true,
        data: {
          hasUpdates: true,
          message: "Initial sync required",
        },
      });
    }

    const sinceDate = new Date(lastSync);

    // Count updates
    const [[modulesCount]] = await db.execute(
      "SELECT COUNT(*) as count FROM modules WHERE is_active = true AND updated_at > ?",
      [sinceDate]
    );
    const [[mecaAidsCount]] = await db.execute(
      "SELECT COUNT(*) as count FROM meca_aids WHERE is_active = true AND updated_at > ?",
      [sinceDate]
    );

    const hasUpdates = modulesCount.count > 0 || mecaAidsCount.count > 0;

    res.json({
      success: true,
      data: {
        hasUpdates,
        updates: {
          modules: modulesCount.count,
          mecaAids: mecaAidsCount.count,
        },
        serverTime: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get user's downloaded modules status
router.get("/downloads", async (req, res, next) => {
  try {
    const [downloads] = await db.execute(
      `
      SELECT dm.*, m.uuid, m.title, m.version as current_version,
             CASE WHEN dm.downloaded_version < m.version THEN true ELSE false END as needs_update
      FROM downloaded_modules dm
      JOIN modules m ON dm.module_id = m.id
      WHERE dm.user_id = ? AND dm.device_id = ?
    `,
      [req.user.id, req.deviceId || "unknown"]
    );

    res.json({ success: true, data: downloads });
  } catch (error) {
    next(error);
  }
});

// Sync offline activities (when user comes back online)
router.post("/activities", async (req, res, next) => {
  try {
    const { activities } = req.body;

    if (!activities || !Array.isArray(activities)) {
      return res
        .status(400)
        .json({ success: false, message: "Activities array required" });
    }

    let synced = 0;
    for (const activity of activities) {
      try {
        await db.execute(
          `
          INSERT INTO user_activities (user_id, device_id, activity_type, reference_id, reference_type, metadata, duration_seconds, ip_address, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            req.user.id,
            req.deviceId || activity.deviceId,
            activity.activityType,
            activity.referenceId || null,
            activity.referenceType || null,
            activity.metadata ? JSON.stringify(activity.metadata) : null,
            activity.durationSeconds || null,
            req.ip,
            activity.timestamp ? new Date(activity.timestamp) : new Date(),
          ]
        );
        synced++;
      } catch (e) {
        console.error("Failed to sync activity:", e);
      }
    }

    res.json({
      success: true,
      message: `${synced} of ${activities.length} activities synced`,
    });
  } catch (error) {
    next(error);
  }
});

// Get last sync info
router.get("/status", async (req, res, next) => {
  try {
    const [logs] = await db.execute(
      `
      SELECT * FROM sync_logs 
      WHERE user_id = ? AND device_id = ?
      ORDER BY last_sync_at DESC
      LIMIT 1
    `,
      [req.user.id, req.deviceId || "unknown"]
    );

    const lastSync = logs.length > 0 ? logs[0] : null;

    res.json({
      success: true,
      data: {
        lastSync,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
